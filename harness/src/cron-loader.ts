import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { ulid } from 'ulid';
import { logger } from './logger.js';
import { parseFrontmatter } from './roles.js';
import { getInstancePath } from './paths.js';
import type { Config } from './config.js';

// ── Job Frontmatter Schema ──────────────────────────────────

const BaseJobFrontmatterSchema = z.object({
  id: z.string().length(26).optional(), // ULID — auto-generated if missing
  name: z.string().min(1).max(64),
  schedule: z.string().min(1),          // cron expr, "every Xm", "at ISO"
  enabled: z.boolean().default(true),
  singleton: z.boolean().default(true),
  handler: z.boolean().optional(),

  // Entity references
  bot: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  project: z.string().min(1).optional(),

  // Constraints
  tokenBudget: z.number().int().nonnegative().optional(),
  maxTurns: z.number().int().nonnegative().optional(),
  maxBudgetUsd: z.number().nonnegative().optional(),
});

const AgentJobFrontmatterSchema = BaseJobFrontmatterSchema.extend({
  handler: z.literal(undefined).optional(),
  role: z.string().min(1),    // required for agent jobs
  project: z.string().min(1), // required for agent jobs
});

const HandlerJobFrontmatterSchema = BaseJobFrontmatterSchema.extend({
  handler: z.literal(true),
  // role + project optional for handlers (may vary per ctx.dispatch() call)
});

// ── Job Definition Types ────────────────────────────────────

export type AgentJobDefinition = {
  type: 'agent';
  id: string;
  name: string;
  slug: string;             // folder name
  schedule: string;
  enabled: boolean;
  singleton: boolean;
  bot?: string;
  role: string;
  project: string;
  prompt: string;           // markdown body
  tokenBudget?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  jobDir: string;           // absolute path to job folder
};

export type HandlerJobDefinition = {
  type: 'handler';
  id: string;
  name: string;
  slug: string;
  schedule: string;
  enabled: boolean;
  singleton: boolean;
  bot?: string;
  role?: string;
  project?: string;
  tokenBudget?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  jobDir: string;
  handlerPath: string;      // absolute path to handler.ts
  settings: Record<string, unknown>; // parsed settings.toml
};

export type CronJobDefinition = AgentJobDefinition | HandlerJobDefinition;

// ── Loader ──────────────────────────────────────────────────

/**
 * Load all cron job definitions from the configured directory.
 * Scans for subdirectories containing job.md, parses frontmatter,
 * validates, and returns typed definitions.
 */
export function loadCronJobs(config: Config): CronJobDefinition[] {
  const cronConfig = config.cron;
  if (!cronConfig?.enabled) {
    logger.info('cron disabled in config');
    return [];
  }

  const jobsDir = getInstancePath(cronConfig.jobsDirectory);
  if (!fs.existsSync(jobsDir)) {
    logger.debug({ jobsDir }, 'cron jobs directory does not exist — no jobs to load');
    return [];
  }

  const entries = fs.readdirSync(jobsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'runs');

  const jobs: CronJobDefinition[] = [];

  for (const entry of entries) {
    const jobDir = path.join(jobsDir, entry.name);
    const jobMdPath = path.join(jobDir, 'job.md');

    if (!fs.existsSync(jobMdPath)) {
      logger.warn({ folder: entry.name }, 'cron job folder missing job.md — skipping');
      continue;
    }

    try {
      const job = parseJobFolder(jobDir, entry.name);
      jobs.push(job);
      logger.info({ name: job.name, type: job.type, schedule: job.schedule }, 'cron job loaded');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ folder: entry.name, error: msg }, 'failed to load cron job — skipping');
    }
  }

  return jobs;
}

/**
 * Parse a single job folder into a CronJobDefinition.
 */
export function parseJobFolder(jobDir: string, slug: string): CronJobDefinition {
  const jobMdPath = path.join(jobDir, 'job.md');
  const content = fs.readFileSync(jobMdPath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(content, `${slug}/job.md`);

  const isHandler = typeof frontmatter === 'object' && frontmatter !== null
    && (frontmatter as Record<string, unknown>).handler === true;

  if (isHandler) {
    return parseHandlerJob(frontmatter, body, jobDir, slug);
  }

  return parseAgentJob(frontmatter, body, jobDir, slug);
}

function parseAgentJob(
  frontmatter: unknown,
  body: string,
  jobDir: string,
  slug: string,
): AgentJobDefinition {
  const result = AgentJobFrontmatterSchema.safeParse(frontmatter);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`${slug}/job.md: invalid agent job frontmatter:\n${issues}`);
  }

  const fm = result.data;
  const prompt = body.trim();
  if (!prompt) {
    throw new Error(`${slug}/job.md: agent job must have a prompt body`);
  }

  return {
    type: 'agent',
    id: fm.id ?? ulid(),
    name: fm.name,
    slug,
    schedule: fm.schedule,
    enabled: fm.enabled,
    singleton: fm.singleton,
    bot: fm.bot,
    role: fm.role,
    project: fm.project,
    prompt,
    tokenBudget: fm.tokenBudget,
    maxTurns: fm.maxTurns,
    maxBudgetUsd: fm.maxBudgetUsd,
    jobDir,
  };
}

function parseHandlerJob(
  frontmatter: unknown,
  _body: string,
  jobDir: string,
  slug: string,
): HandlerJobDefinition {
  const result = HandlerJobFrontmatterSchema.safeParse(frontmatter);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`${slug}/job.md: invalid handler job frontmatter:\n${issues}`);
  }

  const fm = result.data;

  // Handler file must exist
  const handlerPath = path.join(jobDir, 'handler.ts');
  if (!fs.existsSync(handlerPath)) {
    throw new Error(`${slug}: handler: true but handler.ts not found`);
  }

  // Load optional settings.toml
  let settings: Record<string, unknown> = {};
  const settingsPath = path.join(jobDir, 'settings.toml');
  if (fs.existsSync(settingsPath)) {
    try {
      const tomlContent = fs.readFileSync(settingsPath, 'utf-8');
      settings = parseToml(tomlContent) as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${slug}/settings.toml: failed to parse: ${msg}`);
    }
  }

  return {
    type: 'handler',
    id: fm.id ?? ulid(),
    name: fm.name,
    slug,
    schedule: fm.schedule,
    enabled: fm.enabled,
    singleton: fm.singleton,
    bot: fm.bot,
    role: fm.role,
    project: fm.project,
    tokenBudget: fm.tokenBudget,
    maxTurns: fm.maxTurns,
    maxBudgetUsd: fm.maxBudgetUsd,
    jobDir,
    handlerPath,
    settings,
  };
}

/**
 * Dynamically import a handler module with cache-busting.
 * Node caches modules on import() — appending a query string forces re-import.
 */
export async function loadHandler(
  handlerPath: string,
): Promise<(ctx: unknown) => Promise<void>> {
  const fileUrl = `file://${handlerPath.replace(/\\/g, '/')}?t=${Date.now()}`;
  const mod = await import(fileUrl) as Record<string, unknown>;

  if (typeof mod.default !== 'function') {
    throw new Error(`Handler at ${handlerPath} must export a default async function`);
  }

  return mod.default as (ctx: unknown) => Promise<void>;
}
