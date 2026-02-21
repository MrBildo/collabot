import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { loadRoles } from './roles.js';
import { handleTask, draftAgent } from './core.js';
import { buildTaskContext } from './context.js';
import { CliAdapter } from './adapters/cli.js';
import { AgentPool } from './pool.js';
import { createHarnessServer, DispatchTracker } from './mcp.js';
import type { DraftAgentFn } from './mcp.js';
import type { InboundMessage } from './comms.js';

const HUB_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TASKS_DIR = path.join(HUB_ROOT, '.agents', 'tasks');

const { values, positionals } = parseArgs({
  options: {
    role: { type: 'string', short: 'r' },
    cwd: { type: 'string' },
    task: { type: 'string', short: 't' },
    'list-tasks': { type: 'boolean' },
  },
  allowPositionals: true,
  strict: false,
});

const role = values['role'] as string | undefined;
const cwdOverride = values['cwd'] as string | undefined;
const taskSlug = values['task'] as string | undefined;
const listTasks = values['list-tasks'] as boolean | undefined;

// --list-tasks: show task inventory and exit
if (listTasks) {
  if (!fs.existsSync(TASKS_DIR)) {
    console.log('No tasks found.');
    process.exit(0);
  }

  const dirs = fs.readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  if (dirs.length === 0) {
    console.log('No tasks found.');
    process.exit(0);
  }

  console.log('Tasks:\n');
  for (const dir of dirs) {
    const manifestPath = path.join(TASKS_DIR, dir.name, 'task.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const desc = manifest.description
        ? manifest.description.slice(0, 60) + (manifest.description.length > 60 ? '...' : '')
        : '(no description)';
      const dispatches = Array.isArray(manifest.dispatches) ? manifest.dispatches.length : 0;
      console.log(`  ${manifest.slug}`);
      console.log(`    Created: ${manifest.created}`);
      console.log(`    Description: ${desc}`);
      console.log(`    Dispatches: ${dispatches}`);
      console.log('');
    } catch {
      // Skip corrupt manifests
    }
  }
  process.exit(0);
}

if (!role) {
  console.error('Usage: npm run cli -- --role <role> [--cwd <path>] [--task <slug>] "prompt"');
  console.error('       npm run cli -- --list-tasks');
  console.error('');
  console.error('  --role, -r       Role name (required for dispatch)');
  console.error('  --cwd            Working directory override (optional, falls back to role default)');
  console.error('  --task, -t       Attach to existing task by slug (context reconstruction)');
  console.error('  --list-tasks     List existing tasks and exit');
  process.exit(1);
}

const prompt = positionals.join(' ').trim();
if (!prompt) {
  console.error('Error: No prompt provided. Pass the prompt as a positional argument.');
  console.error('Usage: npm run cli -- --role <role> "Your prompt here"');
  process.exit(1);
}

// Load config
let config;
try {
  config = loadConfig();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error({ msg }, 'config load failed');
  process.exit(1);
}

// Load roles
const rolesDir = fileURLToPath(new URL('../roles', import.meta.url));
let roles;
try {
  roles = loadRoles(rolesDir);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error({ msg }, 'roles load failed');
  process.exit(1);
}

// Validate role exists
if (!roles.has(role)) {
  const available = [...roles.keys()].join(', ');
  console.error(`Error: Unknown role "${role}". Available: ${available}`);
  process.exit(1);
}

// If --task provided, validate it exists and prepend context
let finalPrompt = prompt;
if (taskSlug) {
  const taskDir = path.join(TASKS_DIR, taskSlug);
  const manifestPath = path.join(taskDir, 'task.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`Error: Task "${taskSlug}" not found.`);
    console.error(`  Expected: ${taskDir}/task.json`);
    console.error('  Use --list-tasks to see available tasks.');
    process.exit(1);
  }

  const taskContext = buildTaskContext(taskDir);
  finalPrompt = taskContext + '\n---\n\n' + prompt;
  logger.info({ taskSlug }, 'attached to existing task with context reconstruction');
}

// Build InboundMessage
const metadata: Record<string, unknown> = {};
if (cwdOverride) metadata['cwdOverride'] = cwdOverride;
if (taskSlug) metadata['taskSlug'] = taskSlug;

const message: InboundMessage = {
  id: `cli-${Date.now()}`,
  content: finalPrompt,
  threadId: taskSlug ?? `cli-${Date.now()}`,
  source: 'cli',
  role,
  metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
};

const adapter = new CliAdapter();
const pool = new AgentPool(config.pool.maxConcurrent);

// Create MCP servers — shared tracker and draftFn for lifecycle tools
const tracker = new DispatchTracker();
const draftFn: DraftAgentFn = async (roleName, taskContext, opts) => {
  return draftAgent(roleName, taskContext, adapter, roles, config, {
    taskSlug: opts?.taskSlug,
    taskDir: opts?.taskDir,
    pool,
  });
};

const mcpServers = {
  createFull: (parentTaskSlug: string, parentTaskDir: string) => createHarnessServer({
    pool, tasksDir: TASKS_DIR, roles, tools: 'full',
    tracker, draftFn,
    parentTaskSlug, parentTaskDir,
  }),
  readonly: createHarnessServer({
    pool, tasksDir: TASKS_DIR, roles, tools: 'readonly',
  }),
};

logger.info({ role, taskSlug, prompt: prompt.slice(0, 80) }, 'CLI dispatch starting');

try {
  const result = await handleTask(message, adapter, roles, config, pool, mcpServers);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'completed' || result.status === 'aborted' ? 0 : 1);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error({ err: msg }, 'CLI dispatch failed');
  process.exit(1);
}
