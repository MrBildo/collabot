import fs from 'node:fs';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ulid } from 'ulid';
import { logger } from './logger.js';
import { readRunLog } from './cron-bridge.js';
import type { CronScheduler } from './cron.js';
import { getInstancePath } from './paths.js';
import type { Config } from './config.js';

// ── Options ─────────────────────────────────────────────────

export type CronMcpServerOptions = {
  scheduler: CronScheduler;
  config: Config;
};

// ── Minimum schedule interval (5 min default) ───────────────

const MIN_INTERVAL_MINUTES = 5;

// ── Server factory ──────────────────────────────────────────

export function createCronMcpServer(options: CronMcpServerOptions): McpSdkServerConfigWithInstance {
  const { scheduler, config } = options;
  const cronConfig = config.cron;
  const jobsDir = cronConfig ? getInstancePath(cronConfig.jobsDirectory) : '';
  const runsDir = path.join(jobsDir, 'runs');

  return createSdkMcpServer({
    name: 'cron',
    version: '1.0.0',
    tools: [
      tool(
        'list_cron_jobs',
        'List all registered cron jobs with their state (status, last/next run, run count, consecutive failures).',
        {},
        async () => {
          const states = scheduler.listWithState();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ jobs: states }) }],
          };
        },
      ),

      tool(
        'get_cron_job',
        'Get details of a specific cron job: definition + state + recent run log entries.',
        { name: z.string() },
        async ({ name }) => {
          const state = scheduler.getState(name);
          if (!state) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: `Job "${name}" not found` }) }],
              isError: true,
            };
          }
          const definition = scheduler.getDefinition(name);
          const runLog = readRunLog(runsDir, name, 10);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ state, definition, runLog }) }],
          };
        },
      ),

      tool(
        'create_cron_job',
        'Create a new agent cron job. Writes job.md to the cron directory — the file watcher picks it up. Cannot create handler jobs (those require TypeScript code).',
        {
          name: z.string().min(1).max(64).describe('Job name (used as folder name)'),
          schedule: z.string().min(1).describe('Cron expression, "every Xm", or "at ISO"'),
          role: z.string().min(1).describe('Role name for the dispatched agent'),
          project: z.string().min(1).describe('Project name'),
          prompt: z.string().min(1).describe('Prompt for the agent'),
          bot: z.string().optional().describe('Bot name (optional — selection picks if omitted)'),
          tokenBudget: z.number().int().nonnegative().optional().describe('Token budget (optional)'),
          maxTurns: z.number().int().nonnegative().optional().describe('Max turns (optional)'),
          singleton: z.boolean().optional().describe('Skip if previous still running (default true)'),
        },
        async ({ name, schedule, role, project, prompt, bot, tokenBudget, maxTurns, singleton }) => {
          // Validate schedule isn't too frequent
          const intervalMatch = schedule.match(/^every\s+(\d+)(m|h|d)$/i);
          if (intervalMatch) {
            const val = parseInt(intervalMatch[1]!, 10);
            const unit = intervalMatch[2]!.toLowerCase();
            const minutes = unit === 'm' ? val : unit === 'h' ? val * 60 : val * 1440;
            if (minutes < MIN_INTERVAL_MINUTES) {
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({
                  error: `Schedule too frequent: minimum interval is ${MIN_INTERVAL_MINUTES} minutes`,
                }) }],
                isError: true,
              };
            }
          }

          // Check if job already exists
          const jobDir = path.join(jobsDir, name);
          if (fs.existsSync(jobDir)) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: `Job "${name}" already exists` }) }],
              isError: true,
            };
          }

          // Build frontmatter
          const id = ulid();
          const fmLines = [
            '---',
            `id: ${id}`,
            `name: ${name}`,
            `schedule: "${schedule}"`,
            `role: ${role}`,
            `project: ${project}`,
          ];
          if (bot) fmLines.push(`bot: ${bot}`);
          if (tokenBudget !== undefined) fmLines.push(`tokenBudget: ${tokenBudget}`);
          if (maxTurns !== undefined) fmLines.push(`maxTurns: ${maxTurns}`);
          if (singleton !== undefined) fmLines.push(`singleton: ${singleton}`);
          fmLines.push('---', '', prompt);

          try {
            fs.mkdirSync(jobDir, { recursive: true });
            fs.writeFileSync(path.join(jobDir, 'job.md'), fmLines.join('\n'), 'utf-8');
            logger.info({ name, schedule, role, project }, 'cron job created via MCP');

            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                created: true, name, id, schedule, role, project,
              }) }],
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to create job: ${msg}` }) }],
              isError: true,
            };
          }
        },
      ),

      tool(
        'delete_cron_job',
        'Remove a cron job folder from disk. The scheduler will unregister it.',
        { name: z.string() },
        async ({ name }) => {
          const jobDir = path.join(jobsDir, name);
          if (!fs.existsSync(jobDir)) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: `Job "${name}" not found on disk` }) }],
              isError: true,
            };
          }

          try {
            fs.rmSync(jobDir, { recursive: true });
            scheduler.unregister(name);
            logger.info({ name }, 'cron job deleted via MCP');
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, name }) }],
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to delete: ${msg}` }) }],
              isError: true,
            };
          }
        },
      ),

      tool(
        'pause_cron_job',
        'Pause a cron job without deleting it. Paused jobs do not fire.',
        { name: z.string() },
        async ({ name }) => {
          try {
            scheduler.pause(name);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ paused: true, name }) }],
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
              isError: true,
            };
          }
        },
      ),

      tool(
        'resume_cron_job',
        'Resume a paused cron job.',
        { name: z.string() },
        async ({ name }) => {
          try {
            scheduler.resume(name);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ resumed: true, name }) }],
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
              isError: true,
            };
          }
        },
      ),

      tool(
        'get_cron_run_log',
        'Query run log for a job: recent executions with status, cost, duration, and dispatch details.',
        {
          name: z.string(),
          limit: z.number().int().positive().optional().describe('Number of entries (default 20)'),
        },
        async ({ name, limit }) => {
          const entries = readRunLog(runsDir, name, limit ?? 20);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ name, entries }) }],
          };
        },
      ),
    ],
  });
}
