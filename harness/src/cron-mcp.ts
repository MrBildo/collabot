import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { ulid } from 'ulid';
import { logger } from './logger.js';
import { userContent, assistantContent } from './mcp.js';
import { readRunLog } from './cron-bridge.js';
import type { CronScheduler } from './cron.js';
import { getInstancePath } from './paths.js';
import type { Config } from './config.js';
import type { RoleDefinition, BotDefinition, Project } from './types.js';

// ── Options ─────────────────────────────────────────────────

export type CronMcpServerOptions = {
  scheduler: CronScheduler;
  config: Config;
  roles: Map<string, RoleDefinition>;
  projects: Map<string, Project>;
  bots: Map<string, BotDefinition>;
};

// ── Minimum schedule interval (5 min default) ───────────────

const MIN_INTERVAL_MINUTES = 5;

// ── Schedule validation ─────────────────────────────────────

function validateSchedule(schedule: string): string | null {
  // "every Xm" / "every Xh" / "every Xd"
  const intervalMatch = schedule.match(/^every\s+(\d+)(m|h|d)$/i);
  if (intervalMatch) {
    const val = parseInt(intervalMatch[1]!, 10);
    const unit = intervalMatch[2]!.toLowerCase();
    const minutes = unit === 'm' ? val : unit === 'h' ? val * 60 : val * 1440;
    if (minutes < MIN_INTERVAL_MINUTES) {
      return `Schedule too frequent: minimum interval is ${MIN_INTERVAL_MINUTES} minutes`;
    }
    return null;
  }

  // "at <ISO 8601 datetime>"
  if (schedule.startsWith('at ')) {
    const dt = new Date(schedule.slice(3).trim());
    if (isNaN(dt.getTime())) {
      return `Invalid date in schedule: "${schedule}"`;
    }
    return null;
  }

  // Standard cron expression
  try {
    CronExpressionParser.parse(schedule);
    return null;
  } catch {
    return `Invalid cron schedule: "${schedule}"`;
  }
}

// ── Server factory ──────────────────────────────────────────

const CRON_INSTRUCTIONS = `Cron Management — tools for managing scheduled agent jobs.

Workflow:
1. Use list_cron_jobs to see all registered jobs and their current state
2. Use get_cron_job for detailed info on a specific job (definition + state + run history)
3. Use create_cron_job to register a new scheduled agent dispatch
4. Use pause_cron_job / resume_cron_job to temporarily disable/enable jobs
5. Use delete_cron_job to permanently remove a job
6. Use get_cron_run_log to review execution history for a job

Schedule formats: cron expressions ("0 */6 * * *"), intervals ("every 30m", "every 2h"), or one-shot ("at 2026-03-25T10:00:00Z").
Minimum interval: ${MIN_INTERVAL_MINUTES} minutes. Jobs creating agent dispatches require a valid role and project.`;

export function createCronMcpServer(options: CronMcpServerOptions): McpSdkServerConfigWithInstance {
  const { scheduler, config, roles, projects, bots } = options;
  const cronConfig = config.cron;
  const jobsDir = cronConfig ? getInstancePath(cronConfig.jobsDirectory) : '';
  const runsDir = path.join(jobsDir, 'runs');

  const server = new McpServer(
    { name: 'cron', version: '1.0.0' },
    {
      capabilities: { tools: {}, logging: {} },
      instructions: CRON_INSTRUCTIONS,
    },
  );

  server.registerTool('list_cron_jobs', {
    title: 'List Cron Jobs',
    description: 'List all registered cron jobs with their state including status, last/next run timestamps, run count, and consecutive failure count. Use this to get an overview of all scheduled work.',
    inputSchema: {},
    outputSchema: {
      jobs: z.array(z.unknown()).describe('Array of cron job state objects'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const states = scheduler.listWithState();
    const data = { jobs: states };
    const count = states.length;
    const text = count === 0
      ? 'No cron jobs registered.'
      : `${count} cron job${count > 1 ? 's' : ''}:\n${states.map((j: { name: string; status: string }) => `  ${j.name} (${j.status})`).join('\n')}`;
    return {
      content: [userContent(text), assistantContent(data)],
      structuredContent: data,
    };
  });

  server.registerTool('get_cron_job', {
    title: 'Get Cron Job Details',
    description: 'Get detailed information for a specific cron job: its definition, current state, and recent run log entries. Use this to inspect a job before modifying it.',
    inputSchema: {
      name: z.string().describe('Job name to look up'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ name }) => {
    const state = scheduler.getState(name);
    if (!state) {
      return {
        content: [{ type: 'text' as const, text: `Job "${name}" not found` }],
        isError: true,
      };
    }
    const definition = scheduler.getDefinition(name);
    const runLog = readRunLog(runsDir, name, 10);
    const data = { state, definition, runLog };
    return {
      content: [userContent(`Job "${name}" (${state.status}) — ${state.runCount} runs, next: ${state.nextRunAt ?? 'N/A'}`), assistantContent(data)],
      structuredContent: data,
    };
  });

  server.registerTool('create_cron_job', {
    title: 'Create Cron Job',
    description: 'Create a new agent cron job. Writes a job.md file to the cron directory — the file watcher picks it up automatically. Validates that the role, project, and bot (if specified) exist before creating. Cannot create handler jobs (those require TypeScript code).',
    inputSchema: {
      name: z.string().min(1).max(64).describe('Job name (used as folder name, must be unique)'),
      schedule: z.string().min(1).describe('Schedule: cron expression, "every Xm/h/d", or "at <ISO datetime>"'),
      role: z.string().min(1).describe('Role name for the dispatched agent (must exist)'),
      project: z.string().min(1).describe('Project name (must exist)'),
      prompt: z.string().min(1).describe('Prompt text for the agent'),
      bot: z.string().optional().describe('Bot name (must exist if specified, otherwise auto-selected)'),
      tokenBudget: z.number().int().nonnegative().optional().describe('Max token budget for each dispatch'),
      maxTurns: z.number().int().nonnegative().optional().describe('Max conversation turns per dispatch'),
      singleton: z.boolean().optional().describe('Skip execution if previous dispatch still running (default true)'),
    },
    outputSchema: {
      created: z.boolean(),
      name: z.string(),
      id: z.string(),
      schedule: z.string(),
      role: z.string(),
      project: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ name, schedule, role, project, prompt, bot, tokenBudget, maxTurns, singleton }) => {
    // Validate schedule
    const scheduleError = validateSchedule(schedule);
    if (scheduleError) {
      return {
        content: [{ type: 'text' as const, text: scheduleError }],
        isError: true,
      };
    }

    // Validate role exists
    if (!roles.has(role)) {
      const available = [...roles.keys()].join(', ');
      return {
        content: [{ type: 'text' as const, text: `Unknown role "${role}". Available: ${available}` }],
        isError: true,
      };
    }

    // Validate project exists
    const proj = projects.get(project.toLowerCase());
    if (!proj) {
      const available = [...projects.values()].map(p => p.name).join(', ');
      return {
        content: [{ type: 'text' as const, text: `Unknown project "${project}". Available: ${available}` }],
        isError: true,
      };
    }

    // Validate role is available for the project
    if (!proj.roles.includes(role)) {
      return {
        content: [{ type: 'text' as const, text: `Role "${role}" not available for project "${proj.name}". Available: ${proj.roles.join(', ')}` }],
        isError: true,
      };
    }

    // Validate bot exists (if specified)
    if (bot && !bots.has(bot)) {
      const available = [...bots.keys()].join(', ');
      return {
        content: [{ type: 'text' as const, text: `Unknown bot "${bot}". Available: ${available}` }],
        isError: true,
      };
    }

    // Check if job already exists
    const jobDir = path.join(jobsDir, name);
    if (fs.existsSync(jobDir)) {
      return {
        content: [{ type: 'text' as const, text: `Job "${name}" already exists` }],
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

      const data = { created: true, name, id, schedule, role, project };
      return {
        content: [userContent(`Created cron job "${name}" (${schedule}, role: ${role}, project: ${project})`), assistantContent(data)],
        structuredContent: data,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Failed to create job: ${msg}` }],
        isError: true,
      };
    }
  });

  server.registerTool('delete_cron_job', {
    title: 'Delete Cron Job',
    description: 'Permanently remove a cron job folder from disk. The scheduler unregisters it immediately. This cannot be undone.',
    inputSchema: {
      name: z.string().describe('Job name to delete'),
    },
    outputSchema: {
      deleted: z.boolean(),
      name: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ name }) => {
    const jobDir = path.join(jobsDir, name);
    if (!fs.existsSync(jobDir)) {
      return {
        content: [{ type: 'text' as const, text: `Job "${name}" not found on disk` }],
        isError: true,
      };
    }

    try {
      fs.rmSync(jobDir, { recursive: true });
      scheduler.unregister(name);
      logger.info({ name }, 'cron job deleted via MCP');
      const data = { deleted: true, name };
      return {
        content: [userContent(`Deleted cron job "${name}"`), assistantContent(data)],
        structuredContent: data,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Failed to delete: ${msg}` }],
        isError: true,
      };
    }
  });

  server.registerTool('pause_cron_job', {
    title: 'Pause Cron Job',
    description: 'Pause a cron job without deleting it. Paused jobs do not fire until resumed. Safe to call on an already-paused job.',
    inputSchema: {
      name: z.string().describe('Job name to pause'),
    },
    outputSchema: {
      paused: z.boolean(),
      name: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ name }) => {
    try {
      scheduler.pause(name);
      const data = { paused: true, name };
      return {
        content: [userContent(`Paused cron job "${name}"`), assistantContent(data)],
        structuredContent: data,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: msg }],
        isError: true,
      };
    }
  });

  server.registerTool('resume_cron_job', {
    title: 'Resume Cron Job',
    description: 'Resume a paused cron job. The job will fire on its next scheduled time. Safe to call on an already-running job.',
    inputSchema: {
      name: z.string().describe('Job name to resume'),
    },
    outputSchema: {
      resumed: z.boolean(),
      name: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ name }) => {
    try {
      scheduler.resume(name);
      const data = { resumed: true, name };
      return {
        content: [userContent(`Resumed cron job "${name}"`), assistantContent(data)],
        structuredContent: data,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: msg }],
        isError: true,
      };
    }
  });

  server.registerTool('get_cron_run_log', {
    title: 'Get Cron Run Log',
    description: 'Query the execution log for a cron job. Returns recent runs with status, cost, duration, and dispatch details. Use this to monitor job health and debug failures.',
    inputSchema: {
      name: z.string().describe('Job name to query'),
      limit: z.number().int().positive().optional().describe('Number of log entries to return (default 20, most recent first)'),
    },
    outputSchema: {
      name: z.string(),
      entries: z.array(z.unknown()).describe('Array of run log entries'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ name, limit }) => {
    const entries = readRunLog(runsDir, name, limit ?? 20);
    const data = { name, entries };
    const count = entries.length;
    const text = count === 0
      ? `No run log entries for job "${name}".`
      : `${count} run log entr${count > 1 ? 'ies' : 'y'} for "${name}"`;
    return {
      content: [userContent(text), assistantContent(data)],
      structuredContent: data,
    };
  });

  return { type: 'sdk' as const, name: 'cron', instance: server };
}
