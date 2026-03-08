import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { exec } from 'node:child_process';
import { logger, logTier, applyConfigLogLevel } from './logger.js';
import { loadConfig, resolveModelId } from './config.js';
import { loadRoles, ModelHintEnum, PermissionsEnum } from './roles.js';
import { loadProjects, ensureVirtualProject, getProjectTasksDir } from './project.js';
import { loadBots } from './bots.js';
import { AgentPool } from './pool.js';
import { draftAgent, handleTask } from './core.js';
import { createHarnessServer, DispatchTracker } from './mcp.js';
import { CommunicationRegistry } from './registry.js';
import { CliAdapter } from './adapters/cli.js';
import { WsAdapter } from './adapters/ws.js';
import { SlackAdapter } from './adapters/slack.js';
import { BotMessageQueue } from './bot-queue.js';
import { BotSessionManager } from './bot-session.js';
import { CronScheduler } from './cron.js';
import { placeBots, BotPlacementStore } from './bot-placement.js';
import { createTask, getOpenTasks, closeTask } from './task.js';
import { registerWsMethods } from './ws-methods.js';
import { getInstancePath, getInstanceRoot, getPackagePath } from './paths.js';
import type { InboundHandler, VirtualProjectMeta } from './comms.js';
import type { DraftAgentFn } from './mcp.js';

// Read version from package.json (adjacent to src/ in the package)
const pkgPath = getPackagePath('package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
const version = pkg.version;

// Instance paths
const PROJECTS_DIR = getInstancePath('.projects');

// Load config (fail fast before any connections)
let config;
try {
  config = loadConfig();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log('\n  Collabot — config load failed\n');
  logger.error({ msg }, 'config load failed');
  process.exit(1);
}

// Apply config-driven log level (env var override wins if set)
applyConfigLogLevel(config.logging.level);

const defaultModel = config.models.default;
const aliasCount = Object.keys(config.models.aliases).length;

// Load roles (fail fast before any connections)
const rolesDir = getInstancePath('roles');
let roles;
try {
  roles = loadRoles(rolesDir);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log('\n  Collabot — roles load failed\n');
  logger.error({ msg }, 'roles load failed');
  process.exit(1);
}

// Validate role model-hints resolve to a known alias or the default model
const knownAliases = Object.keys(config.models.aliases);
const validModelHints = ModelHintEnum.options;
const validPermissions = PermissionsEnum.options;

for (const role of roles.values()) {
  // Warn if model-hint has no alias mapping (will fall back to default)
  if (!knownAliases.includes(role.modelHint)) {
    logger.warn(
      { role: role.name, modelHint: role.modelHint, knownAliases },
      'role model-hint has no alias — will use config default',
    );
  }

  // Validate permissions are known enum values
  for (const perm of role.permissions ?? []) {
    if (!validPermissions.includes(perm as any)) {
      logger.error(
        { role: role.name, permission: perm, validPermissions },
        'role references unknown permission',
      );
      process.exit(1);
    }
  }
}

const roleCount = roles.size;
const roleNames = [...roles.keys()].join(', ');

// Load projects (fail fast on schema errors)
let projects: ReturnType<typeof loadProjects>;
try {
  projects = loadProjects(PROJECTS_DIR, roles);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log('\n  Collabot — project load failed\n');
  logger.error({ msg }, 'project load failed');
  process.exit(1);
}

// Load bots (optional — empty is fine)
const botsDir = getInstancePath('bots');
let bots;
try {
  bots = loadBots(botsDir);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log('\n  Collabot — bots load failed\n');
  logger.error({ msg }, 'bots load failed');
  process.exit(1);
}

const botCount = bots.size;
const botNames = [...bots.keys()].join(', ');

const projectCount = projects.size;
const projectNames = [...projects.values()].map((p) => p.name).join(', ');

// Initialize agent pool
const pool = new AgentPool(config.pool.maxConcurrent);

// ── Communication Registry ──────────────────────────────────────

const registry = new CommunicationRegistry();

// CLI always present
registry.register(new CliAdapter());

// Initialize MCP servers — shared tracker and draftFn for lifecycle tools
const tracker = new DispatchTracker();
const draftFn: DraftAgentFn = async (roleName, taskContext, opts) => {
  return draftAgent(roleName, taskContext, registry, roles, config, {
    taskSlug: opts?.taskSlug,
    taskDir: opts?.taskDir,
    cwd: opts?.cwd,
    parentDispatchId: opts?.parentDispatchId,
    pool,
  });
};
const mcpServers = {
  createFull: (parentTaskSlug: string, parentTaskDir: string, parentProject?: string, parentDispatchId?: string) => createHarnessServer({
    pool, projects, projectsDir: PROJECTS_DIR, roles, tools: 'full',
    tracker, draftFn,
    parentTaskSlug, parentTaskDir, parentProject, parentDispatchId,
  }),
  readonly: createHarnessServer({
    pool, projects, projectsDir: PROJECTS_DIR, roles, tools: 'readonly',
  }),
};

// ── 4. Ensure lobby virtual project ──────────────────────────────

let lobbyEnsured = false;
if (botCount > 0) {
  try {
    const allRoleNames = [...roles.keys()];
    const lobby = ensureVirtualProject(PROJECTS_DIR, 'lobby', 'Default virtual project for bot sessions', allRoleNames, getInstanceRoot());
    projects.set('lobby', lobby);
    lobbyEnsured = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ msg }, 'failed to ensure lobby virtual project');
  }
}

// ── 5. Create botSessionManager (before adapters need it) ────────

const botSessionManager = new BotSessionManager(config, roles, bots, pool);

// Detect interface modes
const slackBotCount = config.slack ? Object.keys(config.slack.bots).length : 0;
const slackEnabled = slackBotCount > 0;
const wsEnabled = !!config.ws;

const botQueue = new BotMessageQueue();

let slackAdapter: SlackAdapter | undefined;
if (slackEnabled && config.slack) {
  // Validate credentials only — role/project assignment is via [bots.*] and placeBots()
  const validBots: Record<string, { botTokenEnv: string; appTokenEnv: string }> = {};
  for (const [botName, botConfig] of Object.entries(config.slack.bots)) {
    if (!bots.has(botName)) {
      logger.warn({ botName }, 'Slack config references unknown bot — skipping');
      continue;
    }
    const token = process.env[botConfig.botTokenEnv];
    const appToken = process.env[botConfig.appTokenEnv];
    if (!token || !appToken) {
      logger.warn({ botName, botTokenEnv: botConfig.botTokenEnv, appTokenEnv: botConfig.appTokenEnv },
        'Slack bot env vars not set — skipping');
      continue;
    }
    validBots[botName] = botConfig;
  }

  if (Object.keys(validBots).length > 0) {
    slackAdapter = new SlackAdapter(
      { ...config.slack, bots: validBots },
      bots,
      botQueue,
    );
    registry.register(slackAdapter);
  }
}

// ── 6. Construct + register WS ──────────────────────────────────

let wsDeps: Parameters<typeof registerWsMethods>[0] | undefined;
if (wsEnabled) {
  const ws = new WsAdapter({ port: config.ws!.port, host: config.ws!.host });
  wsDeps = { wsAdapter: ws, registry, handleTask, roles, config, pool, projects, projectsDir: PROJECTS_DIR, mcpServers, botSessionManager };
  registerWsMethods(wsDeps);
  pool.setOnChange((agents) => {
    ws.broadcastNotification('pool_status', { agents });
  });
  registry.register(ws);
}

// ── 7. Provider interrogation ───────────────────────────────────

const virtualProjectMeta = new Map<string, VirtualProjectMeta>();

for (const provider of registry.providers()) {
  if (typeof provider.getVirtualProjects === 'function') {
    const requests = provider.getVirtualProjects();
    for (const req of requests) {
      try {
        const roleNames = req.roles.length > 0 ? req.roles : [...roles.keys()];
        const vp = ensureVirtualProject(PROJECTS_DIR, req.name, req.description, roleNames, getInstanceRoot());
        projects.set(req.name.toLowerCase(), vp);

        // Store meta (disallowedTools, skills) — runtime only, not persisted
        const meta: VirtualProjectMeta = {};
        if (req.disallowedTools) meta.disallowedTools = req.disallowedTools;
        if (req.skills) meta.skills = req.skills;
        if (Object.keys(meta).length > 0) {
          virtualProjectMeta.set(req.name.toLowerCase(), meta);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ provider: provider.name, project: req.name, msg }, 'failed to ensure virtual project from provider');
      }
    }
  }
}

// ── 8. Bot placement ────────────────────────────────────────────

const placementStore = new BotPlacementStore(placeBots(config, bots, roles, projects, virtualProjectMeta));

// Late-bind placement store and bots to WS deps.
// Handlers close over the deps object reference, so setting properties here is visible at call time.
if (wsDeps) {
  wsDeps.placementStore = placementStore;
  wsDeps.bots = bots;
}

// ── 9. Ensure tasks + wire queue handler (placement-aware) ──────

// Ensure an open task exists for each virtual project that has bots placed in it
function ensureProjectTask(projectName: string): { slug: string; taskDir: string } | undefined {
  if (!projects.has(projectName.toLowerCase())) return undefined;

  const tasksDir = getProjectTasksDir(PROJECTS_DIR, projectName);
  try {
    const open = getOpenTasks(tasksDir);
    if (open.length > 0) {
      return open[0];
    }
    const today = new Date().toISOString().split('T')[0];
    return createTask(tasksDir, {
      name: `session-${today}`,
      project: projectName,
      description: `Bot session task for ${today}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ projectName, msg }, 'failed to ensure project task');
    return undefined;
  }
}

// Collect unique virtual projects with bots and ensure initial tasks
const virtualProjectsWithBots = new Set<string>();
for (const placement of placementStore.getAll().values()) {
  const proj = projects.get(placement.project.toLowerCase());
  if (proj?.virtual) {
    virtualProjectsWithBots.add(placement.project.toLowerCase());
  }
}

// Pre-ensure tasks for session recovery
const projectTasks = new Map<string, { slug: string; taskDir: string }>();
for (const projectName of virtualProjectsWithBots) {
  const task = ensureProjectTask(projectName);
  if (task) projectTasks.set(projectName, task);
}

// Wire bot queue handler → bot session manager (placement-aware)
botQueue.setHandler(async (msg) => {
  const placement = placementStore.get(msg.botName);
  if (!placement) {
    logger.warn({ botName: msg.botName }, 'No placement for bot — dropping message');
    return;
  }

  const projectName = placement.project.toLowerCase();

  // Ensure task exists for this project (may have been rotated)
  let task = projectTasks.get(projectName);
  if (!task) {
    task = ensureProjectTask(projectName);
    if (!task) {
      logger.warn({ botName: msg.botName, project: projectName }, 'No task available — dropping message');
      return;
    }
    projectTasks.set(projectName, task);
  }

  // Determine CWD from project paths
  const proj = projects.get(projectName);
  const cwd = proj?.paths[0] ?? getInstanceRoot();

  // Build response sink that posts via the correct Slack bot
  const channel = msg.metadata['channel'] as string;
  const responseSink = async (text: string) => {
    if (slackAdapter) {
      const instance = slackAdapter.getInstance(msg.botName);
      if (instance) {
        try {
          await instance.app.client.chat.postMessage({ channel, text });
        } catch (err) {
          logger.error({ err, botName: msg.botName }, 'failed to post bot response');
        }
      }
    }
  };

  try {
    await botSessionManager.handleBotMessage({
      botName: msg.botName,
      roleName: placement.roleName,
      message: msg.content,
      project: placement.project,
      taskSlug: task.slug,
      taskDir: task.taskDir,
      cwd,
      responseSink,
      disallowedTools: placement.disallowedTools,
      projectSkills: placement.skills,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, botName: msg.botName }, 'bot session handler error');
    await responseSink(`Something went wrong: ${errMsg.slice(0, 200)}`);
  }
});

// ── 11. Banner ──────────────────────────────────────────────────

const interfaceList = [
  slackEnabled ? `Slack (${slackBotCount} bot${slackBotCount !== 1 ? 's' : ''})` : null,
  'CLI',
  wsEnabled ? `WS (${config.ws!.host}:${config.ws!.port})` : null,
].filter(Boolean).join(', ');

const placementList = [...placementStore.getAll().values()]
  .map(p => `${p.botName}@${p.project}(${p.roleName})`)
  .join(', ');

// ANSI 24-bit color helpers
const cyan = (s: string) => `\x1b[38;2;0;180;255m${s}\x1b[0m`;
const orange = (s: string) => `\x1b[38;2;255;160;0m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

console.log([
  '',
  '',
  cyan('   ____ ___  _     _        _    ') + orange('____   ___ _____ '),
  cyan('  / ___/ _ \\| |   | |      / \\  ') + orange('| __ ) / _ \\_   _|'),
  cyan(' | |  | | | | |   | |     / _ \\ ') + orange('|  _ \\| | | || |  '),
  cyan(' | |__| |_| | |___| |___ / ___ \\') + orange('| |_) | |_| || |  '),
  cyan('  \\____\\___/|_____|_____/_/   \\_\\') + orange('____/ \\___/ |_|  '),
  dim('        the collaborative agent platform'),
  '',
  `  v${version} | Node ${process.version} | ${process.platform} | log=${logTier}`,
  `  config: OK | model: ${defaultModel} | aliases: ${aliasCount}`,
  `  projects: ${projectCount + virtualProjectMeta.size} (${[...projects.values()].map(p => p.name).join(', ') || 'none'})`,
  `  roles: ${roleCount} (${roleNames})`,
  `  bots: ${botCount} (${botNames || 'none'})`,
  ...(placementList ? [`  placements: ${placementList}`] : []),
  `  pool: maxConcurrent=${config.pool.maxConcurrent || 'unlimited'}`,
  `  mcp: streamTimeout=${config.mcp.streamTimeout}ms`,
  `  interfaces: ${interfaceList}`,
  '',
].join('\n'));

// ── 11b. Startup auth probe (async, non-blocking) ───────────────

if (botCount > 0) {
  const authEnv = { ...process.env, CLAUDECODE: undefined };
  exec(
    'claude -p "ok" --output-format text --max-turns 1',
    { encoding: 'utf8', timeout: 30_000, env: authEnv },
    (err) => {
      if (err) {
        const msg = err.message || String(err);
        if (/auth|unauthorized|not.logged.in|login|credential|api.key/i.test(msg)) {
          logger.error('Claude Code CLI authentication check failed — bot dispatch will not work until resolved. Run `claude` to authenticate.');
          console.log('\n  ⚠  Claude Code CLI is not authenticated. Run `claude` to log in.\n');
        } else {
          logger.warn({ msg: msg.slice(0, 300) }, 'Claude Code CLI auth probe returned an error (may not be auth-related)');
        }
      } else {
        logger.info('Claude Code CLI auth probe: OK');
      }
    },
  );
}

// ── 12. Load persisted bot sessions ─────────────────────────────

botSessionManager.loadSessions(PROJECTS_DIR, projects);

logger.info({ version }, 'collabot started');
logger.info({ defaultModel, aliasCount }, 'config loaded');
logger.info({ roleCount, roleNames }, 'roles loaded');
logger.info({ botCount, botNames }, 'bots loaded');
logger.info({ projectCount: projects.size, projectNames: [...projects.values()].map(p => p.name).join(', ') }, 'projects loaded');
if (lobbyEnsured) logger.info('lobby virtual project ensured');
if (virtualProjectMeta.size > 0) logger.info({ count: virtualProjectMeta.size, projects: [...virtualProjectMeta.keys()] }, 'provider virtual projects ensured');
if (placementStore.getAll().size > 0) logger.info({ placements: placementList }, 'bot placements computed');
logger.info({ maxConcurrent: config.pool.maxConcurrent }, 'agent pool initialized');

// ── 13. Start all providers ─────────────────────────────────────

await registry.startAll();

if (slackEnabled) {
  const startedBots = slackAdapter?.getBotNames() ?? [];
  logger.info({ bots: startedBots }, `Slack interface enabled (${startedBots.length} bot${startedBots.length !== 1 ? 's' : ''})`);
} else {
  logger.info('No Slack bots configured — Slack adapter disabled');
}

if (wsEnabled) {
  const ws = registry.get<WsAdapter>('ws');
  if (ws?.isReady()) {
    logger.info({ port: ws.port, host: config.ws!.host }, 'WS interface enabled');
  }
} else {
  logger.info('WS config not found — WS adapter disabled');
}

// ── 14. Set bot presence based on placement ─────────────────────

if (slackAdapter) {
  for (const [botName, placement] of placementStore.getAll()) {
    const presence = placement.project.toLowerCase() === 'slack-room' ? 'auto' : 'away';
    await slackAdapter.setPresence(botName, presence);
  }
}

// ── 15. Start cron (multi-project rotation) ─────────────────────

const cronScheduler = new CronScheduler();

if (botCount > 0 && virtualProjectsWithBots.size > 0) {
  const rotationIntervalMs = (config.slack?.taskRotationIntervalHours ?? 24) * 60 * 60 * 1000;

  cronScheduler.register({
    name: 'task-rotation',
    intervalMs: rotationIntervalMs,
    handler: async () => {
      for (const projectName of virtualProjectsWithBots) {
        if (!projects.has(projectName)) continue;

        const tasksDir = getProjectTasksDir(PROJECTS_DIR, projectName);
        try {
          const open = getOpenTasks(tasksDir);
          for (const task of open) {
            closeTask(tasksDir, task.slug);
            logger.info({ project: projectName, slug: task.slug }, 'task rotation: closed task');
          }

          const today = new Date().toISOString().split('T')[0];
          const newTask = createTask(tasksDir, {
            name: `session-${today}`,
            project: projectName,
            description: `Bot session task for ${today}`,
          });
          projectTasks.set(projectName, newTask);
          logger.info({ project: projectName, slug: newTask.slug }, 'task rotation: created new task');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ project: projectName, msg }, 'task rotation error');
        }
      }
    },
  });
}

if (cronScheduler.list().length > 0) {
  cronScheduler.startAll();
  logger.info({ jobs: cronScheduler.list() }, 'cron scheduler started');
}

// ── 16. Register inbound handler ────────────────────────────────

const inboundHandler: InboundHandler = async (msg) => {
  const result = await handleTask(msg, registry, roles, config, pool, mcpServers, projects, PROJECTS_DIR);
  return {
    status: result.status === 'completed' ? 'completed' as const : result.status === 'aborted' ? 'aborted' as const : 'crashed' as const,
    summary: result.structuredResult?.summary ?? result.result?.slice(0, 200),
  };
};
for (const provider of registry.providers()) {
  provider.onInbound(inboundHandler);
}

// ── Heartbeat + Shutdown ────────────────────────────────────────

let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
if (logTier === 'verbose') {
  heartbeatInterval = setInterval(() => {
    logger.debug({ uptime_s: Math.floor(process.uptime()), agents_active: pool.size, agents_total: 0 }, 'heartbeat');
  }, 60_000);
}

async function shutdown(): Promise<void> {
  logger.info('shutting down');
  cronScheduler.stopAll();
  if (heartbeatInterval !== undefined) {
    clearInterval(heartbeatInterval);
  }
  await registry.stopAll();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
