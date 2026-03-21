import fs from 'node:fs';
import path from 'node:path';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import type { WsAdapter } from './adapters/ws.js';
import type { InboundMessage } from './comms.js';
import type { CommunicationRegistry } from './registry.js';
import type { AgentPool } from './pool.js';
import type { Config } from './config.js';
import type { RoleDefinition, CollabDispatchResult, Project } from './types.js';
import type { McpServers } from './mcp.js';
import { selectMcpServersForRole } from './mcp.js';
import type { BotSessionManager } from './bot-session.js';
import type { BotPlacementStore } from './bot-placement.js';
import type { BotDefinition } from './types.js';
import { getProject, getProjectTasksDir, createProject, loadProjects, isVirtualProject } from './project.js';
import { buildTaskContext } from './context.js';
import { listTasks, createTask, closeTask, getTask } from './task.js';
import { logger } from './logger.js';
import { resolveModelId } from './config.js';
import { scaffoldEntity, validateEntityFrontmatter } from './entity-tools.js';
import type { EntityType } from './entity-tools.js';

/**
 * Resolve a bot by slug or display name (case-insensitive).
 * Errors on ambiguity (slug of one bot collides with display name of another).
 */
export function resolveBot(
  bots: Map<string, BotDefinition>,
  nameOrSlug: string,
): string {
  const lower = nameOrSlug.toLowerCase();

  // Exact slug match (case-insensitive)
  const slugMatches: string[] = [];
  const displayMatches: string[] = [];

  for (const [slug, bot] of bots) {
    if (slug.toLowerCase() === lower) {
      slugMatches.push(slug);
    }
    const dn = bot.displayName ?? bot.name;
    if (dn.toLowerCase() === lower) {
      displayMatches.push(slug);
    }
  }

  // Exact slug match wins
  if (slugMatches.length === 1 && displayMatches.length === 0) {
    return slugMatches[0]!;
  }

  // Display name match wins if no slug match
  if (displayMatches.length === 1 && slugMatches.length === 0) {
    return displayMatches[0]!;
  }

  // Both match the same bot — fine
  if (slugMatches.length === 1 && displayMatches.length === 1 && slugMatches[0] === displayMatches[0]) {
    return slugMatches[0]!;
  }

  // Ambiguity — slug of one bot matches display name of another
  const allMatches = [...new Set([...slugMatches, ...displayMatches])];
  if (allMatches.length > 1) {
    const names = allMatches.map(s => {
      const b = bots.get(s);
      return `${s} (${b?.displayName ?? s})`;
    }).join(', ');
    throw new JSONRPCErrorException(
      `Ambiguous bot name "${nameOrSlug}" — matches: ${names}. Use the exact slug.`,
      WS_ERROR_BOT_AMBIGUOUS,
    );
  }

  if (allMatches.length === 1) {
    return allMatches[0]!;
  }

  throw new JSONRPCErrorException(`Bot "${nameOrSlug}" not found`, WS_ERROR_BOT_NOT_FOUND);
}

const WS_ERROR_TASK_NOT_FOUND = -32000;
const WS_ERROR_AGENT_NOT_FOUND = -32001;
const WS_ERROR_ROLE_NOT_FOUND = -32002;
const WS_ERROR_BOT_NOT_FOUND = -32003;
const WS_ERROR_BOT_BUSY = -32004;
const WS_ERROR_NO_ACTIVE_SESSION = -32005;
const WS_ERROR_PROJECT_NOT_FOUND = -32006;
const WS_ERROR_BOT_AMBIGUOUS = -32007;
const WS_ERROR_INVALID_MODEL = -32008;

export type WsMethodDeps = {
  wsAdapter: WsAdapter;
  registry: CommunicationRegistry;
  handleTask: (
    message: InboundMessage,
    registry: CommunicationRegistry,
    roles: Map<string, RoleDefinition>,
    config: Config,
    pool: AgentPool,
    mcpServers: McpServers | undefined,
    projects: Map<string, Project>,
    projectsDir: string,
  ) => Promise<CollabDispatchResult>;
  roles: Map<string, RoleDefinition>;
  config: Config;
  pool: AgentPool;
  projects: Map<string, Project>;
  projectsDir: string;
  mcpServers?: McpServers;
  botSessionManager: BotSessionManager;
  placementStore?: BotPlacementStore;
  bots?: Map<string, BotDefinition>;
};

function resolveProject(deps: WsMethodDeps, projectName: string): Project {
  try {
    return getProject(deps.projects, projectName);
  } catch {
    throw new JSONRPCErrorException(`Project "${projectName}" not found`, WS_ERROR_PROJECT_NOT_FOUND);
  }
}

/**
 * Compute context window usage percentage.
 * The SDK aggregates token counts across all API calls within a turn.
 * Dividing by num_turns gives the average per-call context usage, which
 * approximates "how full is the context window right now."
 */
function computeContextPct(inputTokens: number, contextWindow: number, numTurns: number): number {
  if (contextWindow <= 0 || inputTokens <= 0) return 0;
  const perCall = inputTokens / Math.max(numTurns, 1);
  return Math.min(100, Math.round((perCall / contextWindow) * 100));
}

type PendingDraft = {
  botName: string;
  roleName: string;
  project: string;
  taskSlug: string;
  taskDir: string;
  channelId: string;
};

export function registerWsMethods(deps: WsMethodDeps): void {

  // Pending drafts — stores context from `draft` until first `submit_prompt` creates the session
  const pendingDrafts = new Map<string, PendingDraft>();

  // list_projects — return all loaded projects
  deps.wsAdapter.addMethod('list_projects', (_params: unknown) => {
    const projectList = [...deps.projects.values()].map((p) => ({
      name: p.name,
      description: p.description,
      paths: p.paths,
      roles: p.roles,
      isVirtual: isVirtualProject(p),
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

  // submit_prompt — routes to active bot session if one exists for the caller, otherwise autonomous dispatch
  deps.wsAdapter.addMethod('submit_prompt', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const content = p['content'];
    const botName = p['bot'] as string | undefined;
    const role = p['role'] as string | undefined;
    const projectName = p['project'] as string | undefined;
    const taskSlug = p['taskSlug'] as string | undefined;

    if (typeof content !== 'string' || content.trim() === '') {
      throw new JSONRPCErrorException('content is required and must be a non-empty string', -32602);
    }

    // Bot session routing — if bot specified, route to BotSessionManager
    if (botName) {
      // Resolve bot name (slug or display name, case-insensitive) — but only if bots are loaded
      const resolvedBotName = deps.bots ? resolveBot(deps.bots, botName) : botName;
      let session = deps.botSessionManager.getSession(resolvedBotName);

      // Lazy session creation — draft stores context, first submit_prompt creates the session
      if (!session) {
        const draft = pendingDrafts.get(resolvedBotName);
        if (!draft) {
          throw new JSONRPCErrorException(`No active session for bot "${resolvedBotName}". Use /draft first.`, WS_ERROR_NO_ACTIVE_SESSION);
        }
        pendingDrafts.delete(resolvedBotName);

        const draftProject = deps.projects.get(draft.project.toLowerCase());
        const draftCwd = draftProject?.paths[0] ?? draft.taskDir;

        // Resolve MCP servers for this role
        const draftRole = deps.roles.get(draft.roleName);
        const draftMcpServers = deps.mcpServers && draftRole
          ? selectMcpServersForRole(draftRole, deps.mcpServers, {
              taskSlug: draft.taskSlug, taskDir: draft.taskDir, parentProject: draft.project,
            })
          : undefined;

        // Route the first message through handleBotMessage — it creates the session
        deps.botSessionManager.handleBotMessage({
          botName: draft.botName,
          roleName: draft.roleName,
          message: content,
          project: draft.project,
          taskSlug: draft.taskSlug,
          taskDir: draft.taskDir,
          cwd: draftCwd,
          channelId: draft.channelId,
          responseSink: async () => {},
          registry: deps.registry,
          mcpServers: draftMcpServers,
        })
          .then(() => {
            const updated = deps.botSessionManager.getSession(resolvedBotName);
            if (updated) {
              deps.wsAdapter.broadcastNotification('draft_status', {
                sessionId: updated.sessionId,
                botName: updated.botName,
                role: updated.role,
                project: updated.project,
                turnCount: updated.turnCount,
                costUsd: updated.cumulativeCostUsd,
                contextPct: computeContextPct(updated.lastInputTokens, updated.contextWindow, updated.lastNumTurns),
                lastInputTokens: updated.lastInputTokens,
                lastOutputTokens: updated.lastOutputTokens,
                lastActivity: updated.lastActivityAt,
              });
            }
          })
          .catch((err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error({ err: errMsg, botName: resolvedBotName }, 'lazy session creation failed');
          });

        return { status: 'submitted', botName: resolvedBotName, firstMessage: true };
      }
      if (session.staleRole) {
        throw new JSONRPCErrorException(
          `Session role "${session.role}" no longer exists. Use /undraft to close the stale session.`,
          WS_ERROR_ROLE_NOT_FOUND,
        );
      }

      const sessionRole = deps.roles.get(session.role);
      const sessionProject = deps.projects.get(session.project.toLowerCase());
      const sessionCwd = sessionProject?.paths[0];

      const mcpServersForRole = deps.mcpServers && sessionRole
        ? selectMcpServersForRole(sessionRole, deps.mcpServers, {
            taskSlug: session.taskSlug, taskDir: session.taskDir,
            parentProject: session.project, parentDispatchId: session.dispatchId,
          })
        : undefined;

      // Fire-and-forget resume
      deps.botSessionManager.handleBotMessage({
        botName: resolvedBotName,
        roleName: session.role,
        message: content,
        project: session.project,
        taskSlug: session.taskSlug,
        taskDir: session.taskDir,
        cwd: sessionCwd ?? session.taskDir,
        channelId: session.channelId,
        responseSink: async () => {}, // TUI uses registry broadcast
        registry: deps.registry,
        mcpServers: mcpServersForRole,
        onCompaction: (event) => {
          deps.wsAdapter.broadcastNotification('context_compacted', {
            sessionId: session.sessionId, botName: resolvedBotName, ...event,
          });
        },
      })
        .then(() => {
          const updated = deps.botSessionManager.getSession(resolvedBotName);
          if (updated) {
            deps.wsAdapter.broadcastNotification('draft_status', {
              sessionId: updated.sessionId,
              botName: updated.botName,
              role: updated.role,
              project: updated.project,
              turnCount: updated.turnCount,
              costUsd: updated.cumulativeCostUsd,
              contextPct: computeContextPct(updated.lastInputTokens, updated.contextWindow, updated.lastNumTurns),
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
            channelId: session.channelId,
            from: 'system',
            timestamp: new Date().toISOString(),
            type: 'error',
            content: `Session turn failed: ${errMsg}`,
          });
        });

      return { threadId: `bot-${session.sessionId}`, taskSlug: session.taskSlug, botName: resolvedBotName };
    }

    // Autonomous dispatch — requires project
    if (!projectName) {
      throw new JSONRPCErrorException('project is required for autonomous dispatch (or specify bot for bot session)', -32602);
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
    if (isVirtualProject(project)) {
      throw new JSONRPCErrorException(`Cannot create tasks in virtual project "${project.name}"`, -32602);
    }
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

  // draft — start a conversational session with a bot
  deps.wsAdapter.addMethod('draft', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const botNameInput = p['bot'] as string | undefined;
    const roleName = p['role'];
    const projectName = p['project'] as string | undefined;
    const taskSlugParam = p['task'] as string | undefined;
    const modelParam = p['model'] as string | undefined;

    if (typeof botNameInput !== 'string') {
      throw new JSONRPCErrorException('bot is required', -32602);
    }
    if (typeof roleName !== 'string') {
      throw new JSONRPCErrorException('role must be a string', -32602);
    }
    if (typeof projectName !== 'string') {
      throw new JSONRPCErrorException('project is required', -32602);
    }
    if (typeof taskSlugParam !== 'string') {
      throw new JSONRPCErrorException('task is required', -32602);
    }

    // Resolve bot name (slug or display name, case-insensitive)
    if (!deps.bots) {
      throw new JSONRPCErrorException('No bots loaded', WS_ERROR_BOT_NOT_FOUND);
    }
    const botName = resolveBot(deps.bots, botNameInput);

    // Check placement status — guards against race with Slack queue
    if (deps.placementStore) {
      const placement = deps.placementStore.get(botName);
      if (placement && (placement.status === 'busy' || placement.status === 'drafted')) {
        throw new JSONRPCErrorException(
          `Bot "${botName}" is ${placement.status}${placement.draftedBy ? ` by ${placement.draftedBy}` : ''}. Use undraft first.`,
          WS_ERROR_BOT_BUSY,
        );
      }
    }

    // Check bot already has active session
    const existingSession = deps.botSessionManager.getSession(botName);
    if (existingSession && existingSession.status === 'active') {
      throw new JSONRPCErrorException(
        `Bot "${botName}" is already active in ${existingSession.project}. Use undraft first.`,
        WS_ERROR_BOT_BUSY,
      );
    }

    const project = resolveProject(deps, projectName);
    if (isVirtualProject(project)) {
      throw new JSONRPCErrorException(`Cannot draft into virtual project "${project.name}"`, -32602);
    }
    const role = deps.roles.get(roleName);
    if (!role) {
      throw new JSONRPCErrorException(`Role "${roleName}" not found`, WS_ERROR_ROLE_NOT_FOUND);
    }

    // Validate model alias if provided
    if (modelParam !== undefined) {
      const resolved = resolveModelId(modelParam, deps.config);
      if (resolved === deps.config.models.default && modelParam !== deps.config.models.default && !deps.config.models.aliases[modelParam]) {
        throw new JSONRPCErrorException(`Unknown model alias "${modelParam}"`, WS_ERROR_INVALID_MODEL);
      }
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

    // Mark bot as drafted synchronously — closes race window with Slack queue
    deps.placementStore?.setDrafted(botName, 'ws', { project: project.name, roleName });

    // Store draft context — session is created lazily on first submit_prompt
    // (avoids empty-message SDK error). get_draft_status returns active: false until first message.
    const channelId = `draft-${Date.now()}`;
    pendingDrafts.set(botName, {
      botName,
      roleName: roleName,
      project: project.name,
      taskSlug,
      taskDir,
      channelId,
    });

    // Apply model pin if requested
    if (modelParam) {
      deps.botSessionManager.setModelOverride(botName, modelParam);
    }

    return { botName, sessionId: channelId, taskSlug, project: project.name };
  });

  // undraft — close a bot session
  deps.wsAdapter.addMethod('undraft', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const botNameInput = p['bot'] as string | undefined;

    if (typeof botNameInput !== 'string') {
      throw new JSONRPCErrorException('bot is required', -32602);
    }

    // Resolve bot name (slug or display name, case-insensitive)
    if (!deps.bots) {
      throw new JSONRPCErrorException('No bots loaded', WS_ERROR_BOT_NOT_FOUND);
    }
    const botName = resolveBot(deps.bots, botNameInput);

    // Handle pending draft (drafted but no message sent yet)
    const pending = pendingDrafts.get(botName);
    if (pending) {
      pendingDrafts.delete(botName);
      deps.placementStore?.setUndrafted(botName);
      return { botName, sessionId: pending.channelId, taskSlug: pending.taskSlug, turns: 0, cost: 0, durationMs: 0 };
    }

    const session = deps.botSessionManager.getSession(botName);
    if (!session) {
      throw new JSONRPCErrorException(`No active session for bot "${botName}"`, WS_ERROR_NO_ACTIVE_SESSION);
    }

    const summary = deps.botSessionManager.closeSession(botName);

    // Return bot to lobby — clears project, role, draftedBy
    deps.placementStore?.setUndrafted(botName);

    return {
      botName: summary.botName,
      sessionId: summary.sessionId,
      taskSlug: summary.taskSlug,
      turns: summary.turns,
      cost: summary.costUsd,
      durationMs: summary.durationMs,
    };
  });

  // get_draft_status — return bot session state + metrics
  deps.wsAdapter.addMethod('get_draft_status', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const botNameInput = p['bot'] as string | undefined;

    if (botNameInput) {
      // Resolve bot name if bots loaded
      const resolvedName = deps.bots ? resolveBot(deps.bots, botNameInput) : botNameInput;
      const session = deps.botSessionManager.getSession(resolvedName);
      if (!session) {
        return { active: false, botName: resolvedName };
      }

      return {
        active: true,
        session: {
          sessionId: session.sessionId,
          botName: session.botName,
          role: session.role,
          project: session.project,
          taskSlug: session.taskSlug,
          turnCount: session.turnCount,
          costUsd: session.cumulativeCostUsd,
          contextPct: computeContextPct(session.lastInputTokens, session.contextWindow, session.lastNumTurns),
          lastInputTokens: session.lastInputTokens,
          contextWindow: session.contextWindow,
          lastActivity: session.lastActivityAt,
          staleRole: session.staleRole ?? false,
        },
      };
    }

    // No bot specified — check if any sessions are active
    const allSessions = deps.botSessionManager.getAllSessions();
    const activeSessions = [...allSessions.values()].filter(s => s.status === 'active');
    const firstActive = activeSessions[0];
    if (!firstActive) {
      return { active: false };
    }

    return {
      active: true,
      session: {
        sessionId: firstActive.sessionId,
        botName: firstActive.botName,
        role: firstActive.role,
        project: firstActive.project,
        taskSlug: firstActive.taskSlug,
        turnCount: firstActive.turnCount,
        costUsd: firstActive.cumulativeCostUsd,
        contextPct: computeContextPct(firstActive.lastInputTokens, firstActive.contextWindow, firstActive.lastNumTurns),
        lastInputTokens: firstActive.lastInputTokens,
        contextWindow: firstActive.contextWindow,
        lastActivity: firstActive.lastActivityAt,
        staleRole: firstActive.staleRole ?? false,
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
      botId: a.botId ?? null,
      botName: a.botName ?? null,
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

  // ── Bot Management Methods ────────────────────────────────────

  // list_bots — return all bots with placement + session info
  deps.wsAdapter.addMethod('list_bots', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const projectFilter = p['project'] as string | undefined;

    if (!deps.placementStore || !deps.bots) {
      return { bots: [] };
    }

    const allPlacements = deps.placementStore.getAll();
    const botList = [...allPlacements.values()]
      .filter(pl => !projectFilter || pl.project.toLowerCase() === projectFilter.toLowerCase())
      .map(pl => {
        const bot = deps.bots!.get(pl.botName);
        const session = deps.botSessionManager.getSession(pl.botName);
        const isLobby = pl.project.toLowerCase() === 'lobby';
        return {
          name: pl.botName,
          displayName: bot?.displayName ?? pl.botName,
          project: pl.project,
          role: isLobby ? null : pl.roleName,
          status: pl.status,
          draftedBy: pl.draftedBy,
          sessionTurns: session?.turnCount,
          contextPct: session ? computeContextPct(session.lastInputTokens, session.contextWindow, session.lastNumTurns) : undefined,
          lastActivity: session?.lastActivityAt,
        };
      });

    return { bots: botList };
  });

  // get_bot_status — return detailed status for a single bot
  deps.wsAdapter.addMethod('get_bot_status', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const botNameInput = p['bot'] as string | undefined;

    if (typeof botNameInput !== 'string') {
      throw new JSONRPCErrorException('bot is required', -32602);
    }

    if (!deps.placementStore || !deps.bots) {
      throw new JSONRPCErrorException(`Bot "${botNameInput}" not found`, WS_ERROR_BOT_NOT_FOUND);
    }

    // Resolve bot name (slug or display name, case-insensitive)
    const botName = resolveBot(deps.bots, botNameInput);

    const placement = deps.placementStore.get(botName);
    if (!placement) {
      throw new JSONRPCErrorException(`Bot "${botName}" not found`, WS_ERROR_BOT_NOT_FOUND);
    }

    const bot = deps.bots.get(botName);
    const session = deps.botSessionManager.getSession(botName);
    const isLobby = placement.project.toLowerCase() === 'lobby';

    return {
      name: placement.botName,
      displayName: bot?.displayName ?? placement.botName,
      project: placement.project,
      role: isLobby ? null : placement.roleName,
      status: placement.status,
      draftedBy: placement.draftedBy,
      sessionTurns: session?.turnCount,
      costUsd: session?.cumulativeCostUsd,
      contextPct: session ? computeContextPct(session.lastInputTokens, session.contextWindow, session.lastNumTurns) : undefined,
      lastActivity: session?.lastActivityAt,
    };
  });

  // list_roles — return all loaded roles
  deps.wsAdapter.addMethod('list_roles', (_params: unknown) => {
    const roleList = [...deps.roles.values()].map((r) => ({
      name: r.name,
      displayName: r.displayName,
      description: r.description,
      modelHint: r.modelHint,
    }));
    return { roles: roleList };
  });

  // ── Model Pinning (H7) ──────────────────────────────────────

  // set_model — pin a model for the current bot session (or clear with no args)
  deps.wsAdapter.addMethod('set_model', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const botNameInput = p['bot'] as string | undefined;
    const modelAlias = p['model'] as string | undefined;

    if (typeof botNameInput !== 'string') {
      throw new JSONRPCErrorException('bot is required', -32602);
    }

    if (!deps.bots) {
      throw new JSONRPCErrorException('No bots loaded', WS_ERROR_BOT_NOT_FOUND);
    }
    const botName = resolveBot(deps.bots, botNameInput);

    // If model provided, validate it resolves to something known
    if (modelAlias !== undefined && modelAlias !== null) {
      const resolved = resolveModelId(modelAlias, deps.config);
      if (resolved === deps.config.models.default && modelAlias !== deps.config.models.default && !deps.config.models.aliases[modelAlias]) {
        throw new JSONRPCErrorException(`Unknown model alias "${modelAlias}"`, WS_ERROR_INVALID_MODEL);
      }
      deps.botSessionManager.setModelOverride(botName, modelAlias);
    } else {
      // Clear pin
      deps.botSessionManager.setModelOverride(botName, undefined);
    }

    // Return current effective model
    const session = deps.botSessionManager.getSession(botName);
    const override = deps.botSessionManager.getModelOverride(botName);
    const placement = deps.placementStore?.get(botName);
    const roleName = session?.role ?? placement?.roleName;
    const role = roleName ? deps.roles.get(roleName) : undefined;
    const effectiveHint = override ?? role?.modelHint ?? deps.config.models.default;
    const effectiveModel = resolveModelId(effectiveHint, deps.config);

    return {
      botName,
      model: effectiveModel,
      alias: effectiveHint,
      pinned: override !== undefined,
    };
  });

  // get_model — return current model for a bot session
  deps.wsAdapter.addMethod('get_model', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const botNameInput = p['bot'] as string | undefined;

    if (typeof botNameInput !== 'string') {
      throw new JSONRPCErrorException('bot is required', -32602);
    }

    if (!deps.bots) {
      throw new JSONRPCErrorException('No bots loaded', WS_ERROR_BOT_NOT_FOUND);
    }
    const botName = resolveBot(deps.bots, botNameInput);

    const session = deps.botSessionManager.getSession(botName);
    const override = deps.botSessionManager.getModelOverride(botName);
    const placement = deps.placementStore?.get(botName);
    const roleName = session?.role ?? placement?.roleName;
    const role = roleName ? deps.roles.get(roleName) : undefined;
    const effectiveHint = override ?? role?.modelHint ?? deps.config.models.default;
    const effectiveModel = resolveModelId(effectiveHint, deps.config);

    return {
      botName,
      model: effectiveModel,
      alias: effectiveHint,
      pinned: override !== undefined,
    };
  });

  // ── Filter Level (H8) ───────────────────────────────────────

  // set_filter_level — set the event stream filter level for a bot session
  deps.wsAdapter.addMethod('set_filter_level', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const botNameInput = p['bot'] as string | undefined;
    const level = p['level'] as string | undefined;

    if (typeof botNameInput !== 'string') {
      throw new JSONRPCErrorException('bot is required', -32602);
    }
    if (level !== 'minimal' && level !== 'feedback' && level !== 'verbose') {
      throw new JSONRPCErrorException('level must be "minimal", "feedback", or "verbose"', -32602);
    }

    if (!deps.bots) {
      throw new JSONRPCErrorException('No bots loaded', WS_ERROR_BOT_NOT_FOUND);
    }
    const botName = resolveBot(deps.bots, botNameInput);

    deps.botSessionManager.setFilterLevel(botName, level);

    return { botName, filterLevel: level };
  });
}
