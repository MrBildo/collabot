import { logger } from './logger.js';

export type CronJob = {
  name: string;
  intervalMs: number;
  handler: () => Promise<void>;
};

/**
 * Minimal cron scheduler using setInterval. Jobs fire once on start, then repeat at interval.
 * Timers use unref() so they don't block process shutdown.
 */
export class CronScheduler {
  private jobs = new Map<string, CronJob>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  register(job: CronJob): void {
    if (this.jobs.has(job.name)) {
      throw new Error(`Cron job "${job.name}" already registered`);
    }
    this.jobs.set(job.name, job);
    logger.debug({ jobName: job.name, intervalMs: job.intervalMs }, 'cron job registered');
  }

  unregister(name: string): void {
    const timer = this.timers.get(name);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(name);
    }
    this.jobs.delete(name);
  }

  /** Start all registered jobs. Each fires once immediately, then repeats at its interval. */
  startAll(): void {
    for (const [name, job] of this.jobs) {
      if (this.timers.has(name)) continue; // already running

      // Fire once immediately
      this.runJob(job);

      // Then repeat at interval
      const timer = setInterval(() => this.runJob(job), job.intervalMs);
      timer.unref();
      this.timers.set(name, timer);

      logger.debug({ jobName: name, intervalMs: job.intervalMs }, 'cron job started');
    }
  }

  /** Stop all running timers. */
  stopAll(): void {
    for (const [name, timer] of this.timers) {
      clearInterval(timer);
      logger.debug({ jobName: name }, 'cron job stopped');
    }
    this.timers.clear();
  }

  list(): string[] {
    return [...this.jobs.keys()];
  }

  private runJob(job: CronJob): void {
    job.handler().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ jobName: job.name, error: message }, 'cron job error');
    });
  }
}
