import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { LoggingLevel, ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import { buildTaskContext } from './context.js';
import { getProjectTasksDir } from './project.js';
import type { Project } from './project.js';
import type { AgentPool } from './pool.js';
import { listTasks } from './task.js';
import { logger } from './logger.js';
import type { CollabDispatchResult, RoleDefinition } from './types.js';

// ============================================================
// Content block helpers — reduce dual-audience boilerplate
// ============================================================

export function userContent(text: string) {
  return { type: 'text' as const, text, annotations: { audience: ['user' as const], priority: 0.8 } };
}

export function assistantContent(data: unknown) {
  return { type: 'text' as const, text: JSON.stringify(data), annotations: { audience: ['assistant' as const], priority: 1.0 } };
}

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

  track(agentId: string, entry: TrackedDispatch): void {
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
  options?: { taskSlug?: string; taskDir?: string; cwd?: string; parentDispatchId?: string; project?: string },
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

const HARNESS_INSTRUCTIONS = `Collabot Harness — agent orchestration tools for dispatching and managing AI coding agents.

Workflow:
1. Use list_projects to see the current project's info (name, repos, available roles)
2. Use list_agents to check what agents are currently running
3. Use draft_agent to dispatch work — returns an agentId immediately (non-blocking)
4. Use await_agent with the agentId to block until the agent completes and get its result
5. Use kill_agent to abort agents that are stuck or no longer needed
6. Use list_tasks / get_task_context for prior work history and context reconstruction

Agents are scoped to projects. Each project declares which roles are available. Cross-project dispatch is supported via the project parameter on draft_agent.`;

export function createHarnessServer(options: HarnessServerOptions): McpSdkServerConfigWithInstance {
  const server = new McpServer(
    { name: 'harness', version: '1.0.0' },
    {
      capabilities: { tools: {}, logging: {} },
      instructions: HARNESS_INSTRUCTIONS,
    },
  );

  registerReadonlyTools(server, options);

  if (options.tools === 'full') {
    registerLifecycleTools(server, options);
  }

  return { type: 'sdk' as const, name: 'harness', instance: server };
}

// ============================================================
// MCP server container + selection
// ============================================================

export type McpServers = {
  createFull: (parentTaskSlug: string, parentTaskDir: string, parentProject?: string, parentDispatchId?: string) => McpSdkServerConfigWithInstance;
  readonly: McpSdkServerConfigWithInstance;
  cron?: McpSdkServerConfigWithInstance;
};

export function selectMcpServersForRole(
  role: RoleDefinition,
  mcpServers: McpServers,
  context: { taskSlug: string; taskDir: string; parentProject?: string; parentDispatchId?: string },
): Record<string, McpSdkServerConfigWithInstance> {
  const isFullAccess = role.permissions?.includes('agent-draft') ?? false;

  const selected: Record<string, McpSdkServerConfigWithInstance> = {
    harness: isFullAccess
      ? mcpServers.createFull(context.taskSlug, context.taskDir, context.parentProject, context.parentDispatchId)
      : mcpServers.readonly,
  };

  if (isFullAccess && mcpServers.cron) {
    selected.cron = mcpServers.cron;
  }

  return selected;
}

// ============================================================
// Readonly tools (list_agents, list_tasks, get_task_context, list_projects)
// ============================================================

function registerReadonlyTools(server: McpServer, options: HarnessServerOptions): void {
  const { pool, projects, projectsDir } = options;

  server.registerTool('list_agents', {
    title: 'List Active Agents',
    description: 'List currently active agents in the pool. Returns agent objects with id, role, bot identity, taskSlug, and startedAt. Use this to check what agents are running before drafting new ones or to monitor in-flight work.',
    inputSchema: {},
    outputSchema: {
      agents: z.array(z.unknown()).describe('Array of active agent objects'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const agents = pool.list().map((a) => ({
      id: a.id,
      role: a.role,
      botId: a.botId ?? null,
      botName: a.botName ?? null,
      taskSlug: a.taskSlug ?? null,
      startedAt: a.startedAt.toISOString(),
    }));
    const data = { agents };
    const count = agents.length;
    const userText = count === 0
      ? 'No agents currently running.'
      : `${count} active agent${count > 1 ? 's' : ''}:\n${agents.map(a => `  ${a.id} (${a.role})`).join('\n')}`;
    return {
      content: [userContent(userText), assistantContent(data)],
      structuredContent: data,
    };
  });

  server.registerTool('list_tasks', {
    title: 'List Project Tasks',
    description: 'List tasks for the current project. Returns task manifests (slug, name, status, created timestamp) scoped to your parent project. Tasks track dispatches, events, and structured results across multiple agent sessions.',
    inputSchema: {},
    outputSchema: {
      tasks: z.array(z.unknown()).describe('Array of task manifest objects'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const resolvedName = options.parentProject;
    if (!resolvedName) {
      return {
        content: [{ type: 'text' as const, text: 'No parent project context' }],
        isError: true,
      };
    }
    const proj = projects.get(resolvedName.toLowerCase());
    if (!proj) {
      return {
        content: [{ type: 'text' as const, text: `Project "${resolvedName}" not found` }],
        isError: true,
      };
    }
    const tasksDir = getProjectTasksDir(projectsDir, proj.name);
    const tasks = listTasks(tasksDir);
    const data = { tasks };
    const count = tasks.length;
    const userText = count === 0
      ? `No tasks for project "${proj.name}".`
      : `${count} task${count > 1 ? 's' : ''} for "${proj.name}":\n${tasks.map((t: { slug: string; status: string }) => `  ${t.slug} (${t.status})`).join('\n')}`;
    return {
      content: [userContent(userText), assistantContent(data)],
      structuredContent: data,
    };
  });

  server.registerTool('get_task_context', {
    title: 'Get Task Context',
    description: 'Get reconstructed context for a task. Returns a structured narrative of prior dispatches including roles, prompts, results, and events — useful for understanding what has already been done before continuing work on a task.',
    inputSchema: {
      taskSlug: z.string().describe('Task slug identifier (e.g., "fix-auth-bug")'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ taskSlug }) => {
    const resolvedName = options.parentProject;
    if (!resolvedName) {
      return {
        content: [{ type: 'text' as const, text: 'No parent project context' }],
        isError: true,
      };
    }
    const proj = projects.get(resolvedName.toLowerCase());
    if (!proj) {
      return {
        content: [{ type: 'text' as const, text: `Project "${resolvedName}" not found` }],
        isError: true,
      };
    }
    const tasksDir = getProjectTasksDir(projectsDir, proj.name);
    const taskDir = path.join(tasksDir, taskSlug);
    const manifestPath = path.join(taskDir, 'task.json');
    if (!fs.existsSync(manifestPath)) {
      return {
        content: [{ type: 'text' as const, text: `Task "${taskSlug}" not found` }],
        isError: true,
      };
    }
    const context = buildTaskContext(taskDir);
    const data = { context };
    return {
      content: [userContent(`Context for task "${taskSlug}" reconstructed.`), assistantContent(data)],
      structuredContent: data,
    };
  });

  server.registerTool('list_projects', {
    title: 'List Projects',
    description: 'List projects visible to the current agent. Currently returns the parent project\'s info (name, description, repository paths, available roles). Scoped to your parent project context.',
    inputSchema: {},
    outputSchema: {
      projects: z.array(z.unknown()).describe('Array of project info objects'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const resolvedName = options.parentProject;
    if (!resolvedName) {
      const data = { projects: [] };
      return {
        content: [userContent('No parent project context.'), assistantContent(data)],
        structuredContent: data,
      };
    }
    const proj = projects.get(resolvedName.toLowerCase());
    if (!proj) {
      const data = { projects: [] };
      return {
        content: [userContent(`Project "${resolvedName}" not found.`), assistantContent(data)],
        structuredContent: data,
      };
    }
    const projectInfo = {
      name: proj.name,
      description: proj.description,
      paths: proj.paths,
      roles: proj.roles,
    };
    const data = { projects: [projectInfo] };
    return {
      content: [userContent(`Project: ${proj.name} — ${proj.description}\nRoles: ${proj.roles.join(', ')}`), assistantContent(data)],
      structuredContent: data,
    };
  });
}

// ============================================================
// Lifecycle tools (draft, await, kill)
// ============================================================

// MCP-level logging helper — sends a log notification to the calling agent.
// Safe to call even if the transport doesn't support notifications (silently fails).
function mcpLog(extra: { sendNotification: (n: ServerNotification) => Promise<void> }, level: LoggingLevel, data: string): void {
  const notification: ServerNotification = { method: 'notifications/message', params: { level, data } };
  extra.sendNotification(notification).catch(() => {});
}

function registerLifecycleTools(server: McpServer, options: HarnessServerOptions): void {
  const { pool, projects, projectsDir, roles, tracker, draftFn } = options;

  if (!tracker || !draftFn) {
    throw new Error('Full MCP server requires tracker and draftFn');
  }

  server.registerTool('draft_agent', {
    title: 'Draft Agent',
    description: 'Dispatch a new agent asynchronously. Returns an agentId immediately (non-blocking). The agent runs in the background — use await_agent with the returned agentId to block until it completes and get its result. Supports cross-project dispatch via the optional project parameter.',
    inputSchema: {
      role: z.string().describe('Role name for the agent (e.g., "api-dev", "product-analyst")'),
      prompt: z.string().describe('Task prompt — the instructions for the dispatched agent'),
      taskSlug: z.string().optional().describe('Task slug to associate the dispatch with (inherits parent task if omitted)'),
      project: z.string().optional().describe('Target project name for cross-project dispatch (defaults to parent project)'),
    },
    outputSchema: {
      agentId: z.string().describe('Unique agent identifier'),
      role: z.string(),
      taskSlug: z.string(),
      project: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ role, prompt, taskSlug, project: targetProject }, extra) => {
    const roleDefn = roles.get(role);
    if (!roleDefn) {
      const available = [...roles.keys()].join(', ');
      return {
        content: [{ type: 'text' as const, text: `Unknown role "${role}". Available: ${available}` }],
        isError: true,
      };
    }

    const resolvedProject = targetProject ?? options.parentProject;
    if (!resolvedProject) {
      return {
        content: [{ type: 'text' as const, text: 'No parent project context — cannot draft agent' }],
        isError: true,
      };
    }

    const proj = projects.get(resolvedProject.toLowerCase());
    if (!proj) {
      return {
        content: [{ type: 'text' as const, text: `Project "${resolvedProject}" not found` }],
        isError: true,
      };
    }

    if (!proj.roles.includes(role)) {
      return {
        content: [{ type: 'text' as const, text: `Role "${role}" not available for project "${proj.name}". Available: ${proj.roles.join(', ')}` }],
        isError: true,
      };
    }

    const agentId = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const isCrossProject = targetProject && targetProject.toLowerCase() !== (options.parentProject ?? '').toLowerCase();
    let resolvedSlug = taskSlug ?? options.parentTaskSlug ?? `mcp-task-${Date.now()}`;
    let taskDir: string | undefined = isCrossProject ? undefined : options.parentTaskDir;

    const tasksDir = getProjectTasksDir(projectsDir, proj.name);
    if (taskSlug) {
      const candidate = path.join(tasksDir, taskSlug);
      if (fs.existsSync(path.join(candidate, 'task.json'))) {
        taskDir = candidate;
      }
    } else if (isCrossProject) {
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

    const cwd = proj.paths[0]!;

    const promise = draftFn(role, prompt, {
      taskSlug: resolvedSlug,
      taskDir,
      cwd,
      parentDispatchId: options.parentDispatchId,
      project: proj.name,
    });

    tracker.track(agentId, {
      promise,
      role,
      startedAt: new Date(),
      taskDir,
      cwd,
    });

    const data = { agentId, role, taskSlug: resolvedSlug, project: proj.name };
    mcpLog(extra, 'info', `Agent dispatched: ${role} on ${proj.name} (${agentId})`);
    return {
      content: [userContent(`Dispatched ${role} agent: ${agentId} (project: ${proj.name})`), assistantContent(data)],
      structuredContent: data,
    };
  });

  server.registerTool('await_agent', {
    title: 'Await Agent Result',
    description: 'Block until a previously drafted agent completes and return its structured result. Returns status (completed/failed/aborted), result summary, cost, and duration. The agentId comes from a prior draft_agent call.',
    inputSchema: {
      agentId: z.string().describe('Agent ID returned by a prior draft_agent call'),
    },
    outputSchema: {
      status: z.string().describe('Completion status'),
      result: z.unknown().optional(),
      cost: z.number().describe('Cost in USD'),
      duration_ms: z.number(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ agentId }, extra) => {
    const tracked = tracker.get(agentId);
    if (!tracked) {
      return {
        content: [{ type: 'text' as const, text: `No tracked agent with ID "${agentId}"` }],
        isError: true,
      };
    }

    // Race the dispatch promise against the abort signal + periodic progress logging
    const PROGRESS_INTERVAL_MS = 30_000;
    const startTime = Date.now();
    const progressTimer = setInterval(() => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      mcpLog(extra, 'info', `Still waiting on agent ${agentId} (elapsed: ${elapsed}s)`);
    }, PROGRESS_INTERVAL_MS);

    let onAbort: (() => void) | undefined;
    try {
      const abortPromise = new Promise<never>((_, reject) => {
        if (extra.signal.aborted) {
          reject(new Error('Cancelled'));
          return;
        }
        onAbort = () => reject(new Error('Cancelled'));
        extra.signal.addEventListener('abort', onAbort, { once: true });
      });

      const result = await Promise.race([tracker.await(agentId), abortPromise]);
      if (onAbort) extra.signal.removeEventListener('abort', onAbort);
      tracker.delete(agentId);

      const data = {
        status: result.status,
        result: result.structuredResult ?? (result.result ? { summary: result.result } : undefined),
        cost: result.cost.totalUsd,
        duration_ms: result.duration_ms,
      };
      const durationSec = (result.duration_ms / 1000).toFixed(1);
      return {
        content: [userContent(`Agent ${agentId} ${result.status} (${durationSec}s, $${result.cost.totalUsd.toFixed(4)})`), assistantContent(data)],
        structuredContent: data,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // On cancellation, kill the child agent
      if (message === 'Cancelled') {
        const agentInPool = pool.list().find((a) => a.id === agentId);
        if (agentInPool) {
          pool.kill(agentId);
        }
        tracker.delete(agentId);
        mcpLog(extra, 'warning', `await_agent cancelled — killed agent ${agentId}`);
      }

      return {
        content: [{ type: 'text' as const, text: message }],
        isError: true,
      };
    } finally {
      clearInterval(progressTimer);
    }
  });

  server.registerTool('kill_agent', {
    title: 'Kill Agent',
    description: 'Abort a running agent immediately. Removes it from the pool and tracker. Use this to cancel agents that are stuck, taking too long, or no longer needed. Safe to call on already-completed agents.',
    inputSchema: {
      agentId: z.string().describe('Agent ID to abort (from a prior draft_agent call)'),
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ agentId }, extra) => {
    const agentInPool = pool.list().find((a) => a.id === agentId);
    if (agentInPool) {
      pool.kill(agentId);
      tracker.delete(agentId);
      mcpLog(extra, 'info', `Killed agent ${agentId}`);
      const data = { success: true, message: `Agent "${agentId}" killed` };
      return {
        content: [userContent(`Killed agent ${agentId}`), assistantContent(data)],
        structuredContent: data,
      };
    }

    if (tracker.has(agentId)) {
      tracker.delete(agentId);
      const data = { success: true, message: `Agent "${agentId}" removed from tracker (may have already completed)` };
      return {
        content: [userContent(`Removed agent ${agentId} from tracker (may have already completed)`), assistantContent(data)],
        structuredContent: data,
      };
    }

    return {
      content: [{ type: 'text' as const, text: `No agent with ID "${agentId}" found` }],
      isError: true,
    };
  });
}
