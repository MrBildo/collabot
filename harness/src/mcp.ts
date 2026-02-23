import fs from 'node:fs';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { buildTaskContext } from './context.js';
import { getProjectTasksDir } from './project.js';
import type { Project } from './project.js';
import type { AgentPool } from './pool.js';
import { recordDispatch, listTasks } from './task.js';
import type { TaskManifest } from './task.js';
import { logger } from './logger.js';
import type { DispatchResult, RoleDefinition } from './types.js';

// ============================================================
// DispatchTracker — maps agent IDs to in-flight dispatch promises
// ============================================================

export type TrackedDispatch = {
  promise: Promise<DispatchResult>;
  role: string;
  startedAt: Date;
  taskDir?: string;
  cwd?: string;
};

export class DispatchTracker {
  private pending = new Map<string, TrackedDispatch>();

  track(agentId: string, entry: Omit<TrackedDispatch, 'promise'> & { promise: Promise<DispatchResult> }): void {
    this.pending.set(agentId, entry);
  }

  async await(agentId: string): Promise<DispatchResult> {
    const entry = this.pending.get(agentId);
    if (!entry) {
      throw new Error(`No tracked dispatch for agent "${agentId}"`);
    }
    return entry.promise;
  }

  get(agentId: string): TrackedDispatch | undefined {
    return this.pending.get(agentId);
  }

  has(agentId: string): boolean {
    return this.pending.has(agentId);
  }

  delete(agentId: string): void {
    this.pending.delete(agentId);
  }
}

// ============================================================
// Draft function type — injected to avoid circular dependency with core.ts
// ============================================================

export type DraftAgentFn = (
  roleName: string,
  taskContext: string,
  options?: { taskSlug?: string; taskDir?: string; cwd?: string },
) => Promise<DispatchResult>;

// ============================================================
// Server options
// ============================================================

export type HarnessServerOptions = {
  pool: AgentPool;
  projects: Map<string, Project>;
  projectsDir: string;
  roles: Map<string, RoleDefinition>;
  tools: 'full' | 'readonly';
  // Required for lifecycle tools (full mode):
  tracker?: DispatchTracker;
  draftFn?: DraftAgentFn;
  // Task-scoped context — child agents automatically inherit the parent task
  parentTaskSlug?: string;
  parentTaskDir?: string;
  parentProject?: string;
};

// ============================================================
// Server factory
// ============================================================

export function createHarnessServer(options: HarnessServerOptions): McpSdkServerConfigWithInstance {
  const { pool, projects, projectsDir, roles } = options;

  const readonlyTools = [
    tool('list_agents', 'List currently active agents in the pool', {},
      async () => {
        const agents = pool.list().map((a) => ({
          id: a.id,
          role: a.role,
          taskSlug: a.taskSlug ?? null,
          startedAt: a.startedAt.toISOString(),
        }));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ agents }) }],
        };
      },
    ),

    tool('list_tasks', 'List tasks for a project', {
      project: z.string().optional().describe('Project name. If omitted, uses parent project.'),
    },
      async ({ project: projectName }) => {
        const resolvedName = projectName ?? options.parentProject;
        if (!resolvedName) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Project name required (no parent project context)' }) }],
            isError: true,
          };
        }
        const proj = projects.get(resolvedName.toLowerCase());
        if (!proj) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `Project "${resolvedName}" not found` }) }],
            isError: true,
          };
        }
        const tasksDir = getProjectTasksDir(projectsDir, proj.name);
        const tasks = listTasks(tasksDir);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ tasks }) }],
        };
      },
    ),

    tool('get_task_context', 'Get reconstructed context for a task (history of prior dispatches)', {
      taskSlug: z.string(),
      project: z.string().optional().describe('Project name. If omitted, uses parent project.'),
    },
      async ({ taskSlug, project: projectName }) => {
        const resolvedName = projectName ?? options.parentProject;
        if (!resolvedName) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Project name required' }) }],
            isError: true,
          };
        }
        const proj = projects.get(resolvedName.toLowerCase());
        if (!proj) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `Project "${resolvedName}" not found` }) }],
            isError: true,
          };
        }
        const tasksDir = getProjectTasksDir(projectsDir, proj.name);
        const taskDir = path.join(tasksDir, taskSlug);
        const manifestPath = path.join(taskDir, 'task.json');
        if (!fs.existsSync(manifestPath)) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `Task "${taskSlug}" not found` }) }],
            isError: true,
          };
        }
        const context = buildTaskContext(taskDir);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ context }) }],
        };
      },
    ),

    tool('list_projects', 'List all registered projects', {},
      async () => {
        const projectList = [...projects.values()].map((p) => ({
          name: p.name,
          description: p.description,
          paths: p.paths,
          roles: p.roles,
        }));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ projects: projectList }) }],
        };
      },
    ),
  ];

  const lifecycleTools = options.tools === 'full' ? buildLifecycleTools(options) : [];

  return createSdkMcpServer({
    name: 'harness',
    version: '1.0.0',
    tools: [...readonlyTools, ...lifecycleTools],
  });
}

// ============================================================
// Lifecycle tools (draft, await, kill)
// ============================================================

function buildLifecycleTools(options: HarnessServerOptions) {
  const { pool, projects, projectsDir, roles, tracker, draftFn } = options;

  if (!tracker || !draftFn) {
    throw new Error('Full MCP server requires tracker and draftFn');
  }

  return [
    tool('draft_agent', 'Dispatch a new agent asynchronously. Returns an agent ID immediately — use await_agent to wait for results.', {
      role: z.string(),
      prompt: z.string(),
      taskSlug: z.string().optional(),
    },
      async ({ role, prompt, taskSlug }) => {
        // Validate role exists
        const roleDefn = roles.get(role);
        if (!roleDefn) {
          const available = [...roles.keys()].join(', ');
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown role "${role}". Available: ${available}` }) }],
            isError: true,
          };
        }

        // Inherit project from parent
        const resolvedProject = options.parentProject;
        if (!resolvedProject) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No parent project context — cannot draft agent' }) }],
            isError: true,
          };
        }

        const proj = projects.get(resolvedProject.toLowerCase());
        if (!proj) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `Project "${resolvedProject}" not found` }) }],
            isError: true,
          };
        }

        // Validate role is available for this project
        if (!proj.roles.includes(role)) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `Role "${role}" not available for project "${proj.name}". Available: ${proj.roles.join(', ')}` }) }],
            isError: true,
          };
        }

        const agentId = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        // Inherit parent task context
        const resolvedSlug = taskSlug ?? options.parentTaskSlug ?? `mcp-task-${Date.now()}`;
        let taskDir: string | undefined = options.parentTaskDir;

        // If explicit slug was passed, try to resolve its task dir
        if (taskSlug) {
          const tasksDir = getProjectTasksDir(projectsDir, proj.name);
          const candidate = path.join(tasksDir, taskSlug);
          if (fs.existsSync(path.join(candidate, 'task.json'))) {
            taskDir = candidate;
          }
        }

        // Resolve CWD from project paths
        const cwd = proj.paths[0]!;

        // Fire off the dispatch — do NOT await
        const promise = draftFn(role, prompt, {
          taskSlug: resolvedSlug,
          taskDir,
          cwd,
        });

        tracker.track(agentId, {
          promise,
          role,
          startedAt: new Date(),
          taskDir,
          cwd,
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ agentId, role, taskSlug: resolvedSlug }) }],
        };
      },
    ),

    tool('await_agent', 'Block until a previously drafted agent completes and return its result.', {
      agentId: z.string(),
    },
      async ({ agentId }) => {
        const tracked = tracker.get(agentId);
        if (!tracked) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `No tracked agent with ID "${agentId}"` }) }],
            isError: true,
          };
        }

        try {
          const result = await tracker.await(agentId);

          // Record child dispatch in task.json
          if (tracked.taskDir) {
            try {
              const dispatchResult = result.structuredResult
                ? {
                    summary: result.structuredResult.summary,
                    changes: result.structuredResult.changes,
                    issues: result.structuredResult.issues,
                    questions: result.structuredResult.questions,
                  }
                : (result.result ? { summary: result.result } : undefined);

              recordDispatch(tracked.taskDir, {
                role: tracked.role,
                cwd: tracked.cwd ?? 'unknown',
                model: result.model ?? 'unknown',
                startedAt: tracked.startedAt.toISOString(),
                completedAt: new Date().toISOString(),
                status: result.status,
                journalFile: result.journalFile ?? `${tracked.role}.md`,
                result: dispatchResult,
              });
            } catch (err) {
              logger.error({ err, agentId }, 'failed to record child dispatch in task manifest');
            }
          }

          tracker.delete(agentId);

          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              status: result.status,
              result: result.structuredResult ?? (result.result ? { summary: result.result } : undefined),
              cost: result.cost,
              duration_ms: result.duration_ms,
            }) }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
            isError: true,
          };
        }
      },
    ),

    tool('kill_agent', 'Abort a running agent.', {
      agentId: z.string(),
    },
      async ({ agentId }) => {
        const agentInPool = pool.list().find((a) => a.id === agentId);
        if (agentInPool) {
          pool.kill(agentId);
          tracker.delete(agentId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: true, message: `Agent "${agentId}" killed` }) }],
          };
        }

        if (tracker.has(agentId)) {
          tracker.delete(agentId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: true, message: `Agent "${agentId}" removed from tracker (may have already completed)` }) }],
          };
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, message: `No agent with ID "${agentId}" found` }) }],
        };
      },
    ),
  ];
}
