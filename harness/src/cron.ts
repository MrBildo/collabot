import fs from 'node:fs';
import path from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { logger } from './logger.js';
import type { CronJobDefinition } from './cron-loader.js';

// ── Legacy job type (backward-compat for task-rotation until migrated) ──

export type CronJob = {
  name: string;
  intervalMs: number;
  handler: () => Promise<void>;
};

// ── Per-job state ───────────────────────────────────────────

export type CronJobState = {
  name: string;
  status: 'idle' | 'running' | 'paused' | 'disabled';
  lastRunAt: string | null;       // ISO 8601
  nextRunAt: string | null;       // ISO 8601
  runCount: number;
  lastError: string | null;
  consecutiveFailures: number;
};

// ── Schedule types ──────────────────────────────────────────

type ResolvedSchedule =
  | { type: 'cron'; expression: string }
  | { type: 'interval'; ms: number }
  | { type: 'once'; at: Date };

const MIN_INTERVAL_MS = 60_000; // 1 minute minimum

function resolveSchedule(schedule: string): ResolvedSchedule {
  // "every Xm" / "every Xh" / "every Xd"
  const intervalMatch = schedule.match(/^every\s+(\d+)(m|h|d)$/i);
  if (intervalMatch) {
    const val = parseInt(intervalMatch[1]!, 10);
    const unit = intervalMatch[2]!.toLowerCase();
    const ms = unit === 'm' ? val * 60000
      : unit === 'h' ? val * 3600000
      : val * 86400000;
    if (ms < MIN_INTERVAL_MS) {
      throw new Error(`Interval too short: ${schedule} (minimum 1 minute)`);
    }
    return { type: 'interval', ms };
  }

  // "at <ISO 8601 datetime>"
  if (schedule.startsWith('at ')) {
    const dt = new Date(schedule.slice(3).trim());
    if (isNaN(dt.getTime())) {
      throw new Error(`Invalid date in schedule: ${schedule}`);
    }
    return { type: 'once', at: dt };
  }

  // Standard 5-field cron expression
  try {
    CronExpressionParser.parse(schedule);
    return { type: 'cron', expression: schedule };
  } catch {
    throw new Error(`Invalid cron schedule: "${schedule}"`);
  }
}

function getNextFireTime(schedule: ResolvedSchedule): Date | null {
  if (schedule.type === 'cron') {
    const interval = CronExpressionParser.parse(schedule.expression);
    return interval.next().toDate();
  }
  if (schedule.type === 'interval') {
    return new Date(Date.now() + schedule.ms);
  }
  if (schedule.type === 'once') {
    return schedule.at > new Date() ? schedule.at : null;
  }
  return null;
}

// ── Registered job (internal) ───────────────────────────────

type RegisteredJob = {
  definition: CronJobDefinition | null; // null for legacy jobs
  legacyJob: CronJob | null;           // non-null for legacy jobs
  schedule: ResolvedSchedule;
  state: CronJobState;
  handler: () => Promise<void>;
  singleton: boolean;
};

// ── Scheduler ───────────────────────────────────────────────

/**
 * CronScheduler v2 — cron expressions, per-job state, singleton enforcement,
 * pause/resume, and state persistence.
 *
 * Uses a single tick loop (1s interval) that checks each job's next fire time.
 */
export class CronScheduler {
  private jobs = new Map<string, RegisteredJob>();
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private legacyTimers = new Map<string, ReturnType<typeof setInterval>>();
  private statePath: string | undefined;

  constructor(statePath?: string) {
    this.statePath = statePath;
  }

  /**
   * Register a legacy CronJob (interval-based). For backward compatibility.
   */
  register(job: CronJob): void {
    if (this.jobs.has(job.name)) {
      throw new Error(`Cron job "${job.name}" already registered`);
    }

    const schedule: ResolvedSchedule = { type: 'interval', ms: job.intervalMs };

    this.jobs.set(job.name, {
      definition: null,
      legacyJob: job,
      schedule,
      state: {
        name: job.name,
        status: 'idle',
        lastRunAt: null,
        nextRunAt: null,
        runCount: 0,
        lastError: null,
        consecutiveFailures: 0,
      },
      handler: job.handler,
      singleton: false,
    });

    logger.debug({ jobName: job.name, intervalMs: job.intervalMs }, 'cron job registered (legacy)');
  }

  /**
   * Register a v2 cron job from a CronJobDefinition.
   */
  registerDefinition(def: CronJobDefinition, handler: () => Promise<void>): void {
    if (this.jobs.has(def.name)) {
      throw new Error(`Cron job "${def.name}" already registered`);
    }

    const schedule = resolveSchedule(def.schedule);

    this.jobs.set(def.name, {
      definition: def,
      legacyJob: null,
      schedule,
      state: {
        name: def.name,
        status: def.enabled ? 'idle' : 'disabled',
        lastRunAt: null,
        nextRunAt: null,
        runCount: 0,
        lastError: null,
        consecutiveFailures: 0,
      },
      handler,
      singleton: def.singleton,
    });

    logger.debug({ jobName: def.name, schedule: def.schedule, type: def.type }, 'cron job registered (v2)');
  }

  unregister(name: string): void {
    const timer = this.legacyTimers.get(name);
    if (timer) {
      clearInterval(timer);
      this.legacyTimers.delete(name);
    }
    this.jobs.delete(name);
    logger.debug({ jobName: name }, 'cron job unregistered');
  }

  /**
   * Start the scheduler. Legacy jobs fire immediately then repeat.
   * V2 jobs use the tick loop to evaluate next fire times.
   */
  startAll(): void {
    // Legacy jobs use their own setInterval timers (exact backward compat)
    for (const [name, job] of this.jobs) {
      if (job.legacyJob && !this.legacyTimers.has(name)) {
        this.runJob(name); // Fire immediately
        const timer = setInterval(() => this.runJob(name), job.legacyJob.intervalMs);
        timer.unref();
        this.legacyTimers.set(name, timer);
        job.state.nextRunAt = new Date(Date.now() + job.legacyJob.intervalMs).toISOString();
      }
    }

    // Calculate initial next fire times for v2 jobs
    for (const [, job] of this.jobs) {
      if (job.definition && job.state.status === 'idle') {
        const next = getNextFireTime(job.schedule);
        job.state.nextRunAt = next?.toISOString() ?? null;
      }
    }

    // Start tick loop (1s interval)
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => this.tick(), 1000);
      this.tickTimer.unref();
    }

    this.persistState();
  }

  stopAll(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }

    for (const [name, timer] of this.legacyTimers) {
      clearInterval(timer);
      logger.debug({ jobName: name }, 'cron job stopped (legacy)');
    }
    this.legacyTimers.clear();

    for (const [name] of this.jobs) {
      logger.debug({ jobName: name }, 'cron job stopped');
    }

    this.persistState();
  }

  pause(name: string): void {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`Job "${name}" not found`);
    job.state.status = 'paused';
    this.persistState();
  }

  resume(name: string): void {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`Job "${name}" not found`);
    if (job.state.status === 'paused') {
      job.state.status = 'idle';
      const next = getNextFireTime(job.schedule);
      job.state.nextRunAt = next?.toISOString() ?? null;
      this.persistState();
    }
  }

  getState(name: string): CronJobState | undefined {
    return this.jobs.get(name)?.state;
  }

  listWithState(): CronJobState[] {
    return [...this.jobs.values()].map(j => ({ ...j.state }));
  }

  list(): string[] {
    return [...this.jobs.keys()];
  }

  getDefinition(name: string): CronJobDefinition | undefined {
    return this.jobs.get(name)?.definition ?? undefined;
  }

  // ── Hydration ─────────────────────────────────────────────

  /**
   * Load persisted state from cron-state.json, merging with current jobs.
   */
  hydrateState(): void {
    if (!this.statePath) return;
    if (!fs.existsSync(this.statePath)) return;

    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf-8')) as Record<string, CronJobState>;
      for (const [name, saved] of Object.entries(raw)) {
        const job = this.jobs.get(name);
        if (!job) continue;

        // Restore persistent fields only
        job.state.lastRunAt = saved.lastRunAt;
        job.state.runCount = saved.runCount;
        job.state.lastError = saved.lastError;
        job.state.consecutiveFailures = saved.consecutiveFailures;
      }
      logger.info({ jobCount: Object.keys(raw).length }, 'cron state hydrated');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ error: msg }, 'failed to hydrate cron state');
    }
  }

  // ── Private ───────────────────────────────────────────────

  private tick(): void {
    const now = new Date();

    for (const [name, job] of this.jobs) {
      // Skip disabled, paused, or currently running (singleton)
      if (job.state.status === 'disabled' || job.state.status === 'paused') continue;
      if (job.state.status === 'running' && job.singleton) continue;

      // Check if it's time to fire
      if (!job.state.nextRunAt) continue;
      const nextRun = new Date(job.state.nextRunAt);
      if (now < nextRun) continue;

      // Fire!
      this.runJob(name);

      // Calculate next fire time (one-shot jobs get null — disable happens in runJob completion)
      if (job.schedule.type === 'once') {
        job.state.nextRunAt = null;
      } else {
        const next = getNextFireTime(job.schedule);
        job.state.nextRunAt = next?.toISOString() ?? null;
      }
    }
  }

  private runJob(name: string): void {
    const job = this.jobs.get(name);
    if (!job) return;

    job.state.status = 'running';
    job.state.lastRunAt = new Date().toISOString();

    job.handler()
      .then(() => {
        job.state.runCount++;
        job.state.lastError = null;
        job.state.consecutiveFailures = 0;
        job.state.status = job.schedule.type === 'once' ? 'disabled' : 'idle';
        this.persistState();
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        job.state.runCount++;
        job.state.lastError = message;
        job.state.consecutiveFailures++;
        job.state.status = job.schedule.type === 'once' ? 'disabled' : 'idle';
        logger.error({ jobName: name, error: message }, 'cron job error');
        this.persistState();
      });
  }

  private persistState(): void {
    if (!this.statePath) return;

    const state: Record<string, CronJobState> = {};
    for (const [name, job] of this.jobs) {
      state[name] = { ...job.state };
    }

    try {
      const dir = path.dirname(this.statePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = this.statePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
      fs.renameSync(tmpPath, this.statePath);
    } catch { /* non-fatal — state persistence is best-effort */ }
  }
}
