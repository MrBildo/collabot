import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger, logTier } from './logger.js';
import { startSlackApp } from './slack.js';
import { loadConfig, resolveModelId } from './config.js';
import { loadRoles, ModelHintEnum, PermissionsEnum } from './roles.js';
import { loadProjects } from './project.js';
import { watchJournals } from './journal.js';
import { AgentPool } from './pool.js';
import { draftAgent, handleTask } from './core.js';
import { createHarnessServer, DispatchTracker } from './mcp.js';
import { CliAdapter } from './adapters/cli.js';
import { WsAdapter } from './adapters/ws.js';
import { registerWsMethods } from './ws-methods.js';
import { loadActiveDraft } from './draft.js';
import type { DraftAgentFn } from './mcp.js';
import type { FSWatcher } from 'chokidar';
import type { App } from '@slack/bolt';

// Read version from package.json (adjacent to src/)
const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
const version = pkg.version;

// Platform root: harness/src/index.ts → ../../ = collabot root
const HUB_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PROJECTS_DIR = path.join(HUB_ROOT, '.projects');

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

const defaultModel = config.models.default;
const aliasCount = Object.keys(config.models.aliases).length;

// Load roles (fail fast before any connections)
const rolesDir = fileURLToPath(new URL('../roles', import.meta.url));
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
let projects;
try {
  projects = loadProjects(PROJECTS_DIR, roles);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log('\n  Collabot — project load failed\n');
  logger.error({ msg }, 'project load failed');
  process.exit(1);
}

const projectCount = projects.size;
const projectNames = [...projects.values()].map((p) => p.name).join(', ');

// Initialize agent pool
const pool = new AgentPool(config.pool.maxConcurrent);

// Initialize MCP servers — shared tracker and draftFn for lifecycle tools
const tracker = new DispatchTracker();
// draftFn wraps core.draftAgent with a headless adapter for MCP-initiated dispatches
const headlessAdapter = new CliAdapter();
const draftFn: DraftAgentFn = async (roleName, taskContext, opts) => {
  return draftAgent(roleName, taskContext, headlessAdapter, roles, config, {
    taskSlug: opts?.taskSlug,
    taskDir: opts?.taskDir,
    cwd: opts?.cwd,
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

// Detect interface mode
const { SLACK_BOT_TOKEN, SLACK_APP_TOKEN } = process.env;
const slackEnabled = !!(SLACK_BOT_TOKEN && SLACK_APP_TOKEN);
const wsEnabled = !!config.ws;

// Startup banner — printed before any pino output
const interfaceList = [
  slackEnabled ? 'Slack' : null,
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
  `  pool: maxConcurrent=${config.pool.maxConcurrent || 'unlimited'}`,
  `  mcp: streamTimeout=${config.mcp.streamTimeout}ms`,
  `  interfaces: ${interfaceList}`,
  '',
].join('\n'));

// Recover active draft session (if harness was restarted mid-draft)
const recoveredDraft = loadActiveDraft(projects, PROJECTS_DIR, pool);
if (recoveredDraft) {
  console.log(`  draft: recovered (${recoveredDraft.role}, ${recoveredDraft.turnCount} turns)\n`);
}

logger.info({ defaultModel, aliasCount }, 'config loaded');
logger.info({ roleCount, roleNames }, 'roles loaded');
logger.info({ projectCount, projectNames }, 'projects loaded');
logger.info({ maxConcurrent: config.pool.maxConcurrent }, 'agent pool initialized');

// Conditional Slack startup
let app: App | undefined;
if (slackEnabled) {
  app = await startSlackApp(SLACK_BOT_TOKEN!, SLACK_APP_TOKEN!, roles, config, mcpServers);
  logger.info('Slack interface enabled');
} else {
  logger.info('Slack tokens not found — Slack adapter disabled, CLI available');
}

// Conditional WS startup
let wsAdapter: WsAdapter | undefined;
if (wsEnabled) {
  wsAdapter = new WsAdapter({ port: config.ws!.port, host: config.ws!.host });
  registerWsMethods({ wsAdapter, handleTask, roles, config, pool, projects, projectsDir: PROJECTS_DIR, mcpServers });
  pool.setOnChange((agents) => {
    wsAdapter!.broadcastNotification('pool_status', { agents });
  });
  await wsAdapter.start();
  logger.info({ port: wsAdapter.port, host: config.ws!.host }, 'WS interface enabled');
} else {
  logger.info('WS config not found — WS adapter disabled');
}

// Journal watcher — monitors .agents/journals/ in the hub root (debug-level only)
const usePolling = process.env.HARNESS_POLL_JOURNALS === 'true';
const journalsDir = path.join(HUB_ROOT, '.agents', 'journals');
logger.info(`journal watcher started${usePolling ? ' (polling mode)' : ''}`);
const journalWatcher: FSWatcher = watchJournals(
  journalsDir,
  (journalPath, entries) => {
    logger.debug({ journalPath, entries }, 'journal update');
  },
  usePolling,
);

// Heartbeat — debug log every 60s, gated on verbose tier
let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
if (logTier === 'verbose') {
  heartbeatInterval = setInterval(() => {
    logger.debug({ uptime_s: Math.floor(process.uptime()), agents_active: pool.size, agents_total: 0 }, 'heartbeat');
  }, 60_000);
}

async function shutdown(): Promise<void> {
  logger.info('shutting down');
  if (heartbeatInterval !== undefined) {
    clearInterval(heartbeatInterval);
  }
  await journalWatcher.close();
  if (app) {
    await app.stop();
  }
  if (wsAdapter) {
    await wsAdapter.stop();
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
