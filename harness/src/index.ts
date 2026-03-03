import 'dotenv/config';
import { readFileSync } from 'node:fs';
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
import { createTask, getOpenTasks, closeTask } from './task.js';
import { registerWsMethods } from './ws-methods.js';
import { loadActiveDraft } from './draft.js';
import { getInstancePath, getInstanceRoot, getPackagePath } from './paths.js';
import type { InboundHandler } from './comms.js';
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
  createFull: (parentTaskSlug: string, parentTaskDir: string, parentProject?: string) => createHarnessServer({
    pool, projects, projectsDir: PROJECTS_DIR, roles, tools: 'full',
    tracker, draftFn,
    parentTaskSlug, parentTaskDir, parentProject,
  }),
  readonly: createHarnessServer({
    pool, projects, projectsDir: PROJECTS_DIR, roles, tools: 'readonly',
  }),
};

// ── Virtual Projects + Bot Infrastructure ───────────────────────

// Ensure lobby virtual project (uses all loaded roles so bots can use any)
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

// Ensure active task in lobby for bot sessions
function ensureLobbyTask(): { slug: string; taskDir: string } | undefined {
  if (!projects.has('lobby')) return undefined;

  const tasksDir = getProjectTasksDir(PROJECTS_DIR, 'lobby');
  try {
    const open = getOpenTasks(tasksDir);
    if (open.length > 0) {
      return open[0];
    }
    // Create today's session task
    const today = new Date().toISOString().split('T')[0];
    return createTask(tasksDir, {
      name: `session-${today}`,
      project: 'lobby',
      description: `Bot session task for ${today}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ msg }, 'failed to ensure lobby task');
    return undefined;
  }
}

const lobbyTask = botCount > 0 ? ensureLobbyTask() : undefined;

// ── Bot Session Infrastructure ──────────────────────────────────

const botQueue = new BotMessageQueue();
const botSessionManager = new BotSessionManager(config, roles, bots, pool);

// Detect interface modes
const slackBotCount = config.slack ? Object.keys(config.slack.bots).length : 0;
const slackEnabled = slackBotCount > 0;
const wsEnabled = !!config.ws;

// Conditional WS registration
if (wsEnabled) {
  const ws = new WsAdapter({ port: config.ws!.port, host: config.ws!.host });
  registerWsMethods({ wsAdapter: ws, registry, handleTask, roles, config, pool, projects, projectsDir: PROJECTS_DIR, mcpServers });
  pool.setOnChange((agents) => {
    ws.broadcastNotification('pool_status', { agents });
  });
  registry.register(ws);
}

// Conditional Slack registration (multi-bot)
let slackAdapter: SlackAdapter | undefined;
if (slackEnabled && config.slack) {
  // Validate each bot config before creating adapter (credentials only — role is in [bots.*])
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

// Wire bot queue handler → bot session manager
botQueue.setHandler(async (msg) => {
  if (!lobbyTask) {
    logger.warn({ botName: msg.botName }, 'No lobby task available — dropping message');
    return;
  }

  // Determine role from [bots.*] config or fallback chain
  const botCfg = config.bots?.[msg.botName];
  const roleName = botCfg?.defaultRole ?? config.slack?.defaultRole ?? config.routing.default;

  // Determine CWD (lobby virtual project uses instance root)
  const lobby = projects.get('lobby');
  const cwd = lobby?.paths[0] ?? getInstanceRoot();

  // Build response sink that posts via the correct Slack bot
  const channel = msg.metadata['channel'] as string;

  const responseSink = async (text: string) => {
    if (slackAdapter) {
      const instance = slackAdapter.getInstance(msg.botName);
      if (instance) {
        try {
          await instance.app.client.chat.postMessage({
            channel,
            text,
          });
        } catch (err) {
          logger.error({ err, botName: msg.botName }, 'failed to post bot response');
        }
      }
    }
  };

  try {
    await botSessionManager.handleBotMessage({
      botName: msg.botName,
      roleName,
      message: msg.content,
      project: 'lobby',
      taskSlug: lobbyTask.slug,
      taskDir: lobbyTask.taskDir,
      cwd,
      responseSink,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, botName: msg.botName }, 'bot session handler error');
    await responseSink(`Something went wrong: ${errMsg.slice(0, 200)}`);
  }
});

// Register inbound handler on all providers
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

// ── Cron Scheduler ──────────────────────────────────────────────

const cronScheduler = new CronScheduler();

if (botCount > 0 && config.slack) {
  const rotationIntervalMs = (config.slack.taskRotationIntervalHours ?? 24) * 60 * 60 * 1000;

  cronScheduler.register({
    name: 'task-rotation',
    intervalMs: rotationIntervalMs,
    handler: async () => {
      if (!projects.has('lobby')) return;

      const tasksDir = getProjectTasksDir(PROJECTS_DIR, 'lobby');
      try {
        // Close all open tasks
        const open = getOpenTasks(tasksDir);
        for (const task of open) {
          closeTask(tasksDir, task.slug);
          logger.info({ slug: task.slug }, 'task rotation: closed task');
        }

        // Create new session task
        const today = new Date().toISOString().split('T')[0];
        const newTask = createTask(tasksDir, {
          name: `session-${today}`,
          project: 'lobby',
          description: `Bot session task for ${today}`,
        });
        logger.info({ slug: newTask.slug }, 'task rotation: created new task');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ msg }, 'task rotation error');
      }
    },
  });
}

// Startup banner — printed before any pino output
const slackBotsList = slackAdapter ? slackAdapter.getBotNames().join(', ') || 'pending' : '';
const interfaceList = [
  slackEnabled ? `Slack (${slackBotCount} bot${slackBotCount !== 1 ? 's' : ''})` : null,
  'CLI',
  wsEnabled ? `WS (${config.ws!.host}:${config.ws!.port})` : null,
].filter(Boolean).join(', ');

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
  `  projects: ${projectCount} (${projectNames || 'none'})`,
  `  roles: ${roleCount} (${roleNames})`,
  `  bots: ${botCount} (${botNames || 'none'})`,
  `  pool: maxConcurrent=${config.pool.maxConcurrent || 'unlimited'}`,
  `  mcp: streamTimeout=${config.mcp.streamTimeout}ms`,
  `  interfaces: ${interfaceList}`,
  '',
].join('\n'));

// Recover active draft session (if harness was restarted mid-draft)
const recoveredDraft = loadActiveDraft(projects, PROJECTS_DIR, pool, roles);
if (recoveredDraft) {
  if (recoveredDraft.staleRole) {
    console.log(`  draft: recovered (${recoveredDraft.role}, ${recoveredDraft.turnCount} turns) — WARNING: role no longer exists\n`);
  } else {
    console.log(`  draft: recovered (${recoveredDraft.role}, ${recoveredDraft.turnCount} turns)\n`);
  }
}

logger.info({ version }, 'collabot started');
logger.info({ defaultModel, aliasCount }, 'config loaded');
logger.info({ roleCount, roleNames }, 'roles loaded');
logger.info({ botCount, botNames }, 'bots loaded');
logger.info({ projectCount, projectNames }, 'projects loaded');
if (lobbyEnsured) logger.info('lobby virtual project ensured');
logger.info({ maxConcurrent: config.pool.maxConcurrent }, 'agent pool initialized');

// Load persisted bot sessions (after banner so recovery logs don't precede it)
botSessionManager.loadSessions(PROJECTS_DIR, projects);

// Start all providers (best-effort — failures logged, provider stays not-ready)
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

// Start cron scheduler (after providers so task rotation doesn't fire before Slack is ready)
if (cronScheduler.list().length > 0) {
  cronScheduler.startAll();
  logger.info({ jobs: cronScheduler.list() }, 'cron scheduler started');
}

// Heartbeat — debug log every 60s, gated on verbose tier
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
