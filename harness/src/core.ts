import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import { dispatch } from './dispatch.js';
import { buildTaskContext } from './context.js';
import { resolveRole, resolveRoutingCwd } from './router.js';
import { getOrCreateTask, recordDispatch, nextJournalFile } from './task.js';
import type { TaskManifest } from './task.js';
import type { DispatchResult, RoleDefinition, AgentEvent } from './types.js';
import type { InboundMessage, ChannelMessage, CommAdapter } from './comms.js';
import { filteredSend } from './comms.js';
import type { Config } from './config.js';
import type { AgentPool } from './pool.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

// Hub root: harness/src/core.ts → ../../ = hub root
const HUB_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TASKS_DIR = path.join(HUB_ROOT, '.agents', 'tasks');

function formatResult(result: DispatchResult): string {
  if (result.status === 'completed') {
    if (result.structuredResult) {
      const sr = result.structuredResult;
      const lines: string[] = [];

      lines.push(`*Status:* ${sr.status}`);
      lines.push(`*Summary:* ${sr.summary}`);

      if (sr.changes && sr.changes.length > 0) {
        lines.push('');
        lines.push('*Changes:*');
        for (const change of sr.changes) {
          lines.push(`\u2022 ${change}`);
        }
      }

      if (sr.issues && sr.issues.length > 0) {
        lines.push('');
        lines.push('*Issues:*');
        for (const issue of sr.issues) {
          lines.push(`\u2022 ${issue}`);
        }
      }

      if (sr.questions && sr.questions.length > 0) {
        lines.push('');
        lines.push('*Agent has questions:*');
        sr.questions.forEach((q, i) => {
          lines.push(`${i + 1}. ${q}`);
        });
      }

      if (sr.pr_url) {
        lines.push('');
        lines.push(`*PR:* ${sr.pr_url}`);
      }

      return lines.join('\n');
    }

    if (result.result) {
      let body = result.result;
      if (body.length > 3000) {
        logger.debug({ result: body }, 'agent result full text (truncated in output)');
        body = body.slice(0, 3000) + '\n\n_(truncated \u2014 full result in logs)_';
      }
      return body;
    }
    return '*Agent completed* \u2705';
  } else if (result.status === 'aborted') {
    return `*Agent timed out* \u23F1\uFE0F`;
  } else {
    const errorStr = result.error ? `\nError: ${result.error}` : '';
    return `*Agent crashed* \u274C${errorStr}`;
  }
}

export function makeChannelMessage(
  channelId: string,
  from: string,
  type: ChannelMessage['type'],
  content: string,
  metadata?: Record<string, unknown>,
): ChannelMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    channelId,
    from,
    timestamp: new Date(),
    type,
    content,
    metadata,
  };
}

/**
 * handleTask — adapter-facing entry point.
 *
 * Resolves role, creates/finds task, dispatches agent via draftAgent,
 * manages adapter status, posts results.
 */
export type McpServers = {
  /** Factory — creates a task-scoped full server so child agents inherit the parent task. */
  createFull: (parentTaskSlug: string, parentTaskDir: string) => McpSdkServerConfigWithInstance;
  readonly: McpSdkServerConfigWithInstance;
};

export async function handleTask(
  message: InboundMessage,
  adapter: CommAdapter,
  roles: Map<string, RoleDefinition>,
  config: Config,
  pool?: AgentPool,
  mcpServers?: McpServers,
): Promise<DispatchResult> {
  // Resolve role: pre-resolved from message or via routing rules
  const roleName = message.role ?? resolveRole(message.content, config);
  const role = roles.get(roleName);
  const routingCwd = message.role ? undefined : resolveRoutingCwd(message.content, config);
  // CLI callers can pass a cwd override in metadata
  const cwdOverride = (message.metadata?.['cwdOverride'] as string | undefined) ?? routingCwd;

  // Task abstraction — use existing task if slug provided, otherwise get/create
  const existingTaskSlug = message.metadata?.['taskSlug'] as string | undefined;
  let task: { slug: string; taskDir: string };
  if (existingTaskSlug) {
    const taskDir = path.join(TASKS_DIR, existingTaskSlug);
    const manifestPath = path.join(taskDir, 'task.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Task "${existingTaskSlug}" not found at ${taskDir}`);
    }
    task = { slug: existingTaskSlug, taskDir };
  } else {
    task = getOrCreateTask(message.threadId, message.content, TASKS_DIR);
  }

  // Context reconstruction for follow-up dispatches
  let contentForDispatch = message.content;
  try {
    const manifestPath = path.join(task.taskDir, 'task.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as TaskManifest;
    const dispatchesWithResults = Array.isArray(manifest.dispatches)
      ? manifest.dispatches.filter((d) => d.result != null)
      : [];
    if (dispatchesWithResults.length > 0) {
      const taskContext = buildTaskContext(task.taskDir);
      contentForDispatch = taskContext + '\n---\n\n' + message.content;
      logger.info(
        { taskSlug: task.slug, dispatchCount: dispatchesWithResults.length },
        'reconstructing context for follow-up dispatch',
      );
    }
  } catch {
    // If manifest read fails, proceed without context reconstruction
  }

  const persona = role?.displayName ?? 'KK Agent';
  const projectName = cwdOverride
    ? path.basename(cwdOverride)
    : (role?.cwd ? path.basename(role.cwd) : 'unknown');

  const channelId = message.metadata?.['channelId'] as string | undefined ?? message.threadId;

  // Set working status
  await adapter.setStatus(channelId, 'working');

  // Post dispatching notification
  await adapter.send(makeChannelMessage(
    channelId,
    'KK Agent',
    'lifecycle',
    `Dispatching to *${persona}* (${projectName})...`,
  ));

  // Dispatch the agent — pick MCP server based on role category
  const dispatchStartedAt = new Date().toISOString();
  let selectedMcpServer: McpSdkServerConfigWithInstance | undefined;
  if (mcpServers && role) {
    const isFullAccess = config.mcp.fullAccessCategories.includes(role.category);
    selectedMcpServer = isFullAccess
      ? mcpServers.createFull(task.slug, task.taskDir)
      : mcpServers.readonly;
  }
  const result = await draftAgent(roleName, contentForDispatch, adapter, roles, config, {
    taskSlug: task.slug,
    taskDir: task.taskDir,
    channelId,
    cwd: cwdOverride,
    pool,
    mcpServer: selectedMcpServer,
  });

  // Record dispatch in task manifest
  try {
    const dispatchResult = result.structuredResult
      ? {
          summary: result.structuredResult.summary,
          changes: result.structuredResult.changes,
          issues: result.structuredResult.issues,
          questions: result.structuredResult.questions,
        }
      : undefined;

    recordDispatch(task.taskDir, {
      role: roleName,
      cwd: cwdOverride ?? role?.cwd ?? 'unknown',
      model: result.model ?? config.models.default,
      startedAt: dispatchStartedAt,
      completedAt: new Date().toISOString(),
      status: result.status,
      journalFile: result.journalFile ?? `${roleName}.md`,
      result: dispatchResult,
    });
  } catch (err) {
    logger.error({ err }, 'failed to record dispatch in task manifest');
  }

  // Set final status
  if (result.status === 'completed') {
    await adapter.setStatus(channelId, 'completed');
  } else {
    await adapter.setStatus(channelId, 'failed');
  }

  // Post result
  const responseText = formatResult(result);
  await adapter.send(makeChannelMessage(
    channelId,
    persona,
    'result',
    responseText,
  ));

  return result;
}

/**
 * draftAgent — the stable pool primitive.
 *
 * Takes an explicit role + task context, dispatches an agent, tracks in pool.
 * Future PM bots call this directly.
 */
export async function draftAgent(
  roleName: string,
  taskContext: string,
  adapter: CommAdapter,
  roles: Map<string, RoleDefinition>,
  config: Config,
  options?: {
    taskSlug?: string;
    taskDir?: string;
    channelId?: string;
    cwd?: string;
    pool?: AgentPool;
    mcpServer?: McpSdkServerConfigWithInstance;
  },
): Promise<DispatchResult> {
  const taskSlug = options?.taskSlug ?? `task-${Date.now()}`;
  const taskDir = options?.taskDir;
  const channelId = options?.channelId;
  const pool = options?.pool;

  // Determine journal file
  const journalFileName = taskDir ? nextJournalFile(taskDir, roleName) : undefined;

  // Wire onLoopWarning to adapter.send
  const onLoopWarning = channelId
    ? (pattern: string, count: number) => {
        adapter.send(makeChannelMessage(
          channelId,
          'KK Agent',
          'warning',
          `\u26A0 Agent appears stuck in a loop: \`${pattern}\` (${count} repetitions). Still running.`,
        )).catch((err: unknown) => {
          logger.error({ err }, 'failed to post loop warning');
        });
      }
    : undefined;

  // Wire onEvent to adapter via filteredSend (adapter.acceptedTypes gates delivery)
  const onEvent = channelId
    ? (event: AgentEvent) => {
        filteredSend(adapter, makeChannelMessage(
          channelId,
          roleName,
          event.type,
          event.content,
          event.metadata,
        )).catch((err: unknown) => {
          logger.error({ err }, 'failed to forward agent event');
        });
      }
    : undefined;

  // Create AbortController before pool registration so pool.kill() propagates to dispatch
  const agentController = new AbortController();
  const agentId = `${roleName}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  if (pool) {
    pool.register({
      id: agentId,
      role: roleName,
      taskSlug,
      startedAt: new Date(),
      controller: agentController,
    });
  }

  try {
    return await dispatch(taskContext, {
      role: roleName,
      cwd: options?.cwd,
      featureSlug: taskSlug,
      taskDir,
      journalFileName,
      onLoopWarning,
      onEvent,
      abortController: agentController,
      ...(options?.mcpServer ? { mcpServers: { harness: options.mcpServer } } : {}),
    }, roles, config);
  } finally {
    if (pool) {
      pool.release(agentId);
    }
  }
}
