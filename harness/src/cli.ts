import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { logger, applyConfigLogLevel } from './logger.js';
import { loadConfig } from './config.js';
import { loadRoles } from './roles.js';
import { loadProjects, getProject, getProjectTasksDir } from './project.js';
import { handleTask, draftAgent } from './core.js';
import { buildTaskContext } from './context.js';
import { listTasks } from './task.js';
import { CliAdapter } from './adapters/cli.js';
import { AgentPool } from './pool.js';
import { createHarnessServer, DispatchTracker } from './mcp.js';
import { scaffoldEntity, validateEntityFrontmatter, validateLinks } from './entity-tools.js';
import { getInstancePath } from './paths.js';
import type { EntityType } from './entity-tools.js';
import type { DraftAgentFn } from './mcp.js';
import type { InboundMessage } from './comms.js';

const PROJECTS_DIR = getInstancePath('.projects');

const { values, positionals } = parseArgs({
  options: {
    role: { type: 'string', short: 'r' },
    project: { type: 'string', short: 'p' },
    cwd: { type: 'string' },
    task: { type: 'string', short: 't' },
    'list-tasks': { type: 'boolean' },
    'list-projects': { type: 'boolean' },
  },
  allowPositionals: true,
  strict: false,
});

const role = values['role'] as string | undefined;
const projectName = values['project'] as string | undefined;
const cwdOverride = values['cwd'] as string | undefined;
const taskSlug = values['task'] as string | undefined;
const showListTasks = values['list-tasks'] as boolean | undefined;
const showListProjects = values['list-projects'] as boolean | undefined;

// --- Entity subcommands (no config/roles/projects needed) ---
if (positionals[0] === 'entity') {
  const sub = positionals[1];

  if (sub === 'scaffold') {
    const entityType = positionals[2] as EntityType | undefined;
    const entityName = positionals[3];
    const author = positionals[4];

    if (!entityType || !entityName || !author) {
      console.error('Usage: npm run cli -- entity scaffold <type> <name> "<author>"');
      console.error('  type: role');
      console.error('  Example: npm run cli -- entity scaffold role my-role "Bill Wheelock"');
      process.exit(1);
    }

    try {
      const result = scaffoldEntity(entityType, entityName, author);
      const rolesDir = getInstancePath('roles');
      const outPath = path.join(rolesDir, result.filePath);

      if (fs.existsSync(outPath)) {
        console.error(`Error: File already exists: ${outPath}`);
        process.exit(1);
      }

      fs.writeFileSync(outPath, result.content, 'utf8');
      console.log(`Scaffolded ${entityType}: ${outPath}`);
      console.log(`  ID: ${result.id}`);
      console.log(`  Name: ${entityName}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (sub === 'validate') {
    const filePath = positionals[2];
    const entityType = (positionals[3] ?? 'role') as EntityType;

    if (!filePath) {
      console.error('Usage: npm run cli -- entity validate <file> [type]');
      console.error('  type defaults to "role"');
      process.exit(1);
    }

    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      console.error(`Error: File not found: ${resolved}`);
      process.exit(1);
    }

    const content = fs.readFileSync(resolved, 'utf8');
    const fmResult = validateEntityFrontmatter(content, entityType);

    if (!fmResult.valid) {
      console.error('Frontmatter validation failed:');
      for (const err of fmResult.errors ?? []) {
        console.error(`  - ${err}`);
      }
    }

    const linkResult = validateLinks(content, path.dirname(resolved));
    if (!linkResult.valid) {
      console.error('Broken links:');
      for (const link of linkResult.broken ?? []) {
        console.error(`  - ${link}`);
      }
    }

    if (fmResult.valid && linkResult.valid) {
      console.log('Valid.');
    } else {
      process.exit(1);
    }
    process.exit(0);
  }

  console.error(`Unknown entity command: ${sub}`);
  console.error('Available: scaffold, validate');
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

applyConfigLogLevel(config.logging.level);

// Load roles
const rolesDir = getInstancePath('roles');
let roles;
try {
  roles = loadRoles(rolesDir);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error({ msg }, 'roles load failed');
  process.exit(1);
}

// Load projects
let projects;
try {
  projects = loadProjects(PROJECTS_DIR, roles);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error({ msg }, 'project load failed');
  process.exit(1);
}

// --list-projects: show projects and exit
if (showListProjects) {
  if (projects.size === 0) {
    console.log('No projects found.');
    process.exit(0);
  }
  console.log('Projects:\n');
  for (const p of projects.values()) {
    console.log(`  ${p.name}`);
    console.log(`    ${p.description}`);
    console.log(`    Paths: ${p.paths.join(', ')}`);
    console.log(`    Roles: ${p.roles.join(', ')}`);
    console.log('');
  }
  process.exit(0);
}

// --list-tasks: show task inventory and exit
if (showListTasks) {
  if (!projectName) {
    console.error('Error: --project is required with --list-tasks');
    process.exit(1);
  }

  let project;
  try {
    project = getProject(projects, projectName);
  } catch {
    console.error(`Error: Project "${projectName}" not found.`);
    process.exit(1);
  }

  const tasksDir = getProjectTasksDir(PROJECTS_DIR, project.name);
  const tasks = listTasks(tasksDir);

  if (tasks.length === 0) {
    console.log(`No tasks found for project "${project.name}".`);
    process.exit(0);
  }

  console.log(`Tasks for ${project.name}:\n`);
  for (const t of tasks) {
    const desc = t.description
      ? t.description.slice(0, 60) + (t.description.length > 60 ? '...' : '')
      : '(no description)';
    console.log(`  ${t.slug} [${t.status}]`);
    console.log(`    Created: ${t.created}`);
    console.log(`    Name: ${t.name}`);
    console.log(`    Description: ${desc}`);
    console.log(`    Dispatches: ${t.dispatchCount}`);
    console.log('');
  }
  process.exit(0);
}

if (!role || !projectName) {
  console.error('Usage: npm run cli -- --project <name> --role <role> [--cwd <path>] [--task <slug>] "prompt"');
  console.error('       npm run cli -- --list-projects');
  console.error('       npm run cli -- --project <name> --list-tasks');
  console.error('');
  console.error('  --project, -p    Project name (required)');
  console.error('  --role, -r       Role name (required for dispatch)');
  console.error('  --cwd            Working directory override (optional, falls back to project path)');
  console.error('  --task, -t       Attach to existing task by slug (context reconstruction)');
  console.error('  --list-tasks     List existing tasks for the project');
  console.error('  --list-projects  List all projects');
  process.exit(1);
}

const prompt = positionals.join(' ').trim();
if (!prompt) {
  console.error('Error: No prompt provided. Pass the prompt as a positional argument.');
  console.error('Usage: npm run cli -- --project <name> --role <role> "Your prompt here"');
  process.exit(1);
}

// Validate project and role
let project;
try {
  project = getProject(projects, projectName);
} catch {
  console.error(`Error: Project "${projectName}" not found.`);
  const available = [...projects.values()].map((p) => p.name).join(', ');
  if (available) console.error(`  Available: ${available}`);
  process.exit(1);
}

if (!roles.has(role)) {
  const available = [...roles.keys()].join(', ');
  console.error(`Error: Unknown role "${role}". Available: ${available}`);
  process.exit(1);
}

// If --task provided, validate it exists and prepend context
let finalPrompt = prompt;
const tasksDir = getProjectTasksDir(PROJECTS_DIR, project.name);
if (taskSlug) {
  const taskDir = path.join(tasksDir, taskSlug);
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
  project: project.name,
  role,
  metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
};

const adapter = new CliAdapter();
const pool = new AgentPool(config.pool.maxConcurrent);

// Create MCP servers
const tracker = new DispatchTracker();
const draftFn: DraftAgentFn = async (roleName, taskContext, opts) => {
  return draftAgent(roleName, taskContext, adapter, roles, config, {
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

logger.info({ role, project: project.name, taskSlug, prompt: prompt.slice(0, 80) }, 'CLI dispatch starting');

try {
  const result = await handleTask(message, adapter, roles, config, pool, mcpServers, projects, PROJECTS_DIR);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'completed' || result.status === 'aborted' ? 0 : 1);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error({ err: msg }, 'CLI dispatch failed');
  process.exit(1);
}
