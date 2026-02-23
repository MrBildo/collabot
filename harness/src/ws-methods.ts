import fs from 'node:fs';
import path from 'node:path';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import type { WsAdapter } from './adapters/ws.js';
import type { CommAdapter, InboundMessage } from './comms.js';
import type { AgentPool } from './pool.js';
import type { Config } from './config.js';
import type { RoleDefinition, DispatchResult, Project } from './types.js';
import type { McpServers } from './core.js';
import { getProject, getProjectTasksDir } from './project.js';
import { buildTaskContext } from './context.js';
import { listTasks, createTask, closeTask, getTask } from './task.js';
import { logger } from './logger.js';
import { getActiveDraft, createDraft, closeDraft, resumeDraft } from './draft.js';

const WS_ERROR_TASK_NOT_FOUND = -32000;
const WS_ERROR_AGENT_NOT_FOUND = -32001;
const WS_ERROR_ROLE_NOT_FOUND = -32002;
const WS_ERROR_DRAFT_ALREADY_ACTIVE = -32004;
const WS_ERROR_NO_ACTIVE_DRAFT = -32005;
const WS_ERROR_PROJECT_NOT_FOUND = -32006;

export type WsMethodDeps = {
  wsAdapter: WsAdapter;
  handleTask: (
    message: InboundMessage,
    adapter: CommAdapter,
    roles: Map<string, RoleDefinition>,
    config: Config,
    pool: AgentPool | undefined,
    mcpServers: McpServers | undefined,
    projects: Map<string, Project>,
    projectsDir: string,
  ) => Promise<DispatchResult>;
  roles: Map<string, RoleDefinition>;
  config: Config;
  pool: AgentPool;
  projects: Map<string, Project>;
  projectsDir: string;
  mcpServers?: McpServers;
};

function resolveProject(deps: WsMethodDeps, projectName: string): Project {
  try {
    return getProject(deps.projects, projectName);
  } catch {
    throw new JSONRPCErrorException(`Project "${projectName}" not found`, WS_ERROR_PROJECT_NOT_FOUND);
  }
}

export function registerWsMethods(deps: WsMethodDeps): void {

  // list_projects — return all loaded projects
  deps.wsAdapter.addMethod('list_projects', (_params: unknown) => {
    const projectList = [...deps.projects.values()].map((p) => ({
      name: p.name,
      description: p.description,
      paths: p.paths,
      roles: p.roles,
    }));
    return { projects: projectList };
  });

  // submit_prompt — routes to draft session if active, otherwise fire-and-forget dispatch
  deps.wsAdapter.addMethod('submit_prompt', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const content = p['content'];
    const role = p['role'] as string | undefined;
    const projectName = p['project'] as string | undefined;
    const taskSlug = p['taskSlug'] as string | undefined;

    if (typeof content !== 'string' || content.trim() === '') {
      throw new JSONRPCErrorException('content is required and must be a non-empty string', -32602);
    }

    // Draft session routing — takes priority over autonomous dispatch
    const draft = getActiveDraft();
    if (draft) {
      const draftRole = deps.roles.get(draft.role);
      // Resolve CWD from the draft's project
      const draftProject = deps.projects.get(draft.project.toLowerCase());
      const draftCwd = draftProject?.paths[0];
      let mcpServer;
      if (deps.mcpServers && draftRole) {
        const isFullAccess = deps.config.mcp.fullAccessCategories.includes(draftRole.category);
        mcpServer = isFullAccess
          ? deps.mcpServers.createFull(draft.taskSlug, draft.taskDir, draft.project)
          : deps.mcpServers.readonly;
      }

      // Fire-and-forget resume
      resumeDraft(content, deps.wsAdapter, deps.roles, deps.config, deps.pool, {
        cwd: draftCwd,
        mcpServer,
        onCompaction: (event) => {
          deps.wsAdapter.broadcastNotification('context_compacted', {
            sessionId: draft.sessionId, ...event,
          });
        },
      })
        .then(() => {
          const updated = getActiveDraft();
          if (updated) {
            deps.wsAdapter.broadcastNotification('draft_status', {
              sessionId: updated.sessionId,
              role: updated.role,
              project: updated.project,
              turnCount: updated.turnCount,
              costUsd: updated.cumulativeCostUsd,
              contextPct: updated.contextWindow > 0
                ? Math.round((updated.lastInputTokens / updated.contextWindow) * 100) : 0,
              lastActivity: updated.lastActivityAt,
            });
          }
        })
        .catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          deps.wsAdapter.broadcastNotification('channel_message', {
            id: `msg-${Date.now()}`,
            channelId: draft.channelId,
            from: 'system',
            timestamp: new Date().toISOString(),
            type: 'error',
            content: `Draft turn failed: ${errMsg}`,
          });
        });

      return { threadId: `draft-${draft.sessionId}`, taskSlug: draft.taskSlug };
    }

    // Autonomous dispatch — requires project
    if (!projectName) {
      throw new JSONRPCErrorException('project is required for autonomous dispatch', -32602);
    }

    const project = resolveProject(deps, projectName);

    if (role !== undefined && !deps.roles.has(role)) {
      throw new JSONRPCErrorException(`Role "${role}" not found`, WS_ERROR_ROLE_NOT_FOUND);
    }

    const threadId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const message: InboundMessage = {
      id: threadId,
      content,
      threadId,
      source: 'ws',
      project: project.name,
      role,
      metadata: { taskSlug },
    };

    deps.handleTask(message, deps.wsAdapter, deps.roles, deps.config, deps.pool, deps.mcpServers, deps.projects, deps.projectsDir)
      .catch((err: unknown) => {
        logger.error({ err }, 'ws submit_prompt: handleTask error');
      });

    return { threadId, taskSlug: taskSlug ?? null };
  });

  // create_task — create a task in a project
  deps.wsAdapter.addMethod('create_task', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const projectName = p['project'] as string | undefined;
    const name = p['name'] as string | undefined;
    const description = p['description'] as string | undefined;

    if (typeof projectName !== 'string') {
      throw new JSONRPCErrorException('project is required', -32602);
    }
    if (typeof name !== 'string' || name.trim() === '') {
      throw new JSONRPCErrorException('name is required and must be a non-empty string', -32602);
    }

    const project = resolveProject(deps, projectName);
    const tasksDir = getProjectTasksDir(deps.projectsDir, project.name);
    const task = createTask(tasksDir, { name, project: project.name, description });

    return { slug: task.slug, taskDir: task.taskDir };
  });

  // close_task — close a task in a project
  deps.wsAdapter.addMethod('close_task', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const projectName = p['project'] as string | undefined;
    const slug = p['slug'] as string | undefined;

    if (typeof projectName !== 'string') {
      throw new JSONRPCErrorException('project is required', -32602);
    }
    if (typeof slug !== 'string') {
      throw new JSONRPCErrorException('slug is required', -32602);
    }

    const project = resolveProject(deps, projectName);
    const tasksDir = getProjectTasksDir(deps.projectsDir, project.name);

    try {
      closeTask(tasksDir, slug);
    } catch {
      throw new JSONRPCErrorException(`Task "${slug}" not found`, WS_ERROR_TASK_NOT_FOUND);
    }

    return { success: true };
  });

  // draft — start a conversational draft session
  deps.wsAdapter.addMethod('draft', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const roleName = p['role'];
    const projectName = p['project'] as string | undefined;
    const taskSlugParam = p['task'] as string | undefined;

    if (typeof roleName !== 'string') {
      throw new JSONRPCErrorException('role must be a string', -32602);
    }

    if (typeof projectName !== 'string') {
      throw new JSONRPCErrorException('project is required', -32602);
    }

    const project = resolveProject(deps, projectName);
    const role = deps.roles.get(roleName);
    if (!role) {
      throw new JSONRPCErrorException(`Role "${roleName}" not found`, WS_ERROR_ROLE_NOT_FOUND);
    }

    if (getActiveDraft()) {
      throw new JSONRPCErrorException('Draft already active. Use undraft first.', WS_ERROR_DRAFT_ALREADY_ACTIVE);
    }

    // Resolve task if provided
    let taskSlug: string | undefined;
    let taskDir: string | undefined;
    if (taskSlugParam) {
      const tasksDir = getProjectTasksDir(deps.projectsDir, project.name);
      try {
        const task = getTask(tasksDir, taskSlugParam);
        taskSlug = task.slug;
        taskDir = task.taskDir;
      } catch {
        throw new JSONRPCErrorException(`Task "${taskSlugParam}" not found`, WS_ERROR_TASK_NOT_FOUND);
      }
    }

    const channelId = `draft-${Date.now()}`;
    const session = createDraft({
      role,
      project,
      projectsDir: deps.projectsDir,
      taskSlug,
      taskDir,
      channelId,
      pool: deps.pool,
    });

    return { sessionId: session.sessionId, taskSlug: session.taskSlug, project: session.project };
  });

  // undraft — close the active draft session
  deps.wsAdapter.addMethod('undraft', (_params: unknown) => {
    if (!getActiveDraft()) {
      throw new JSONRPCErrorException('No active draft', WS_ERROR_NO_ACTIVE_DRAFT);
    }

    const summary = closeDraft(deps.pool);
    return {
      sessionId: summary.sessionId,
      taskSlug: summary.taskSlug,
      turns: summary.turns,
      cost: summary.costUsd,
      durationMs: summary.durationMs,
    };
  });

  // get_draft_status — return current draft state + metrics
  deps.wsAdapter.addMethod('get_draft_status', (_params: unknown) => {
    const draft = getActiveDraft();
    if (!draft) {
      return { active: false };
    }

    const contextPct = draft.contextWindow > 0
      ? Math.round((draft.lastInputTokens / draft.contextWindow) * 100)
      : 0;

    return {
      active: true,
      session: {
        sessionId: draft.sessionId,
        role: draft.role,
        project: draft.project,
        taskSlug: draft.taskSlug,
        turnCount: draft.turnCount,
        costUsd: draft.cumulativeCostUsd,
        contextPct,
        lastInputTokens: draft.lastInputTokens,
        contextWindow: draft.contextWindow,
        lastActivity: draft.lastActivityAt,
      },
    };
  });

  // kill_agent — abort a running agent
  deps.wsAdapter.addMethod('kill_agent', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const agentId = p['agentId'];

    if (typeof agentId !== 'string') {
      throw new JSONRPCErrorException('agentId must be a string', -32602);
    }

    const exists = deps.pool.list().some(a => a.id === agentId);
    if (!exists) {
      throw new JSONRPCErrorException(`Agent "${agentId}" not found`, WS_ERROR_AGENT_NOT_FOUND);
    }

    deps.pool.kill(agentId);
    return { success: true, message: 'Agent killed' };
  });

  // list_agents — strip AbortController before returning
  deps.wsAdapter.addMethod('list_agents', (_params: unknown) => {
    const agents = deps.pool.list().map(a => ({
      id: a.id,
      role: a.role,
      taskSlug: a.taskSlug,
      startedAt: a.startedAt.toISOString(),
    }));
    return { agents };
  });

  // list_tasks — read task directories from a project
  deps.wsAdapter.addMethod('list_tasks', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const projectName = p['project'] as string | undefined;

    if (typeof projectName !== 'string') {
      throw new JSONRPCErrorException('project is required', -32602);
    }

    const project = resolveProject(deps, projectName);
    const tasksDir = getProjectTasksDir(deps.projectsDir, project.name);
    const tasks = listTasks(tasksDir);
    return { tasks };
  });

  // get_task_context — build context from task history
  deps.wsAdapter.addMethod('get_task_context', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const slug = p['slug'];
    const projectName = p['project'] as string | undefined;

    if (typeof slug !== 'string') {
      throw new JSONRPCErrorException('slug must be a string', -32602);
    }
    if (typeof projectName !== 'string') {
      throw new JSONRPCErrorException('project is required', -32602);
    }

    const project = resolveProject(deps, projectName);
    const tasksDir = getProjectTasksDir(deps.projectsDir, project.name);
    const taskDir = path.join(tasksDir, slug);
    const manifestPath = path.join(taskDir, 'task.json');
    if (!fs.existsSync(manifestPath)) {
      throw new JSONRPCErrorException(`Task "${slug}" not found`, WS_ERROR_TASK_NOT_FOUND);
    }

    const context = buildTaskContext(taskDir);
    return { context };
  });
}
