import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import { dispatch } from './dispatch.js';
import { buildTaskContext } from './context.js';
import { getTask, createTask, findTaskByThread, recordDispatch, nextJournalFile } from './task.js';
import { getProject, getProjectTasksDir, projectHasPaths } from './project.js';
import type { Project } from './project.js';
import type { TaskManifest } from './task.js';
import { getDispatchStore } from './dispatch-store.js';
import type { DispatchResult, RoleDefinition, AgentEvent } from './types.js';
import type { InboundMessage, ChannelMessage, CommAdapter } from './comms.js';
import { filteredSend } from './comms.js';
import type { Config } from './config.js';
import type { AgentPool } from './pool.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

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
 * Resolves project + role, finds/validates task, dispatches agent via draftAgent,
 * manages adapter status, posts results.
 */
export type McpServers = {
  /** Factory — creates a task-scoped full server so child agents inherit the parent task. */
  createFull: (parentTaskSlug: string, parentTaskDir: string, parentProject?: string) => McpSdkServerConfigWithInstance;
  readonly: McpSdkServerConfigWithInstance;
};

export async function handleTask(
  message: InboundMessage,
  adapter: CommAdapter,
  roles: Map<string, RoleDefinition>,
  config: Config,
  pool: AgentPool | undefined,
  mcpServers: McpServers | undefined,
  projects: Map<string, Project>,
  projectsDir: string,
): Promise<DispatchResult> {
  // Project is required
  const projectName = message.project;
  if (!projectName) {
    throw new Error('Project is required. Adapter must provide project context.');
  }

  const project = getProject(projects, projectName);

  // Guard: project must have paths configured for dispatch
  if (!projectHasPaths(project)) {
    throw new Error(`Project has no paths configured. Edit .projects/${project.name.toLowerCase()}/project.yaml to add repo paths.`);
  }

  const tasksDir = getProjectTasksDir(projectsDir, project.name);

  // Role is required (adapter provides it)
  const roleName = message.role ?? 'product-analyst';
  const role = roles.get(roleName);
  if (!role) {
    throw new Error(`Role "${roleName}" not found`);
  }

  // Validate role is available for this project
  if (!project.roles.includes(roleName)) {
    throw new Error(`Role "${roleName}" is not available for project "${project.name}". Available: ${project.roles.join(', ')}`);
  }

  // CWD: resolve from project paths (first path, or metadata override)
  const cwdOverride = message.metadata?.['cwdOverride'] as string | undefined;
  const cwd = cwdOverride ?? project.paths[0]!;

  // Task resolution: taskSlug from metadata → lookup existing task, OR threadId → thread inheritance
  const existingTaskSlug = message.metadata?.['taskSlug'] as string | undefined;
  let task: { slug: string; taskDir: string };
  if (existingTaskSlug) {
    task = getTask(tasksDir, existingTaskSlug);
  } else if (message.threadId) {
    const existing = findTaskByThread(tasksDir, message.threadId);
    if (existing) {
      task = existing;
    } else {
      // Auto-create task from message content
      const created = createTask(tasksDir, {
        name: message.content.slice(0, 80),
        project: project.name,
        description: message.content,
        threadId: message.threadId,
      });
      task = created;
    }
  } else {
    throw new Error('Task slug or thread ID is required for dispatch');
  }

  // Context reconstruction for follow-up dispatches
  let contentForDispatch = message.content;
  try {
    const store = getDispatchStore();
    const envelopes = store.getDispatchEnvelopes(task.taskDir);
    const withResults = envelopes.filter((d) => d.structuredResult != null);
    if (withResults.length > 0) {
      const taskContext = buildTaskContext(task.taskDir);
      contentForDispatch = taskContext + '\n---\n\n' + message.content;
      logger.info(
        { taskSlug: task.slug, dispatchCount: withResults.length },
        'reconstructing context for follow-up dispatch',
      );
    }
  } catch {
    // If dispatch store read fails, proceed without context reconstruction
  }

  // Preflight checks (warn-only, never block dispatch)
  if (!fs.existsSync(path.join(cwd, 'CLAUDE.md'))) {
    logger.warn({ cwd }, `No CLAUDE.md found in ${cwd} — agent will have no project context`);
    await adapter.send(makeChannelMessage(
      message.metadata?.['channelId'] as string ?? message.threadId,
      'Collabot', 'warning',
      `No CLAUDE.md found in ${cwd} — agent will have no project context`,
    ));
  }
  if (!fs.existsSync(path.join(cwd, '.agents', 'kb'))) {
    logger.warn({ cwd }, `No .agents/kb/ found in ${cwd} — agent will have no knowledge base`);
    await adapter.send(makeChannelMessage(
      message.metadata?.['channelId'] as string ?? message.threadId,
      'Collabot', 'warning',
      `No .agents/kb/ found in ${cwd} — agent will have no knowledge base`,
    ));
  }

  const persona = role.displayName ?? role.name;
  const projectLabel = path.basename(cwd);

  const channelId = message.metadata?.['channelId'] as string | undefined ?? message.threadId;

  // Set working status
  await adapter.setStatus(channelId, 'working');

  // Post dispatching notification
  await adapter.send(makeChannelMessage(
    channelId,
    'Collabot',
    'lifecycle',
    `Dispatching to *${persona}* (${projectLabel})...`,
  ));

  // Dispatch the agent — pick MCP server based on role category
  const dispatchStartedAt = new Date().toISOString();
  let selectedMcpServer: McpSdkServerConfigWithInstance | undefined;
  if (mcpServers) {
    const isFullAccess = role.permissions?.includes('agent-draft') ?? false;
    selectedMcpServer = isFullAccess
      ? mcpServers.createFull(task.slug, task.taskDir, project.name)
      : mcpServers.readonly;
  }
  const result = await draftAgent(roleName, contentForDispatch, adapter, roles, config, {
    taskSlug: task.slug,
    taskDir: task.taskDir,
    channelId,
    cwd,
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
      cwd,
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

  if (!options?.cwd) {
    throw new Error(`No cwd provided for draftAgent (role: ${roleName}). Project paths must resolve a working directory.`);
  }

  // Determine journal file
  const journalFileName = taskDir ? nextJournalFile(taskDir, roleName) : undefined;

  // Wire onLoopWarning to adapter.send
  const onLoopWarning = channelId
    ? (pattern: string, count: number) => {
        adapter.send(makeChannelMessage(
          channelId,
          'Collabot',
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
      cwd: options.cwd,
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
