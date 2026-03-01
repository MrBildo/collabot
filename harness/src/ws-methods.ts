import fs from 'node:fs';
import path from 'node:path';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import type { WsAdapter } from './adapters/ws.js';
import type { InboundMessage } from './comms.js';
import type { CommunicationRegistry } from './registry.js';
import type { AgentPool } from './pool.js';
import type { Config } from './config.js';
import type { RoleDefinition, DispatchResult, Project } from './types.js';
import type { McpServers } from './core.js';
import { getProject, getProjectTasksDir, createProject, loadProjects } from './project.js';
import { buildTaskContext } from './context.js';
import { listTasks, createTask, closeTask, getTask } from './task.js';
import { logger } from './logger.js';
import { getActiveDraft, createDraft, closeDraft, resumeDraft } from './draft.js';
import { scaffoldEntity, validateEntityFrontmatter } from './entity-tools.js';
import type { EntityType } from './entity-tools.js';

const WS_ERROR_TASK_NOT_FOUND = -32000;
const WS_ERROR_AGENT_NOT_FOUND = -32001;
const WS_ERROR_ROLE_NOT_FOUND = -32002;
const WS_ERROR_DRAFT_ALREADY_ACTIVE = -32004;
const WS_ERROR_NO_ACTIVE_DRAFT = -32005;
const WS_ERROR_PROJECT_NOT_FOUND = -32006;

export type WsMethodDeps = {
  wsAdapter: WsAdapter;
  registry: CommunicationRegistry;
  handleTask: (
    message: InboundMessage,
    registry: CommunicationRegistry,
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

  // create_project — scaffold a new project manifest
  deps.wsAdapter.addMethod('create_project', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const name = p['name'] as string | undefined;
    const description = p['description'] as string | undefined;
    const roles = p['roles'] as string[] | undefined;

    if (typeof name !== 'string' || name.trim() === '') {
      throw new JSONRPCErrorException('name is required and must be a non-empty string', -32602);
    }

    // Check for duplicate
    if (deps.projects.has(name.toLowerCase())) {
      throw new JSONRPCErrorException(`Project "${name}" already exists`, -32602);
    }

    const rolesList = Array.isArray(roles) ? roles : [...deps.roles.keys()];

    try {
      const project = createProject(
        deps.projectsDir,
        { name, description: description ?? name, roles: rolesList },
        deps.roles,
      );
      deps.projects.set(project.name.toLowerCase(), project);
      return { name: project.name, paths: project.paths, roles: project.roles };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new JSONRPCErrorException(msg, -32602);
    }
  });

  // reload_projects — re-read all projects from disk
  deps.wsAdapter.addMethod('reload_projects', (_params: unknown) => {
    const reloaded = loadProjects(deps.projectsDir, deps.roles);
    // Replace contents of live registry
    deps.projects.clear();
    for (const [key, project] of reloaded) {
      deps.projects.set(key, project);
    }
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
      if (draft.staleRole) {
        throw new JSONRPCErrorException(
          `Draft role "${draft.role}" no longer exists. Use /undraft to close the stale session.`,
          WS_ERROR_ROLE_NOT_FOUND,
        );
      }
      const draftRole = deps.roles.get(draft.role);
      // Resolve CWD from the draft's project
      const draftProject = deps.projects.get(draft.project.toLowerCase());
      const draftCwd = draftProject?.paths[0];
      let mcpServer;
      if (deps.mcpServers && draftRole) {
        const isFullAccess = draftRole?.permissions?.includes('agent-draft') ?? false;
        mcpServer = isFullAccess
          ? deps.mcpServers.createFull(draft.taskSlug, draft.taskDir, draft.project)
          : deps.mcpServers.readonly;
      }

      // Fire-and-forget resume
      resumeDraft(content, deps.registry, deps.roles, deps.config, deps.pool, {
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
              lastInputTokens: updated.lastInputTokens,
              lastOutputTokens: updated.lastOutputTokens,
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

    deps.handleTask(message, deps.registry, deps.roles, deps.config, deps.pool, deps.mcpServers, deps.projects, deps.projectsDir)
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

    return { slug: task.slug, taskDir: task.taskDir, slugModified: task.slugModified };
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

    if (typeof taskSlugParam !== 'string') {
      throw new JSONRPCErrorException('task is required', -32602);
    }

    const project = resolveProject(deps, projectName);
    const role = deps.roles.get(roleName);
    if (!role) {
      throw new JSONRPCErrorException(`Role "${roleName}" not found`, WS_ERROR_ROLE_NOT_FOUND);
    }

    if (getActiveDraft()) {
      throw new JSONRPCErrorException('Draft already active. Use undraft first.', WS_ERROR_DRAFT_ALREADY_ACTIVE);
    }

    // Resolve task
    const tasksDir = getProjectTasksDir(deps.projectsDir, project.name);
    let taskSlug: string;
    let taskDir: string;
    try {
      const task = getTask(tasksDir, taskSlugParam);
      taskSlug = task.slug;
      taskDir = task.taskDir;
    } catch {
      throw new JSONRPCErrorException(`Task "${taskSlugParam}" not found`, WS_ERROR_TASK_NOT_FOUND);
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
        staleRole: draft.staleRole ?? false,
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

  // entity_scaffold — generate a new entity file from template
  deps.wsAdapter.addMethod('entity_scaffold', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const type = p['type'] as EntityType | undefined;
    const name = p['name'] as string | undefined;
    const author = p['author'] as string | undefined;

    if (typeof type !== 'string') {
      throw new JSONRPCErrorException('type is required (e.g. "role")', -32602);
    }
    if (typeof name !== 'string' || name.trim() === '') {
      throw new JSONRPCErrorException('name is required and must be a non-empty string', -32602);
    }
    if (typeof author !== 'string' || author.trim() === '') {
      throw new JSONRPCErrorException('author is required and must be a non-empty string', -32602);
    }

    try {
      const result = scaffoldEntity(type as EntityType, name, author);
      return { content: result.content, id: result.id, filePath: result.filePath };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new JSONRPCErrorException(msg, -32602);
    }
  });

  // entity_validate — validate entity frontmatter against schema
  deps.wsAdapter.addMethod('entity_validate', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const content = p['content'] as string | undefined;
    const type = (p['type'] as string | undefined) ?? 'role';

    if (typeof content !== 'string' || content.trim() === '') {
      throw new JSONRPCErrorException('content is required and must be a non-empty string', -32602);
    }

    const result = validateEntityFrontmatter(content, type as EntityType);
    return result;
  });
}
