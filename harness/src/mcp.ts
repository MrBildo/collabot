import fs from 'node:fs';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { buildTaskContext } from './context.js';
import type { AgentPool } from './pool.js';
import { recordDispatch } from './task.js';
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

  /** Track a new dispatch. */
  track(agentId: string, entry: Omit<TrackedDispatch, 'promise'> & { promise: Promise<DispatchResult> }): void {
    this.pending.set(agentId, entry);
  }

  /** Wait for a tracked dispatch to complete. */
  async await(agentId: string): Promise<DispatchResult> {
    const entry = this.pending.get(agentId);
    if (!entry) {
      throw new Error(`No tracked dispatch for agent "${agentId}"`);
    }
    return entry.promise;
  }

  /** Get metadata for a tracked dispatch. */
  get(agentId: string): TrackedDispatch | undefined {
    return this.pending.get(agentId);
  }

  /** Check if an agent ID is being tracked. */
  has(agentId: string): boolean {
    return this.pending.has(agentId);
  }

  /** Remove a specific entry (after await or kill). */
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
  options?: { taskSlug?: string; taskDir?: string },
) => Promise<DispatchResult>;

// ============================================================
// Server options
// ============================================================

export type HarnessServerOptions = {
  pool: AgentPool;
  tasksDir: string;
  roles: Map<string, RoleDefinition>;
  tools: 'full' | 'readonly';
  // Required for lifecycle tools (full mode):
  tracker?: DispatchTracker;
  draftFn?: DraftAgentFn;
  // Task-scoped context — child agents automatically inherit the parent task
  parentTaskSlug?: string;
  parentTaskDir?: string;
};

// ============================================================
// Server factory
// ============================================================

/**
 * Create an MCP server that exposes harness primitives to dispatched agents.
 *
 * `tools: 'readonly'` — list_agents, list_tasks, get_task_context
 * `tools: 'full'` — adds draft_agent, await_agent, kill_agent
 */
export function createHarnessServer(options: HarnessServerOptions): McpSdkServerConfigWithInstance {
  const { pool, tasksDir, roles } = options;

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

    tool('list_tasks', 'List all tasks in the task inventory', {},
      async () => {
        const tasks = listTasks(tasksDir);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ tasks }) }],
        };
      },
    ),

    tool('get_task_context', 'Get reconstructed context for a task (history of prior dispatches)', { taskSlug: z.string() },
      async ({ taskSlug }) => {
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
  const { pool, tasksDir, roles, tracker, draftFn } = options;

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

        const agentId = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        // Inherit parent task context — child agents automatically land in the same task
        const resolvedSlug = taskSlug ?? options.parentTaskSlug ?? `mcp-task-${Date.now()}`;
        let taskDir: string | undefined = options.parentTaskDir;

        // If explicit slug was passed, try to resolve its task dir
        if (taskSlug) {
          const candidate = path.join(tasksDir, taskSlug);
          if (fs.existsSync(path.join(candidate, 'task.json'))) {
            taskDir = candidate;
          }
        }

        // Fire off the dispatch — do NOT await
        const promise = draftFn(role, prompt, {
          taskSlug: resolvedSlug,
          taskDir,
        });

        tracker.track(agentId, {
          promise,
          role,
          startedAt: new Date(),
          taskDir,
          cwd: roleDefn.cwd,
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

          // Record child dispatch in task.json so it shows up in context reconstruction
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
        // Try pool first (pool.kill aborts the controller)
        const agentInPool = pool.list().find((a) => a.id === agentId);
        if (agentInPool) {
          pool.kill(agentId);
          tracker.delete(agentId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: true, message: `Agent "${agentId}" killed` }) }],
          };
        }

        // Agent not in pool — might have already completed or never existed
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

// ============================================================
// Helpers
// ============================================================

/** Read task directories and return summary for each. */
function listTasks(tasksDir: string): Array<{ slug: string; created: string; description: string; dispatchCount: number }> {
  if (!fs.existsSync(tasksDir)) return [];

  const entries = fs.readdirSync(tasksDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  const tasks: Array<{ slug: string; created: string; description: string; dispatchCount: number }> = [];

  for (const entry of entries) {
    const manifestPath = path.join(tasksDir, entry.name, 'task.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as TaskManifest;
      tasks.push({
        slug: manifest.slug,
        created: manifest.created,
        description: manifest.description,
        dispatchCount: manifest.dispatches.length,
      });
    } catch {
      // Skip corrupt manifests
    }
  }

  return tasks;
}
