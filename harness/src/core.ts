import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import { collabDispatch, type CollabDispatchContext } from './collab-dispatch.js';
import { findTaskByThread, createTask } from './task.js';
import { getProject, getProjectTasksDir, projectHasPaths } from './project.js';
import type { DispatchResult, RoleDefinition, CollabDispatchResult, AgentEvent } from './types.js';
import type { InboundMessage, ChannelMessage } from './comms.js';
import type { CommunicationRegistry } from './registry.js';
import type { Config } from './config.js';
import type { AgentPool } from './pool.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { Project } from './project.js';
import { selectMcpServersForRole } from './mcp.js';
import type { McpServers } from './mcp.js';

function formatResult(result: CollabDispatchResult): string {
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
  } else if (result.status === 'aborted' || result.status === 'timed_out') {
    return `*Agent timed out* \u23F1\uFE0F`;
  } else {
    const errorStr = result.result ? `\nError: ${result.result}` : '';
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
 * Handles adapter-specific concerns (thread-based task resolution,
 * preflight checks, status broadcasting, result posting) and delegates
 * the actual dispatch to collabDispatch().
 */
export async function handleTask(
  message: InboundMessage,
  registry: CommunicationRegistry,
  roles: Map<string, RoleDefinition>,
  config: Config,
  pool: AgentPool,
  mcpServers: McpServers | undefined,
  projects: Map<string, Project>,
  projectsDir: string,
): Promise<CollabDispatchResult> {
  // Project is required
  const projectName = message.project;
  if (!projectName) {
    throw new Error('Project is required. Adapter must provide project context.');
  }

  const project = getProject(projects, projectName);
  if (!projectHasPaths(project)) {
    throw new Error(`Project has no paths configured. Edit .projects/${project.name.toLowerCase()}/project.toml to add repo paths.`);
  }

  const tasksDir = getProjectTasksDir(projectsDir, project.name);

  // Role is required
  const roleName = message.role ?? 'product-analyst';
  const role = roles.get(roleName);
  if (!role) {
    throw new Error(`Role "${roleName}" not found`);
  }
  if (!project.roles.includes(roleName)) {
    throw new Error(`Role "${roleName}" is not available for project "${project.name}". Available: ${project.roles.join(', ')}`);
  }

  // CWD override
  const cwd = (message.metadata?.['cwdOverride'] as string | undefined) ?? project.paths[0]!;

  // Task resolution: taskSlug from metadata → lookup, OR threadId → thread inheritance
  const existingTaskSlug = message.metadata?.['taskSlug'] as string | undefined;
  let taskSlug: string | undefined;
  let taskDir: string | undefined;

  if (existingTaskSlug) {
    taskSlug = existingTaskSlug;
    taskDir = path.join(tasksDir, existingTaskSlug);
  } else if (message.threadId) {
    const existing = findTaskByThread(tasksDir, message.threadId);
    if (existing) {
      taskSlug = existing.slug;
      taskDir = existing.taskDir;
    } else {
      const created = createTask(tasksDir, {
        name: message.content.slice(0, 80),
        project: project.name,
        description: message.content,
        threadId: message.threadId,
      });
      taskSlug = created.slug;
      taskDir = created.taskDir;
    }
  } else {
    throw new Error('Task slug or thread ID is required for dispatch');
  }

  // Preflight checks (warn-only)
  if (!fs.existsSync(path.join(cwd, 'CLAUDE.md'))) {
    logger.warn({ cwd }, `No CLAUDE.md found in ${cwd}`);
    await registry.broadcast(makeChannelMessage(
      message.metadata?.['channelId'] as string ?? message.threadId,
      'Collabot', 'warning',
      `No CLAUDE.md found in ${cwd} — agent will have no project context`,
    ));
  }
  if (!fs.existsSync(path.join(cwd, '.agents', 'kb'))) {
    logger.warn({ cwd }, `No .agents/kb/ found in ${cwd}`);
    await registry.broadcast(makeChannelMessage(
      message.metadata?.['channelId'] as string ?? message.threadId,
      'Collabot', 'warning',
      `No .agents/kb/ found in ${cwd} — agent will have no knowledge base`,
    ));
  }

  const persona = role.displayName ?? role.name;
  const projectLabel = path.basename(cwd);
  const channelId = message.metadata?.['channelId'] as string | undefined ?? message.threadId;

  await registry.broadcastStatus(channelId, 'working');
  await registry.broadcast(makeChannelMessage(
    channelId, 'Collabot', 'lifecycle',
    `Dispatching to *${persona}* (${projectLabel})...`,
  ));

  // MCP server selection based on role permissions
  const agentMcpServers = mcpServers
    ? selectMcpServersForRole(role, mcpServers, { taskSlug, taskDir, parentProject: project.name })
    : undefined;

  // Pool management
  const agentController = new AbortController();
  const agentId = `${roleName}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  pool.register({
    id: agentId,
    role: roleName,
    taskSlug,
    startedAt: new Date(),
    controller: agentController,
  });

  // Wire callbacks for adapter broadcasting
  const onLoopWarning = (pattern: string, count: number) => {
    registry.broadcast(makeChannelMessage(
      channelId, 'Collabot', 'warning',
      `\u26A0 Agent appears stuck in a loop: \`${pattern}\` (${count} repetitions). Still running.`,
    )).catch((err: unknown) => {
      logger.error({ err }, 'failed to post loop warning');
    });
  };

  const onEvent = (event: AgentEvent) => {
    registry.broadcast(makeChannelMessage(
      channelId, roleName, event.type, event.content, event.metadata,
    )).catch((err: unknown) => {
      logger.error({ err }, 'failed to forward agent event');
    });
  };

  try {
    const ctx: CollabDispatchContext = {
      config,
      roles,
      bots: new Map(), // handleTask doesn't use bots — that's BSM territory
      projects,
      projectsDir,
      pool,
    };

    const result = await collabDispatch({
      project: projectName,
      role: roleName,
      prompt: message.content,
      taskSlug,
      taskDir,
      abortController: agentController,
      onLoopWarning,
      onEvent,
      ...(agentMcpServers ? { mcpServers: agentMcpServers } : {}),
    }, ctx);

    // Adapter status
    if (result.status === 'completed') {
      await registry.broadcastStatus(channelId, 'completed');
    } else {
      await registry.broadcastStatus(channelId, 'failed');
    }

    // Post result
    const responseText = formatResult(result);
    await registry.broadcast(makeChannelMessage(channelId, persona, 'result', responseText));

    return result;
  } finally {
    pool.release(agentId);
  }
}

/**
 * draftAgent — pool-managed dispatch primitive.
 *
 * Used by the MCP draft_agent tool for non-blocking agent dispatch.
 * Thin wrapper around collabDispatch() with pool registration.
 */
export async function draftAgent(
  roleName: string,
  taskContext: string,
  registry: CommunicationRegistry,
  roles: Map<string, RoleDefinition>,
  config: Config,
  options?: {
    project?: string;
    taskSlug?: string;
    taskDir?: string;
    channelId?: string;
    cwd?: string;
    parentDispatchId?: string;
    pool: AgentPool;
    mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
    projects?: Map<string, Project>;
    projectsDir?: string;
  },
): Promise<CollabDispatchResult> {
  const taskSlug = options?.taskSlug ?? `task-${Date.now()}`;
  const pool = options!.pool;

  if (!options?.project && !options?.cwd) {
    throw new Error(`No project or cwd provided for draftAgent (role: ${roleName}).`);
  }

  // Pool management
  const agentController = new AbortController();
  const agentId = `${roleName}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  pool.register({
    id: agentId,
    role: roleName,
    taskSlug,
    startedAt: new Date(),
    controller: agentController,
  });

  // Wire callbacks for registry broadcasting
  const onLoopWarning = options?.channelId
    ? (pattern: string, count: number) => {
        registry.broadcast(makeChannelMessage(
          options.channelId!, 'Collabot', 'warning',
          `\u26A0 Agent stuck in loop: \`${pattern}\` (${count}x)`,
        )).catch(() => { /* fire-and-forget */ });
      }
    : undefined;

  const onEvent = options?.channelId
    ? (event: AgentEvent) => {
        registry.broadcast(makeChannelMessage(
          options.channelId!, roleName, event.type, event.content, event.metadata,
        )).catch(() => { /* fire-and-forget */ });
      }
    : undefined;

  try {
    const ctx: CollabDispatchContext = {
      config,
      roles,
      bots: new Map(),
      projects: options?.projects ?? new Map(),
      projectsDir: options?.projectsDir ?? '',
      pool,
    };

    return await collabDispatch({
      project: options?.project ?? 'unknown',
      role: roleName,
      prompt: taskContext,
      taskSlug,
      taskDir: options?.taskDir,
      parentDispatchId: options?.parentDispatchId,
      abortController: agentController,
      onLoopWarning,
      onEvent,
      ...(options?.mcpServers ? { mcpServers: options.mcpServers } : {}),
    }, ctx);
  } finally {
    pool.release(agentId);
  }
}

/**
 * Convert CollabDispatchResult to legacy DispatchResult for backward compatibility.
 */
export function toDispatchResult(result: CollabDispatchResult): DispatchResult {
  return {
    status: result.status === 'timed_out' ? 'aborted' : result.status,
    result: result.result,
    structuredResult: result.structuredResult,
    cost: result.cost.totalUsd,
    duration_ms: result.duration_ms,
    model: result.model,
    usage: result.usage,
  };
}
