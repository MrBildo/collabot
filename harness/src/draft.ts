import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { query, AbortError } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { ulid } from 'ulid';
import { logger } from './logger.js';
import { getProjectTasksDir } from './project.js';
import type { Project } from './project.js';
import { buildChildEnv, extractUsageMetrics } from './dispatch.js';
import { extractToolTarget } from './util.js';
import { getDispatchStore, makeCapturedEvent } from './dispatch-store.js';
import { detectErrorLoop, detectNonRetryable } from './monitor.js';
import { makeChannelMessage } from './core.js';
import { filteredSend } from './comms.js';
import type { CommAdapter } from './comms.js';
import type { AgentPool } from './pool.js';
import type { RoleDefinition, DraftSession, DraftSummary, ToolCall, ErrorTriplet, LoopDetectionThresholds, EventType } from './types.js';
import { resolveModelId, type Config } from './config.js';
import { assemblePrompt } from './prompts.js';

// --- Module state (singleton — one draft at a time) ---

let activeDraft: DraftSession | null = null;

// --- Exports ---

export function getActiveDraft(): DraftSession | null {
  return activeDraft;
}

export function createDraft(opts: {
  role: RoleDefinition;
  project: Project;
  projectsDir: string;
  taskSlug: string;
  taskDir: string;
  channelId: string;
  pool: AgentPool;
}): DraftSession {
  if (activeDraft) {
    throw new Error('Draft already active. Close the current draft before starting a new one.');
  }

  const sessionId = randomUUID();
  const agentId = `draft-${opts.role.name}-${Date.now()}`;
  const dispatchId = ulid();

  const { taskSlug, taskDir } = opts;

  // Register in pool — stays registered until undraft
  const controller = new AbortController();
  opts.pool.register({
    id: agentId,
    role: opts.role.name,
    taskSlug,
    startedAt: new Date(),
    controller,
  });

  const now = new Date().toISOString();
  const session: DraftSession = {
    sessionId,
    agentId,
    role: opts.role.name,
    project: opts.project.name,
    taskSlug,
    taskDir,
    channelId: opts.channelId,
    startedAt: now,
    lastActivityAt: now,
    turnCount: 0,
    status: 'active',
    sessionInitialized: false,
    dispatchId,
    cumulativeCostUsd: 0,
    lastInputTokens: 0,
    lastOutputTokens: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
  };

  persistDraft(session);
  activeDraft = session;
  logger.info({ sessionId, dispatchId, role: opts.role.name, project: opts.project.name, taskSlug }, 'draft session created');
  return session;
}

export function closeDraft(pool: AgentPool): DraftSummary {
  if (!activeDraft) {
    throw new Error('No active draft to close.');
  }

  const session = activeDraft;
  session.status = 'closed';
  session.lastActivityAt = new Date().toISOString();
  persistDraft(session);

  // Emit session:complete and update dispatch envelope
  if (session.dispatchId) {
    try {
      const dispatchStore = getDispatchStore();
      dispatchStore.appendEvent(session.taskDir, session.dispatchId, makeCapturedEvent('session:complete', {
        status: 'completed',
        cost: session.cumulativeCostUsd,
      }));
      dispatchStore.updateDispatch(session.taskDir, session.dispatchId, {
        status: 'completed',
        completedAt: session.lastActivityAt,
        cost: session.cumulativeCostUsd,
      });
    } catch { /* non-fatal */ }
  }

  pool.release(session.agentId);

  const summary: DraftSummary = {
    sessionId: session.sessionId,
    taskSlug: session.taskSlug,
    turns: session.turnCount,
    costUsd: session.cumulativeCostUsd,
    durationMs: Date.now() - new Date(session.startedAt).getTime(),
  };

  logger.info({ sessionId: session.sessionId, turns: summary.turns, costUsd: summary.costUsd }, 'draft session closed');
  activeDraft = null;
  return summary;
}

export function updateDraftMetrics(update: {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}): void {
  if (!activeDraft) return;

  activeDraft.turnCount++;
  activeDraft.lastActivityAt = new Date().toISOString();
  if (update.costUsd != null) activeDraft.cumulativeCostUsd += update.costUsd;
  if (update.inputTokens != null) activeDraft.lastInputTokens = update.inputTokens;
  if (update.outputTokens != null) activeDraft.lastOutputTokens = update.outputTokens;
  if (update.contextWindow != null) activeDraft.contextWindow = update.contextWindow;
  if (update.maxOutputTokens != null) activeDraft.maxOutputTokens = update.maxOutputTokens;

  persistDraft(activeDraft);
}

export function loadActiveDraft(
  projects: Map<string, Project>,
  projectsDir: string,
  pool: AgentPool,
  roles: Map<string, RoleDefinition>,
): DraftSession | null {
  // Scan all project task directories for active drafts
  for (const project of projects.values()) {
    const tasksDir = getProjectTasksDir(projectsDir, project.name);
    if (!fs.existsSync(tasksDir)) continue;

    const dirs = fs.readdirSync(tasksDir, { withFileTypes: true }).filter(d => d.isDirectory());

    for (const dir of dirs) {
      const draftPath = path.join(tasksDir, dir.name, 'draft.json');
      if (!fs.existsSync(draftPath)) continue;

      try {
        const data = JSON.parse(fs.readFileSync(draftPath, 'utf-8')) as DraftSession;
        if (data.status !== 'active') continue;

        // Re-register in pool with a new AbortController
        const controller = new AbortController();
        try {
          pool.register({
            id: data.agentId,
            role: data.role,
            taskSlug: data.taskSlug,
            startedAt: new Date(data.startedAt),
            controller,
          });
        } catch (err) {
          logger.warn({ err, sessionId: data.sessionId }, 'failed to re-register recovered draft in pool — marking closed');
          data.status = 'closed';
          persistDraftTo(draftPath, data);
          continue;
        }

        // Validate that the role still exists
        if (!roles.has(data.role)) {
          logger.warn({ sessionId: data.sessionId, role: data.role }, 'recovered draft references a role that no longer exists');
          data.staleRole = true;
        }

        activeDraft = data;
        logger.info({ sessionId: data.sessionId, role: data.role, project: data.project, turnCount: data.turnCount, staleRole: data.staleRole ?? false }, 'recovered active draft session');
        return activeDraft;
      } catch {
        // Corrupt JSON — skip silently
      }
    }
  }

  return null;
}

export function getDraftController(pool: AgentPool): AbortController | undefined {
  if (!activeDraft) return undefined;
  const agent = pool.list().find(a => a.id === activeDraft!.agentId);
  return agent?.controller;
}

// --- Conversational dispatch ---

export async function resumeDraft(
  prompt: string,
  adapter: CommAdapter,
  roles: Map<string, RoleDefinition>,
  config: Config,
  pool: AgentPool,
  opts?: {
    cwd?: string;      // project-resolved CWD
    mcpServer?: McpSdkServerConfigWithInstance;
    onCompaction?: (event: { trigger: string; preTokens: number }) => void;
  },
): Promise<void> {
  if (!activeDraft) {
    throw new Error('No active draft session');
  }

  const session = activeDraft;
  const role = roles.get(session.role);
  if (!role) {
    throw new Error(`Role "${session.role}" not found`);
  }

  // CWD must be provided by caller (from project paths)
  if (!opts?.cwd) {
    throw new Error(`No cwd provided for resumeDraft. Project paths must resolve a working directory.`);
  }

  const isFirstTurn = !session.sessionInitialized;
  const controller = getDraftController(pool);
  if (!controller) {
    throw new Error('Draft agent not found in pool');
  }

  // Ensure dispatchId exists (backcompat for recovered drafts without one)
  if (!session.dispatchId) {
    session.dispatchId = ulid();
    persistDraft(session);
  }
  const dispatchId = session.dispatchId;

  // Stall timer (global default)
  const stallTimeoutMs = config.defaults.stallTimeoutSeconds * 1000;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let abortReason: string | undefined;
  const toolCallWindow: ToolCall[] = [];
  const errorWindow: ErrorTriplet[] = [];
  const pendingToolCalls = new Map<string, { tool: string; target: string; startedAt: number }>();
  let loopWarningPosted = false;

  const draftThresholds: LoopDetectionThresholds = {
    repeatWarn: 0, repeatKill: 0, pingPongWarn: 0, pingPongKill: 0,
  };
  let resultMsg: SDKResultMessage | undefined;

  function resetStallTimer() {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      abortReason = 'stall';
      controller!.abort();
    }, stallTimeoutMs);
  }

  // Project paths are absolute (from project manifests)
  const absoluteCwd = path.resolve(opts.cwd);

  // Resolve model
  const resolvedModel = resolveModelId(role.modelHint, config);

  // Build session options
  const sessionOpts: Record<string, unknown> = isFirstTurn
    ? { sessionId: session.sessionId }
    : { resume: session.sessionId };

  const maxTurns = config.agent.maxTurns;

  logger.info({
    sessionId: session.sessionId,
    role: role.name,
    isFirstTurn,
    turnCount: session.turnCount,
  }, 'resuming draft session');

  // v2 event capture
  const dispatchStore = getDispatchStore();
  function emitEvent(type: EventType, data?: Record<string, unknown>) {
    try {
      dispatchStore.appendEvent(session.taskDir, dispatchId, makeCapturedEvent(type, data));
    } catch { /* event capture failure is non-fatal */ }
  }

  // Create dispatch envelope on first turn (when we have resolved model)
  const existingEnvelope = dispatchStore.getDispatchEnvelope(session.taskDir, dispatchId);
  if (!existingEnvelope) {
    try {
      dispatchStore.createDispatch(session.taskDir, {
        dispatchId,
        taskSlug: session.taskSlug,
        role: role.name,
        model: resolvedModel,
        cwd: absoluteCwd,
        startedAt: session.startedAt,
        status: 'running',
      });
    } catch { /* non-fatal */ }
  }

  // Emit user:message for this turn's prompt
  emitEvent('user:message', { text: prompt });

  try {
    resetStallTimer();

    for await (const msg of query({
      prompt,
      options: {
        cwd: absoluteCwd,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: assemblePrompt(role.prompt, role.permissions),
        },
        settingSources: ['project'],
        model: resolvedModel,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns,
        abortController: controller,
        pathToClaudeCodeExecutable: process.env.CLAUDE_EXECUTABLE_PATH,
        env: buildChildEnv(config.mcp.streamTimeout),
        ...(opts?.mcpServer ? { mcpServers: { harness: opts.mcpServer } } : {}),
        ...sessionOpts,
        stderr: (data: string) => {
          const line = data.trim();
          if (line) logger.warn({ stderr: line }, 'draft agent subprocess stderr');
        },
      },
    })) {
      resetStallTimer();

      if (msg.type === 'system' && msg.subtype === 'init') {
        logger.info({ sessionId: msg.session_id, model: msg.model }, 'draft agent session started');
        emitEvent('session:init', { sessionId: msg.session_id, model: msg.model });
        if (!session.sessionInitialized) {
          session.sessionInitialized = true;
          persistDraft(session);
        }
      } else if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          // Emit text blocks as chat events
          if (block.type === 'text' && typeof (block as Record<string, unknown>).text === 'string') {
            const text = (block as Record<string, unknown>).text as string;
            if (text.trim()) {
              logger.info({ sessionId: session.sessionId, text: text.slice(0, 200) }, 'agent text');
              emitEvent('agent:text', { text: text.slice(0, 2000) });
              await filteredSend(adapter, makeChannelMessage(
                session.channelId, role.displayName ?? role.name, 'chat', text,
              ));
            }
          }

          // Emit thinking blocks
          if (block.type === 'thinking' && typeof (block as Record<string, unknown>).thinking === 'string') {
            const thinking = (block as Record<string, unknown>).thinking as string;
            if (thinking.trim()) {
              logger.info({ sessionId: session.sessionId, thinking: thinking.slice(0, 200) }, 'agent thinking');
              emitEvent('agent:thinking', { text: thinking.slice(0, 2000) });
              await filteredSend(adapter, makeChannelMessage(
                session.channelId, role.displayName ?? role.name, 'thinking', thinking,
              ));
            }
          }

          if (block.type === 'tool_use') {
            const target = extractToolTarget(block.name, block.input);

            if (block.name !== 'StructuredOutput') {
              logger.info({ sessionId: session.sessionId, tool: block.name, target }, 'tool use');
            }

            // Emit agent:tool_call (skip StructuredOutput — SDK internal)
            if (block.name !== 'StructuredOutput') {
              emitEvent('agent:tool_call', { toolCallId: block.id, tool: block.name, target });
              const summary = target ? `${block.name} ${target}` : block.name;
              await filteredSend(adapter, makeChannelMessage(
                session.channelId, role.name, 'tool_use', summary,
                { tool: block.name, target },
              ));
            }

            // Track tool_use_id for matching tool results
            if (block.id) {
              pendingToolCalls.set(block.id, { tool: block.name, target, startedAt: Date.now() });
            }

            // Sliding window error loop detection
            toolCallWindow.push({ tool: block.name, target, timestamp: Date.now() });
            if (toolCallWindow.length > 10) toolCallWindow.shift();

            const loopDetection = detectErrorLoop(toolCallWindow, draftThresholds);
            if (loopDetection) {
              if (loopDetection.severity === 'kill') {
                abortReason = 'error_loop';
                emitEvent('harness:loop_kill', { pattern: loopDetection.pattern, count: loopDetection.count });
                await filteredSend(adapter, makeChannelMessage(
                  session.channelId, 'system', 'warning',
                  `Agent killed: error loop detected (${loopDetection.pattern}, ${loopDetection.count} repetitions). Draft session is still active — send another message to continue.`,
                ));
                controller.abort();
                break;
              } else if (loopDetection.severity === 'warning' && !loopWarningPosted) {
                logger.warn({ pattern: loopDetection.pattern, count: loopDetection.count }, 'draft: error loop detected');
                emitEvent('harness:loop_warning', { pattern: loopDetection.pattern, count: loopDetection.count });
                loopWarningPosted = true;
                await filteredSend(adapter, makeChannelMessage(
                  session.channelId, 'system', 'warning',
                  `Agent appears stuck in a loop: \`${loopDetection.pattern}\` (${loopDetection.count} repetitions). Still running.`,
                ));
              }
            }
          }
        }
      } else if (msg.type === 'user') {
        // Capture tool results and detect errors
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              typeof block === 'object' &&
              block !== null &&
              'type' in block &&
              (block as Record<string, unknown>).type === 'tool_result'
            ) {
              const toolResultBlock = block as Record<string, unknown>;
              const toolUseId = typeof toolResultBlock.tool_use_id === 'string' ? toolResultBlock.tool_use_id : '';
              const isError = toolResultBlock.is_error === true;
              const pending = pendingToolCalls.get(toolUseId);
              const tool = pending?.tool ?? 'unknown';
              const target = pending?.target ?? '';
              const durationMs = pending?.startedAt ? Date.now() - pending.startedAt : undefined;
              if (pending) pendingToolCalls.delete(toolUseId);

              // Skip SDK-internal StructuredOutput tool results
              if (tool === 'StructuredOutput') continue;

              // Emit agent:tool_result for all tool results
              emitEvent('agent:tool_result', {
                toolCallId: toolUseId,
                tool,
                target,
                status: isError ? 'error' : 'completed',
                ...(durationMs !== undefined ? { durationMs } : {}),
              });

              // Error detection (only for errors)
              if (isError) {
                let errorSnippet = '';
                if (typeof toolResultBlock.content === 'string') {
                  errorSnippet = toolResultBlock.content;
                } else if (Array.isArray(toolResultBlock.content)) {
                  errorSnippet = (toolResultBlock.content as Array<Record<string, unknown>>)
                    .filter(b => b.type === 'text' && typeof b.text === 'string')
                    .map(b => b.text as string)
                    .join(' ');
                }
                errorSnippet = errorSnippet.replace(/\s+/g, ' ').trim().slice(0, 200);

                errorWindow.push({ tool, target, errorSnippet, timestamp: Date.now() });
                if (errorWindow.length > 20) errorWindow.shift();

                const nonRetryable = detectNonRetryable(errorWindow);
                if (nonRetryable) {
                  abortReason = 'non_retryable_error';
                  logger.warn({
                    tool: nonRetryable.tool,
                    target: nonRetryable.target,
                    errorSnippet: nonRetryable.errorSnippet,
                    count: nonRetryable.count,
                  }, 'draft: non-retryable error detected');
                  emitEvent('harness:error', {
                    message: `Non-retryable error: ${nonRetryable.tool}::${nonRetryable.target} (${nonRetryable.count}x)`,
                    snippet: nonRetryable.errorSnippet,
                  });
                  await filteredSend(adapter, makeChannelMessage(
                    session.channelId, 'system', 'warning',
                    `Agent killed: non-retryable error (${nonRetryable.tool}::${nonRetryable.target}). Draft session is still active.`,
                  ));
                  controller.abort();
                }
              }
            }
          }
        }
      } else if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
        logger.warn({ sessionId: session.sessionId }, 'draft: context compacted');
        const compactTrigger = (msg as any).compact_metadata?.trigger ?? 'auto';
        const preTokens = (msg as any).compact_metadata?.pre_tokens ?? 0;
        emitEvent('session:compaction', { trigger: compactTrigger, preTokens });
        opts?.onCompaction?.({ trigger: compactTrigger, preTokens });
      } else if (msg.type === 'system') {
        // Capture system events we were previously dropping
        const subtype = (msg as any).subtype as string | undefined;
        switch (subtype) {
          case 'status':
            emitEvent('session:status', { status: (msg as any).status });
            break;
          case 'files_persisted':
            emitEvent('system:files_persisted', { files: (msg as any).files });
            break;
          case 'hook_started':
            emitEvent('system:hook_started', { hookName: (msg as any).hook_name });
            break;
          case 'hook_progress':
            emitEvent('system:hook_progress', { output: typeof (msg as any).output === 'string' ? ((msg as any).output as string).slice(0, 500) : undefined });
            break;
          case 'hook_response':
            emitEvent('system:hook_response', {});
            break;
          case 'rate_limit':
            emitEvent('session:rate_limit', { retryAfterMs: (msg as any).retry_after_ms });
            break;
        }
      } else if (msg.type === 'result') {
        resultMsg = msg;
        logger.info({
          sessionId: session.sessionId,
          status: msg.subtype,
          cost: msg.total_cost_usd,
          duration_ms: msg.duration_api_ms,
        }, 'draft turn completed');
        logger.debug({
          num_turns: msg.num_turns,
          usage: msg.usage,
          modelUsage: msg.modelUsage,
        }, 'draft turn usage');
      }
    }

    // Update metrics and envelope from result
    if (resultMsg) {
      const usage = extractUsageMetrics(resultMsg);
      updateDraftMetrics({
        costUsd: resultMsg.total_cost_usd,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        contextWindow: usage?.contextWindow,
        maxOutputTokens: usage?.maxOutputTokens,
      });
      // Update envelope with accumulated cost/usage (status stays 'running')
      try {
        dispatchStore.updateDispatch(session.taskDir, dispatchId, {
          cost: session.cumulativeCostUsd,
          usage,
        });
      } catch { /* non-fatal */ }
    }
  } catch (err) {
    if (err instanceof AbortError) {
      if (abortReason === 'stall') {
        logger.warn({ sessionId: session.sessionId }, 'draft: agent stalled (inactivity timeout)');
        emitEvent('harness:stall', { timeoutMs: stallTimeoutMs });
        await filteredSend(adapter, makeChannelMessage(
          session.channelId, 'system', 'warning',
          'Agent stalled (inactivity timeout). Draft session is still active — send another message to continue.',
        ));
      } else if (abortReason === 'error_loop' || abortReason === 'non_retryable_error') {
        // Already emitted above (harness:loop_kill)
      } else {
        logger.warn({ sessionId: session.sessionId }, 'draft: agent aborted');
        emitEvent('harness:abort', { reason: abortReason ?? 'unknown' });
        await filteredSend(adapter, makeChannelMessage(
          session.channelId, 'system', 'warning',
          'Agent turn was aborted. Draft session is still active.',
        ));
      }
      // Update metrics even on abort if we got a resultMsg
      if (resultMsg) {
        const usage = extractUsageMetrics(resultMsg);
        updateDraftMetrics({
          costUsd: resultMsg.total_cost_usd,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          contextWindow: usage?.contextWindow,
          maxOutputTokens: usage?.maxOutputTokens,
        });
      }
      return;
    }

    // Non-abort error — likely SDK/session issue
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, sessionId: session.sessionId }, 'draft turn error');
    emitEvent('harness:error', { message: message.slice(0, 500) });

    // If it's a resume-specific error, auto-close draft
    if (message.includes('session') || message.includes('resume')) {
      await filteredSend(adapter, makeChannelMessage(
        session.channelId, 'system', 'error',
        `Draft session error: ${message}. Session auto-closed. Use /draft to start a new session.`,
      ));
      try { closeDraft(pool); } catch { /* best effort */ }
      // Override to crashed (closeDraft sets completed)
      try {
        dispatchStore.updateDispatch(session.taskDir, dispatchId, {
          status: 'crashed',
          completedAt: new Date().toISOString(),
        });
      } catch { /* non-fatal */ }
    } else {
      await filteredSend(adapter, makeChannelMessage(
        session.channelId, 'system', 'error',
        `Draft turn failed: ${message}`,
      ));
    }
  } finally {
    if (stallTimer !== undefined) {
      clearTimeout(stallTimer);
    }
  }
}

// --- Persistence ---

function persistDraft(session: DraftSession): void {
  persistDraftTo(path.join(session.taskDir, 'draft.json'), session);
}

function persistDraftTo(filePath: string, session: DraftSession): void {
  // Atomic write: write to .tmp, then rename
  const tmpPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Fallback to direct write if rename fails (cross-device, etc.)
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2) + '\n', 'utf-8');
  }
}
