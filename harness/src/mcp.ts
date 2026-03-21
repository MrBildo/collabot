import fs from 'node:fs';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { buildTaskContext } from './context.js';
import { getProjectTasksDir } from './project.js';
import type { Project } from './project.js';
import type { AgentPool } from './pool.js';
import { listTasks } from './task.js';
import { logger } from './logger.js';
import type { CollabDispatchResult, RoleDefinition } from './types.js';

// ============================================================
// DispatchTracker — maps agent IDs to in-flight dispatch promises
// ============================================================

export type TrackedDispatch = {
  promise: Promise<CollabDispatchResult>;
  role: string;
  startedAt: Date;
  taskDir?: string;
  cwd?: string;
};

export class DispatchTracker {
  private pending = new Map<string, TrackedDispatch>();

  track(agentId: string, entry: Omit<TrackedDispatch, 'promise'> & { promise: Promise<CollabDispatchResult> }): void {
    this.pending.set(agentId, entry);
  }

  async await(agentId: string): Promise<CollabDispatchResult> {
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
  options?: { taskSlug?: string; taskDir?: string; cwd?: string; parentDispatchId?: string },
) => Promise<CollabDispatchResult>;

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
  parentDispatchId?: string;
};

// ============================================================
// Server factory
// ============================================================

export function createHarnessServer(options: HarnessServerOptions): McpSdkServerConfigWithInstance {
  const { pool, projects, projectsDir, roles } = options;

  const readonlyTools = [
    tool('list_agents', 'List currently active agents in the pool. Returns an array of agent objects with id, role, taskSlug, and startedAt fields. Use this to check what agents are running before drafting new ones.', {},
      async () => {
        const agents = pool.list().map((a) => ({
          id: a.id,
          role: a.role,
          botId: a.botId ?? null,
          botName: a.botName ?? null,
          taskSlug: a.taskSlug ?? null,
          startedAt: a.startedAt.toISOString(),
        }));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ agents }) }],
        };
      },
    ),

    tool('list_tasks', 'List tasks for the current project. Returns task manifests (slug, name, status, created timestamp) scoped to your parent project. Tasks track dispatches, events, and structured results.', {},
      async () => {
        const resolvedName = options.parentProject;
        if (!resolvedName) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No parent project context' }) }],
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

    tool('get_task_context', 'Get reconstructed context for a task. Returns a structured narrative of prior dispatches including roles, prompts, results, and events — useful for understanding what has already been done before continuing work on a task.', {
      taskSlug: z.string(),
    },
      async ({ taskSlug }) => {
        const resolvedName = options.parentProject;
        if (!resolvedName) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No parent project context' }) }],
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

    tool('list_projects', 'Get info about the current project. Returns the project name, description, repository paths, and available roles. Scoped to your parent project context.', {},
      async () => {
        const resolvedName = options.parentProject;
        if (!resolvedName) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ projects: [] }) }],
          };
        }
        const proj = projects.get(resolvedName.toLowerCase());
        if (!proj) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ projects: [] }) }],
          };
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ projects: [{
            name: proj.name,
            description: proj.description,
            paths: proj.paths,
            roles: proj.roles,
          }] }) }],
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
    tool('draft_agent', 'Dispatch a new agent asynchronously. Returns an agentId immediately (non-blocking). The agent runs in the background — use await_agent with the returned agentId to block until it completes and get its result. Supports cross-project dispatch via the optional project parameter.', {
      role: z.string(),
      prompt: z.string(),
      taskSlug: z.string().optional(),
      project: z.string().optional().describe('Target project (cross-project dispatch). Defaults to parent project.'),
    },
      async ({ role, prompt, taskSlug, project: targetProject }) => {
        // Validate role exists
        const roleDefn = roles.get(role);
        if (!roleDefn) {
          const available = [...roles.keys()].join(', ');
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown role "${role}". Available: ${available}` }) }],
            isError: true,
          };
        }

        // Resolve project — explicit target or inherit from parent
        const resolvedProject = targetProject ?? options.parentProject;
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

        // For cross-project dispatch, use target project's task dir
        const isCrossProject = targetProject && targetProject.toLowerCase() !== (options.parentProject ?? '').toLowerCase();
        let resolvedSlug = taskSlug ?? options.parentTaskSlug ?? `mcp-task-${Date.now()}`;
        let taskDir: string | undefined = isCrossProject ? undefined : options.parentTaskDir;

        // Resolve task dir from the target project
        const tasksDir = getProjectTasksDir(projectsDir, proj.name);
        if (taskSlug) {
          const candidate = path.join(tasksDir, taskSlug);
          if (fs.existsSync(path.join(candidate, 'task.json'))) {
            taskDir = candidate;
          }
        } else if (isCrossProject) {
          // Cross-project with no explicit task — create one in the target project
          try {
            const { createTask } = await import('./task.js');
            const newTask = createTask(tasksDir, {
              name: `cross-dispatch-${Date.now()}`,
              project: proj.name,
              description: `Cross-project dispatch from ${options.parentProject}`,
            });
            resolvedSlug = newTask.slug;
            taskDir = newTask.taskDir;
          } catch (err) {
            logger.warn({ err, project: proj.name }, 'failed to create cross-project task');
          }
        }

        // Resolve CWD from project paths
        const cwd = proj.paths[0]!;

        // Fire off the dispatch — do NOT await
        const promise = draftFn(role, prompt, {
          taskSlug: resolvedSlug,
          taskDir,
          cwd,
          parentDispatchId: options.parentDispatchId,
        });

        tracker.track(agentId, {
          promise,
          role,
          startedAt: new Date(),
          taskDir,
          cwd,
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ agentId, role, taskSlug: resolvedSlug, project: proj.name }) }],
        };
      },
    ),

    tool('await_agent', 'Block until a previously drafted agent completes and return its structured result. Returns status (success/failed/aborted), result summary, cost, and duration. The agentId comes from a prior draft_agent call.', {
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
          tracker.delete(agentId);

          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              status: result.status,
              result: result.structuredResult ?? (result.result ? { summary: result.result } : undefined),
              cost: result.cost.totalUsd,
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

    tool('kill_agent', 'Abort a running agent immediately. Removes it from the pool and tracker. Use this to cancel agents that are stuck, taking too long, or no longer needed.', {
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
