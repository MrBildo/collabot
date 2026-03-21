import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import { collabDispatch, type CollabDispatchContext } from './collab-dispatch.js';
import { loadHandler, type CronJobDefinition, type AgentJobDefinition, type HandlerJobDefinition } from './cron-loader.js';
import type { CollabDispatchResult } from './types.js';
import type { Config } from './config.js';

// ── CronHandlerContext ──────────────────────────────────────

export type ConfigResolver = {
  /** This job's settings.toml (from job folder) */
  job: Record<string, unknown>;
  /** Harness-level config (from config.toml) */
  harness: Config;
  /** Read a project's .agents.env as key-value pairs */
  projectEnv(project: string): Record<string, string>;
};

export type RunLogEntry = {
  runAt: string;          // ISO 8601
  duration_ms: number;
  status: 'completed' | 'failed';
  dispatchCount: number;
  totalCostUsd: number;
  taskSlugs: string[];
  error?: string;
};

export type CronHandlerContext = {
  config: ConfigResolver;
  job: CronJobDefinition;
  lastRunAt: Date | null;
  dispatch(options: {
    project: string;
    role: string;
    prompt: string;
    bot?: string;
    mcpServers?: string[];
  }): Promise<CollabDispatchResult>;
  getRunLog(limit?: number): RunLogEntry[];
  signal: AbortSignal;
  log: typeof logger;
};

// ── Bridge ──────────────────────────────────────────────────

export type CronBridgeOptions = {
  ctx: CollabDispatchContext;
  runsDir: string;           // COLLABOT_HOME/cron/runs/
  projectsDir: string;       // COLLABOT_HOME/.projects/
  getLastRunAt?: (jobName: string) => string | null;
};

/**
 * Build an execution handler for a cron job definition.
 * Returns a function suitable for registering with CronScheduler.
 */
export function buildJobHandler(
  def: CronJobDefinition,
  options: CronBridgeOptions,
): () => Promise<void> {
  if (def.type === 'agent') {
    return buildAgentJobHandler(def, options);
  }
  return buildHandlerJobHandler(def, options);
}

// ── Agent Job Path ──────────────────────────────────────────

function buildAgentJobHandler(
  def: AgentJobDefinition,
  { ctx, runsDir }: CronBridgeOptions,
): () => Promise<void> {
  return async () => {
    const startTime = Date.now();
    logger.info({ jobName: def.name, role: def.role, project: def.project }, 'cron agent job firing');

    try {
      const result = await collabDispatch({
        project: def.project,
        role: def.role,
        bot: def.bot,
        prompt: def.prompt,
        tokenBudget: def.tokenBudget,
        maxTurns: def.maxTurns,
        maxBudgetUsd: def.maxBudgetUsd,
      }, ctx);

      appendRunLog(runsDir, def.name, {
        runAt: new Date(startTime).toISOString(),
        duration_ms: Date.now() - startTime,
        status: result.status === 'completed' ? 'completed' : 'failed',
        dispatchCount: 1,
        totalCostUsd: result.cost.totalUsd,
        taskSlugs: [result.taskSlug],
        ...(result.status !== 'completed' ? { error: result.result ?? result.status } : {}),
      });

      logger.info({
        jobName: def.name,
        status: result.status,
        cost: result.cost.totalUsd,
        duration_ms: Date.now() - startTime,
      }, 'cron agent job completed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendRunLog(runsDir, def.name, {
        runAt: new Date(startTime).toISOString(),
        duration_ms: Date.now() - startTime,
        status: 'failed',
        dispatchCount: 0,
        totalCostUsd: 0,
        taskSlugs: [],
        error: msg,
      });
      throw err;
    }
  };
}

// ── Handler Job Path ────────────────────────────────────────

function buildHandlerJobHandler(
  def: HandlerJobDefinition,
  { ctx, runsDir, projectsDir, getLastRunAt }: CronBridgeOptions,
): () => Promise<void> {
  return async () => {
    const startTime = Date.now();
    const dispatchResults: CollabDispatchResult[] = [];
    const abortController = new AbortController();

    logger.info({ jobName: def.name }, 'cron handler job firing');

    // Build ConfigResolver
    const configResolver: ConfigResolver = {
      job: def.settings,
      harness: ctx.config,
      projectEnv(project: string): Record<string, string> {
        const envPath = path.join(projectsDir, project.toLowerCase(), '.agents.env');
        if (!fs.existsSync(envPath)) return {};
        try {
          const content = fs.readFileSync(envPath, 'utf-8');
          const env: Record<string, string> = {};
          for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx === -1) continue;
            env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
          }
          return env;
        } catch { /* .agents.env read is best-effort */
          return {};
        }
      },
    };

    // Resolve lastRunAt from scheduler state
    const lastRunAtStr = getLastRunAt?.(def.name) ?? null;
    const lastRunAt = lastRunAtStr ? new Date(lastRunAtStr) : null;

    // Build CronHandlerContext
    const handlerCtx: CronHandlerContext = {
      config: configResolver,
      job: def,
      lastRunAt,
      async dispatch(opts) {
        const result = await collabDispatch({
          project: opts.project,
          role: opts.role,
          prompt: opts.prompt,
          bot: opts.bot ?? def.bot,
          tokenBudget: def.tokenBudget,
          maxTurns: def.maxTurns,
          maxBudgetUsd: def.maxBudgetUsd,
          abortController,
        }, ctx);
        dispatchResults.push(result);
        return result;
      },
      getRunLog(limit = 20): RunLogEntry[] {
        return readRunLog(runsDir, def.name, limit);
      },
      signal: abortController.signal,
      log: logger,
    };

    try {
      const handler = await loadHandler(def.handlerPath);
      await handler(handlerCtx);

      const totalCost = dispatchResults.reduce((sum, r) => sum + r.cost.totalUsd, 0);
      const taskSlugs = dispatchResults.map(r => r.taskSlug);

      appendRunLog(runsDir, def.name, {
        runAt: new Date(startTime).toISOString(),
        duration_ms: Date.now() - startTime,
        status: 'completed',
        dispatchCount: dispatchResults.length,
        totalCostUsd: totalCost,
        taskSlugs,
      });

      logger.info({
        jobName: def.name,
        dispatchCount: dispatchResults.length,
        totalCost,
        duration_ms: Date.now() - startTime,
      }, 'cron handler job completed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendRunLog(runsDir, def.name, {
        runAt: new Date(startTime).toISOString(),
        duration_ms: Date.now() - startTime,
        status: 'failed',
        dispatchCount: dispatchResults.length,
        totalCostUsd: dispatchResults.reduce((sum, r) => sum + r.cost.totalUsd, 0),
        taskSlugs: dispatchResults.map(r => r.taskSlug),
        error: msg,
      });
      throw err;
    }
  };
}

// ── Run Log Persistence ─────────────────────────────────────

const MAX_RUN_LOG_ENTRIES = 100;

function getRunLogPath(runsDir: string, jobName: string): string {
  return path.join(runsDir, `${jobName}.jsonl`);
}

function appendRunLog(runsDir: string, jobName: string, entry: RunLogEntry): void {
  try {
    fs.mkdirSync(runsDir, { recursive: true });
    const logPath = getRunLogPath(runsDir, jobName);
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');

    // Rotate: keep last MAX_RUN_LOG_ENTRIES
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    if (lines.length > MAX_RUN_LOG_ENTRIES) {
      const trimmed = lines.slice(lines.length - MAX_RUN_LOG_ENTRIES);
      fs.writeFileSync(logPath, trimmed.join('\n') + '\n', 'utf-8');
    }
  } catch {
    /* run log persistence is best-effort */
  }
}

function readRunLog(runsDir: string, jobName: string, limit: number): RunLogEntry[] {
  const logPath = getRunLogPath(runsDir, jobName);
  if (!fs.existsSync(logPath)) return [];

  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const entries = lines
      .map(line => {
        try { return JSON.parse(line) as RunLogEntry; }
        catch { return null; }
      })
      .filter((e): e is RunLogEntry => e !== null);
    return entries.slice(-limit);
  } catch {
    return [];
  }
}

export { readRunLog };
