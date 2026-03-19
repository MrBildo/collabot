import path from 'node:path';
import { query, AbortError } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage, McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { ulid } from 'ulid';
import { logger } from './logger.js';
import { resolveModelId, type Config } from './config.js';
import { assemblePrompt, assembleBotPrompt } from './prompts.js';
import { buildChildEnv, extractUsageMetrics } from './dispatch.js';
import { extractToolTarget } from './util.js';
import { detectErrorLoop, detectNonRetryable } from './monitor.js';
import { getDispatchStore, makeCapturedEvent } from './dispatch-store.js';
import { getProject, getProjectTasksDir, projectHasPaths } from './project.js';
import type { Project } from './project.js';
import { createTask, getTask } from './task.js';
import { buildTaskContext } from './context.js';
import { AgentResultSchema } from './types.js';
import type {
  CollabDispatchOptions,
  CollabDispatchResult,
  CollabDispatchCost,
  RoleDefinition,
  BotDefinition,
  ToolCall,
  ErrorTriplet,
  EventType,
  UsageMetrics,
  AgentResult,
} from './types.js';
import type { AgentPool } from './pool.js';

const AUTH_FAILURE_MSG = 'Authentication failed — Claude Code CLI is not logged in. Run `claude` in a terminal to authenticate. See https://code.claude.com/docs/en/authentication';

// JSON Schema for structured agent output — mirrors AgentResultSchema
const AGENT_RESULT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['success', 'partial', 'failed', 'blocked'] },
    summary: { type: 'string' },
    changes: { type: 'array', items: { type: 'string' } },
    issues: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
    pr_url: { type: 'string' },
  },
  required: ['status', 'summary'],
  additionalProperties: false,
};

// ── Context — passed once at startup, shared across dispatches ──

export type CollabDispatchContext = {
  config: Config;
  roles: Map<string, RoleDefinition>;
  bots: Map<string, BotDefinition>;
  projects: Map<string, Project>;
  projectsDir: string;
  pool: AgentPool;
};

// ── Bot Selection ──────────────────────────────────────────────

export type DraftedBot = {
  bot: BotDefinition;
  status: 'available';
} | {
  status: 'unavailable';
  reason: string;
};

/**
 * Draft a bot for dispatch. Role is always required.
 * If botName is provided, checks availability. Otherwise picks next available.
 * v1: random selection from available bots.
 */
export function draftBot(
  botName: string | undefined,
  bots: Map<string, BotDefinition>,
  pool: AgentPool,
): DraftedBot {
  if (botName) {
    const bot = bots.get(botName);
    if (!bot) {
      return { status: 'unavailable', reason: `Bot "${botName}" not found` };
    }
    // Check if bot is already in use (has an active agent in pool)
    const isActive = pool.list().some(a => a.id.startsWith(`bot-${botName}-`));
    if (isActive) {
      return { status: 'unavailable', reason: `Bot "${botName}" is busy` };
    }
    return { status: 'available', bot };
  }

  // No bot specified — pick first available
  for (const bot of bots.values()) {
    const isActive = pool.list().some(a => a.id.startsWith(`bot-${bot.name}-`));
    if (!isActive) {
      return { status: 'available', bot };
    }
  }

  return { status: 'unavailable', reason: 'No bots available' };
}

// ── Cost Extraction ────────────────────────────────────────────

function buildCostFromResult(
  resultMsg: SDKResultMessage | undefined,
  tokenBudget: number | null,
): CollabDispatchCost {
  if (!resultMsg) {
    return {
      totalUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      turns: 0,
      tokenBudget,
      tokenBudgetPercent: null,
    };
  }

  const cacheRead = resultMsg.usage?.cache_read_input_tokens ?? 0;
  const cacheCreation = resultMsg.usage?.cache_creation_input_tokens ?? 0;
  const inputTokens = (resultMsg.usage?.input_tokens ?? 0) + cacheRead + cacheCreation;
  const outputTokens = resultMsg.usage?.output_tokens ?? 0;
  const totalTokens = inputTokens + outputTokens;

  return {
    totalUsd: resultMsg.total_cost_usd ?? 0,
    inputTokens,
    outputTokens,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    turns: resultMsg.num_turns ?? 0,
    tokenBudget,
    tokenBudgetPercent: tokenBudget && tokenBudget > 0
      ? Math.round((totalTokens / tokenBudget) * 10000) / 100
      : null,
  };
}

// ── Unified Dispatch ───────────────────────────────────────────

/**
 * collabDispatch — the unified dispatch entry point.
 *
 * Enforces the full entity model: Project + Task + Role + Bot.
 * Handles entity resolution, task lifecycle, prompt assembly,
 * constraint enforcement (timeout, budget), SDK call, event capture,
 * and cost tracking.
 *
 * All adapters (Slack, TUI, CLI, Cron, MCP) call this function.
 */
export async function collabDispatch(
  options: CollabDispatchOptions,
  ctx: CollabDispatchContext,
): Promise<CollabDispatchResult> {
  const startTime = Date.now();

  // ── 1. Resolve project ─────────────────────────────────────
  const project = getProject(ctx.projects, options.project);
  if (!projectHasPaths(project)) {
    return crashResult(
      `Project "${options.project}" has no paths configured`,
      startTime,
      options,
    );
  }
  const cwd = path.resolve(project.paths[0]!);
  const projectsDir = ctx.projectsDir;

  // ── 2. Resolve role ────────────────────────────────────────
  const role = ctx.roles.get(options.role);
  if (!role) {
    const available = [...ctx.roles.keys()].join(', ');
    return crashResult(
      `Unknown role "${options.role}". Available: ${available}`,
      startTime,
      options,
    );
  }

  // Validate role is available for project
  if (!project.roles.includes(options.role)) {
    return crashResult(
      `Role "${options.role}" not available for project "${project.name}". Available: ${project.roles.join(', ')}`,
      startTime,
      options,
    );
  }

  // ── 3. Resolve bot (optional) ──────────────────────────────
  // Bot can come from options.botDefinition (pre-resolved by BSM) or options.bot (name)
  let bot: BotDefinition | undefined = options.botDefinition;
  if (!bot && options.bot) {
    const drafted = draftBot(options.bot, ctx.bots, ctx.pool);
    if (drafted.status === 'unavailable') {
      return crashResult(drafted.reason, startTime, options);
    }
    bot = drafted.bot;
  }

  // ── 4. Resolve model ───────────────────────────────────────
  const resolvedModel = resolveModelId(role.modelHint, ctx.config);

  // ── 5. Create or resolve task ──────────────────────────────
  let taskSlug: string;
  let taskDir: string;

  if (options.taskSlug && options.taskDir) {
    // Resume path — task already exists
    taskSlug = options.taskSlug;
    taskDir = options.taskDir;
  } else if (options.taskSlug) {
    // Slug provided, resolve dir
    const tasksDir = getProjectTasksDir(projectsDir, project.name);
    const task = getTask(tasksDir, options.taskSlug);
    taskSlug = task.slug;
    taskDir = task.taskDir;
  } else {
    // Create new task
    const tasksDir = getProjectTasksDir(projectsDir, project.name);
    const task = createTask(tasksDir, {
      name: options.prompt.slice(0, 80),
      project: project.name,
      description: options.prompt.slice(0, 200),
    });
    taskSlug = task.slug;
    taskDir = task.taskDir;
  }

  // ── 6. Assemble prompt ─────────────────────────────────────
  let systemPromptText: string;
  if (bot) {
    systemPromptText = assembleBotPrompt({
      bot,
      role,
      project: project.name,
      projectSkills: options.projectSkills,
    });
  } else {
    systemPromptText = assemblePrompt(role.prompt, role.permissions);
  }

  // ── 7. Context reconstruction ──────────────────────────────
  let effectivePrompt = options.prompt;
  if (!options.resume) {
    try {
      const store = getDispatchStore();
      const envelopes = store.getDispatchEnvelopes(taskDir);
      const withResults = envelopes.filter(d => d.structuredResult != null);
      if (withResults.length > 0) {
        const taskContext = buildTaskContext(taskDir);
        if (taskContext.includes('### Previous Work')) {
          effectivePrompt = `${taskContext}\n\n---\n\n${options.prompt}`;
        }
      }
    } catch { /* non-fatal — proceed without context reconstruction */ }
  }

  // ── 8. Resolve constraints ─────────────────────────────────
  const maxTurns = options.maxTurns ?? ctx.config.agent.maxTurns;
  const maxBudgetUsd = options.maxBudgetUsd ?? ctx.config.defaults.maxBudgetUsd ?? ctx.config.agent.maxBudgetUsd;
  const tokenBudget = options.tokenBudget ?? ctx.config.defaults.tokenBudget;
  const timeoutMs = options.timeoutMs ?? ctx.config.defaults.dispatchTimeoutMs;
  const stallTimeoutMs = ctx.config.defaults.stallTimeoutSeconds * 1000;
  const useStructuredOutput = options.useStructuredOutput ?? !options.resume;

  // ── 9. Set up abort / timeout ──────────────────────────────
  const controller = options.abortController ?? new AbortController();
  let abortReason: string | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let dispatchTimer: ReturnType<typeof setTimeout> | undefined;

  // Wall-clock timeout (#93)
  if (timeoutMs > 0) {
    dispatchTimer = setTimeout(() => {
      abortReason = 'timeout';
      controller.abort();
    }, timeoutMs);
    dispatchTimer.unref();
  }

  // ── 10. Dispatch setup ─────────────────────────────────────
  const dispatchId = ulid();
  const dispatchStore = getDispatchStore();
  let sessionId: string | undefined;
  let model: string | undefined;
  let resultMsg: SDKResultMessage | undefined;
  let capturedStructuredOutput: unknown = undefined;
  const toolCallWindow: ToolCall[] = [];
  const errorWindow: ErrorTriplet[] = [];
  const pendingToolCalls = new Map<string, { tool: string; target: string; startedAt: number }>();
  let loopWarningPosted = false;

  function emitEvent(type: EventType, data?: Record<string, unknown>) {
    try {
      dispatchStore.appendEvent(taskDir, dispatchId, makeCapturedEvent(type, data));
    } catch { /* non-fatal */ }
  }

  function resetStallTimer() {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      abortReason = 'stall';
      controller.abort();
    }, stallTimeoutMs);
    stallTimer.unref();
  }

  // Build SDK session options
  const sessionOpts: Record<string, unknown> = {};
  if (options.resume) {
    sessionOpts.resume = options.resume;
  } else if (options.sessionId) {
    sessionOpts.sessionId = options.sessionId;
  }

  logger.info({
    role: role.name,
    bot: bot?.name,
    project: project.name,
    model: resolvedModel,
    cwd,
    taskSlug,
    dispatchId,
    timeoutMs: timeoutMs || 'none',
    tokenBudget: tokenBudget || 'none',
    isResume: !!options.resume,
  }, 'collabDispatch: dispatching agent');

  // Create dispatch envelope
  try {
    dispatchStore.createDispatch(taskDir, {
      dispatchId,
      taskSlug,
      role: role.name,
      model: resolvedModel,
      cwd,
      startedAt: new Date().toISOString(),
      status: 'running',
      parentDispatchId: options.parentDispatchId,
      botId: bot?.id,
    });
  } catch { /* non-fatal */ }

  // ── 11. Run SDK event loop ─────────────────────────────────
  try {
    resetStallTimer();

    for await (const msg of query({
      prompt: effectivePrompt,
      options: {
        cwd,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: systemPromptText,
        },
        settingSources: ['project'],
        model: resolvedModel,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns,
        maxBudgetUsd: maxBudgetUsd || undefined,
        ...(useStructuredOutput ? {
          outputFormat: {
            type: 'json_schema' as const,
            schema: AGENT_RESULT_JSON_SCHEMA,
          },
        } : {}),
        abortController: controller,
        pathToClaudeCodeExecutable: process.env.CLAUDE_EXECUTABLE_PATH,
        env: buildChildEnv(ctx.config.mcp.streamTimeout),
        ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
        ...sessionOpts,
        stderr: (data: string) => {
          const line = data.trim();
          if (line) logger.warn({ stderr: line }, 'agent subprocess stderr');
        },
      },
    })) {
      resetStallTimer();

      if (msg.type === 'auth_status' && msg.error) {
        logger.error({ error: msg.error }, 'authentication failed during dispatch');
        emitEvent('harness:error', { message: `auth_status error: ${msg.error}` });
        emitEvent('session:complete', { status: 'crashed', error: 'authentication_failed' });
        updateDispatchEnvelope(dispatchStore, taskDir, dispatchId, 'crashed');
        controller.abort();
        return buildResult('crashed', AUTH_FAILURE_MSG, startTime, taskSlug, dispatchId, resolvedModel, resultMsg, tokenBudget);
      } else if (msg.type === 'system' && msg.subtype === 'init') {
        sessionId = msg.session_id;
        model = msg.model;
        emitEvent('session:init', { sessionId: msg.session_id, model: msg.model });
      } else if (msg.type === 'assistant') {
        if (msg.error) {
          logger.error({ error: msg.error, sessionId }, 'assistant message error');
          emitEvent('harness:error', { message: `assistant error: ${msg.error}` });
          if (msg.error === 'authentication_failed') {
            updateDispatchEnvelope(dispatchStore, taskDir, dispatchId, 'crashed');
            controller.abort();
            return buildResult('crashed', AUTH_FAILURE_MSG, startTime, taskSlug, dispatchId, resolvedModel, resultMsg, tokenBudget);
          }
        }

        for (const block of msg.message.content) {
          // Text blocks
          if (block.type === 'text' && typeof (block as Record<string, unknown>).text === 'string') {
            const text = (block as Record<string, unknown>).text as string;
            if (text.trim()) {
              emitEvent('agent:text', { text: text.slice(0, 2000) });
              options.onEvent?.({ type: 'chat', content: text });
            }
          }

          // Thinking blocks
          if (block.type === 'thinking' && typeof (block as Record<string, unknown>).thinking === 'string') {
            const thinking = (block as Record<string, unknown>).thinking as string;
            if (thinking.trim()) {
              emitEvent('agent:thinking', { text: thinking.slice(0, 2000) });
              options.onEvent?.({ type: 'thinking', content: thinking });
            }
          }

          // Tool use blocks
          if (block.type === 'tool_use') {
            const target = extractToolTarget(block.name, block.input);

            // Capture structured output
            if (block.name === 'StructuredOutput') {
              capturedStructuredOutput = block.input;
            }

            if (block.name !== 'StructuredOutput') {
              emitEvent('agent:tool_call', { toolCallId: block.id, tool: block.name, target });
              const summary = target ? `${block.name} ${target}` : block.name;
              options.onEvent?.({ type: 'tool_use', content: summary, metadata: { tool: block.name, target } });
            }

            if (block.id) {
              pendingToolCalls.set(block.id, { tool: block.name, target, startedAt: Date.now() });
            }

            // Error loop detection
            toolCallWindow.push({ tool: block.name, target, timestamp: Date.now() });
            if (toolCallWindow.length > 10) toolCallWindow.shift();

            const loopDetection = detectErrorLoop(toolCallWindow, options.loopDetectionThresholds);
            if (loopDetection) {
              if (loopDetection.severity === 'kill') {
                abortReason = 'error_loop';
                emitEvent('harness:loop_kill', { pattern: loopDetection.pattern, count: loopDetection.count });
                controller.abort();
                break;
              } else if (loopDetection.severity === 'warning' && !loopWarningPosted) {
                loopWarningPosted = true;
                emitEvent('harness:loop_warning', { pattern: loopDetection.pattern, count: loopDetection.count });
                options.onLoopWarning?.(loopDetection.pattern, loopDetection.count);
              }
            }
          }
        }
      } else if (msg.type === 'user') {
        // Tool results — error detection
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

              if (tool === 'StructuredOutput') continue;

              emitEvent('agent:tool_result', {
                toolCallId: toolUseId,
                tool,
                target,
                status: isError ? 'error' : 'completed',
                ...(durationMs !== undefined ? { durationMs } : {}),
              });

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
                  emitEvent('harness:error', {
                    message: `Non-retryable error: ${nonRetryable.tool}::${nonRetryable.target} (${nonRetryable.count}x)`,
                    snippet: nonRetryable.errorSnippet,
                  });
                  controller.abort();
                }
              }
            }
          }
        }
      } else if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
        emitEvent('session:compaction', {
          trigger: (msg as any).compact_metadata?.trigger ?? 'auto',
          preTokens: (msg as any).compact_metadata?.pre_tokens ?? 0,
        });
        options.onCompaction?.({
          trigger: (msg as any).compact_metadata?.trigger ?? 'auto',
          preTokens: (msg as any).compact_metadata?.pre_tokens ?? 0,
        });
      } else if (msg.type === 'system') {
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
          sessionId,
          status: msg.subtype,
          cost: msg.total_cost_usd,
          model,
          duration_ms: Date.now() - startTime,
        }, 'collabDispatch: agent completed');
      }
    }

    // ── 12. Process result ─────────────────────────────────────
    if (resultMsg && resultMsg.subtype === 'success') {
      const usage = extractUsageMetrics(resultMsg);
      let structuredResult: AgentResult | undefined;
      let rawResult: string | undefined;

      if (capturedStructuredOutput !== undefined) {
        const validated = AgentResultSchema.safeParse(capturedStructuredOutput);
        if (validated.success) {
          structuredResult = validated.data;
        }
      }

      if (!structuredResult && resultMsg.result) {
        try {
          const parsed = JSON.parse(resultMsg.result) as unknown;
          const validated = AgentResultSchema.safeParse(parsed);
          if (validated.success) {
            structuredResult = validated.data;
          } else {
            rawResult = resultMsg.result;
          }
        } catch {
          rawResult = resultMsg.result;
        }
      }

      emitEvent('session:complete', { status: 'completed', cost: resultMsg.total_cost_usd });
      updateDispatchEnvelope(dispatchStore, taskDir, dispatchId, 'completed', resultMsg, structuredResult);

      return {
        status: 'completed',
        ...(structuredResult ? { structuredResult } : {}),
        ...(rawResult ? { result: rawResult } : {}),
        taskSlug,
        dispatchId,
        cost: buildCostFromResult(resultMsg, tokenBudget || null),
        duration_ms: Date.now() - startTime,
        model: resolvedModel,
        usage,
      };
    }

    if (resultMsg) {
      const subtype = resultMsg.subtype;
      const isHardLimit = subtype === 'error_max_turns' || subtype === 'error_max_budget_usd';
      const finalStatus = isHardLimit ? 'aborted' as const : 'crashed' as const;
      emitEvent('session:complete', { status: finalStatus, reason: subtype, cost: resultMsg.total_cost_usd });
      updateDispatchEnvelope(dispatchStore, taskDir, dispatchId, finalStatus, resultMsg);

      return {
        status: finalStatus,
        taskSlug,
        dispatchId,
        cost: buildCostFromResult(resultMsg, tokenBudget || null),
        duration_ms: Date.now() - startTime,
        model: resolvedModel,
        usage: extractUsageMetrics(resultMsg),
      };
    }

    // No result message — completed without output
    emitEvent('session:complete', { status: 'completed' });
    updateDispatchEnvelope(dispatchStore, taskDir, dispatchId, 'completed');

    return {
      status: 'completed',
      taskSlug,
      dispatchId,
      cost: buildCostFromResult(undefined, tokenBudget || null),
      duration_ms: Date.now() - startTime,
      model: resolvedModel,
    };
  } catch (err) {
    if (err instanceof AbortError) {
      const status = abortReason === 'timeout' ? 'timed_out' as const : 'aborted' as const;

      if (abortReason === 'timeout') {
        logger.warn({ taskSlug, timeoutMs }, 'collabDispatch: dispatch timed out');
        emitEvent('harness:timeout', { timeoutMs, duration_ms: Date.now() - startTime });
      } else if (abortReason === 'stall') {
        emitEvent('harness:stall', { timeoutMs: stallTimeoutMs });
      } else if (abortReason === 'error_loop' || abortReason === 'non_retryable_error') {
        // Events already emitted above
      } else {
        emitEvent('harness:abort', { reason: abortReason ?? 'external' });
      }

      emitEvent('session:complete', { status, reason: abortReason });
      updateDispatchEnvelope(dispatchStore, taskDir, dispatchId, status, resultMsg);

      return {
        status,
        taskSlug,
        dispatchId,
        cost: buildCostFromResult(resultMsg, tokenBudget || null),
        duration_ms: Date.now() - startTime,
        model: resolvedModel,
        usage: resultMsg ? extractUsageMetrics(resultMsg) : undefined,
      };
    }

    // Non-abort error
    const message = err instanceof Error ? err.message : String(err);

    if (/auth|unauthorized|not.logged.in|login.*required/i.test(message)) {
      emitEvent('harness:error', { message: AUTH_FAILURE_MSG });
      emitEvent('session:complete', { status: 'crashed', error: 'authentication_failed' });
      updateDispatchEnvelope(dispatchStore, taskDir, dispatchId, 'crashed');
      return buildResult('crashed', AUTH_FAILURE_MSG, startTime, taskSlug, dispatchId, resolvedModel, resultMsg, tokenBudget);
    }

    logger.error({ err, message }, 'collabDispatch: agent crashed');
    emitEvent('harness:error', { message });
    emitEvent('session:complete', { status: 'crashed', error: message });
    updateDispatchEnvelope(dispatchStore, taskDir, dispatchId, 'crashed');
    return buildResult('crashed', message, startTime, taskSlug, dispatchId, resolvedModel, resultMsg, tokenBudget);
  } finally {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    if (dispatchTimer !== undefined) clearTimeout(dispatchTimer);
  }
}

// ── Helpers ────────────────────────────────────────────────────

function updateDispatchEnvelope(
  store: ReturnType<typeof getDispatchStore>,
  taskDir: string,
  dispatchId: string,
  status: 'completed' | 'aborted' | 'timed_out' | 'crashed',
  resultMsg?: SDKResultMessage,
  structuredResult?: AgentResult,
): void {
  try {
    store.updateDispatch(taskDir, dispatchId, {
      status,
      completedAt: new Date().toISOString(),
      cost: resultMsg?.total_cost_usd,
      usage: resultMsg ? extractUsageMetrics(resultMsg) : undefined,
      ...(structuredResult ? { structuredResult } : {}),
    });
  } catch { /* non-fatal */ }
}

function crashResult(
  error: string,
  startTime: number,
  options: CollabDispatchOptions,
): CollabDispatchResult {
  logger.error({ error }, 'collabDispatch: entity resolution failed');
  return {
    status: 'crashed',
    taskSlug: options.taskSlug ?? 'unknown',
    dispatchId: 'none',
    cost: buildCostFromResult(undefined, null),
    duration_ms: Date.now() - startTime,
    model: 'unknown',
  };
}

function buildResult(
  status: CollabDispatchResult['status'],
  error: string | undefined,
  startTime: number,
  taskSlug: string,
  dispatchId: string,
  model: string,
  resultMsg: SDKResultMessage | undefined,
  tokenBudget: number | undefined,
): CollabDispatchResult {
  return {
    status,
    result: error,
    taskSlug,
    dispatchId,
    cost: buildCostFromResult(resultMsg, tokenBudget || null),
    duration_ms: Date.now() - startTime,
    model,
    usage: resultMsg ? extractUsageMetrics(resultMsg) : undefined,
  };
}
