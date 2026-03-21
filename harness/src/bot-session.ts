import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { query, AbortError } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage, McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { ulid } from 'ulid';
import { logger } from './logger.js';
import { buildChildEnv, extractUsageMetrics } from './dispatch.js';
import { extractToolTarget } from './util.js';
import { getDispatchStore, makeCapturedEvent } from './dispatch-store.js';
import { buildTaskContext } from './context.js';
import { detectErrorLoop, detectNonRetryable } from './monitor.js';
import { resolveModelId, type Config } from './config.js';
import { assembleBotPrompt } from './prompts.js';
import { makeChannelMessage } from './core.js';
import type { CommunicationRegistry } from './registry.js';
import type { AgentPool } from './pool.js';
import type {
  RoleDefinition,
  BotDefinition,
  ToolCall,
  ErrorTriplet,
  LoopDetectionThresholds,
  EventType,
} from './types.js';
import type { VirtualProjectSkill } from './comms.js';

const AUTH_FAILURE_MSG = 'Authentication failed — Claude Code CLI is not logged in. Run `claude` in a terminal to authenticate. See https://code.claude.com/docs/en/authentication';

// ── BotSession type ────────────────────────────────────────────

export type BotSession = {
  botName: string;
  sessionId: string;      // UUID — SDK session resume key
  agentId: string;        // pool registration key
  dispatchId: string;     // ULID — event capture envelope
  project: string;
  taskSlug: string;
  taskDir: string;
  role: string;
  channelId: string;      // channel for registry broadcast
  startedAt: string;
  lastActivityAt: string;
  turnCount: number;
  status: 'active' | 'closed';
  sessionInitialized: boolean;
  cumulativeCostUsd: number;
  lastInputTokens: number;
  lastOutputTokens: number;
  contextWindow: number;
  maxOutputTokens: number;
  lastNumTurns: number;   // API round-trips in the last SDK turn (for context % averaging)
  staleRole?: boolean;    // true if recovered session references a role that no longer exists
  modelOverride?: string; // per-session model pin (config alias, e.g. 'opus-latest')
  filterLevel: 'minimal' | 'feedback' | 'verbose';
};

export type BotSessionSummary = {
  sessionId: string;
  botName: string;
  taskSlug: string;
  turns: number;
  costUsd: number;
  durationMs: number;
};

// ── BotSessionManager ──────────────────────────────────────────

export class BotSessionManager {
  private sessions = new Map<string, BotSession>();
  // Model overrides that may be set before session creation (e.g., during draft)
  private pendingModelOverrides = new Map<string, string>();

  constructor(
    private config: Config,
    private roles: Map<string, RoleDefinition>,
    private bots: Map<string, BotDefinition>,
    private pool: AgentPool,
  ) {}

  /**
   * Handle an inbound message addressed to a bot.
   * Creates or resumes a session, calls the SDK, and streams output via
   * responseSink (Slack) and/or registry broadcast (TUI/WS).
   */
  async handleBotMessage(opts: {
    botName: string;
    roleName: string;
    message: string;
    project: string;
    taskSlug: string;
    taskDir: string;
    cwd: string;
    channelId?: string;
    responseSink: (text: string) => Promise<void>;
    registry?: CommunicationRegistry;
    mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
    onCompaction?: (event: { trigger: string; preTokens: number }) => void;
    disallowedTools?: string[];
    projectSkills?: VirtualProjectSkill[];
  }): Promise<void> {
    const { botName, roleName, message, project, taskSlug, taskDir, cwd, responseSink, disallowedTools, projectSkills } = opts;
    const channelId = opts.channelId ?? `bot-${botName}-${Date.now()}`;
    const registry = opts.registry;

    const bot = this.bots.get(botName);
    if (!bot) {
      throw new Error(`Bot "${botName}" not found`);
    }

    const role = this.roles.get(roleName);
    if (!role) {
      throw new Error(`Role "${roleName}" not found`);
    }

    // Get or create session — close old session on task change
    let session = this.sessions.get(botName);
    if (!session || session.taskSlug !== taskSlug) {
      if (session) {
        this.closeSession(botName);
      }
      session = this.createSession(botName, roleName, project, taskSlug, taskDir, channelId);
    }

    const isFirstTurn = !session.sessionInitialized;
    const dispatchId = session.dispatchId;
    const displayName = role.displayName ?? role.name;

    // Resolve model: per-session override > role model-hint > config default
    const modelHint = session.modelOverride ?? role.modelHint;
    const resolvedModel = resolveModelId(modelHint, this.config);

    // Build prompt
    const systemPromptText = assembleBotPrompt({ bot, role, project, projectSkills });

    // Build session options for SDK
    const sessionOpts: Record<string, unknown> = isFirstTurn
      ? { sessionId: session.sessionId }
      : { resume: session.sessionId };

    const absoluteCwd = path.resolve(cwd);

    // Stall timer
    const stallTimeoutMs = this.config.defaults.stallTimeoutSeconds * 1000;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let abortReason: string | undefined;
    const toolCallWindow: ToolCall[] = [];
    const errorWindow: ErrorTriplet[] = [];
    const pendingToolCalls = new Map<string, { tool: string; target: string; startedAt: number }>();
    let loopWarningPosted = false;

    // Use the session's pool-registered controller
    const controller = this.getSessionController(botName);
    if (!controller) {
      throw new Error(`Bot "${botName}" not registered in pool`);
    }

    const draftThresholds: LoopDetectionThresholds = {
      repeatWarn: 0, repeatKill: 0, pingPongWarn: 0, pingPongKill: 0,
    };

    let resultMsg: SDKResultMessage | undefined;

    // Event capture
    const dispatchStore = getDispatchStore();
    function emitEvent(type: EventType, data?: Record<string, unknown>) {
      try {
        dispatchStore.appendEvent(taskDir, dispatchId, makeCapturedEvent(type, data));
      } catch { /* non-fatal */ }
    }

    // Filter level gating for WS broadcast (errors/warnings always pass)
    const shouldBroadcast = (msgType: string): boolean => {
      if (msgType === 'error' || msgType === 'warning') return true;
      const level = session.filterLevel;
      if (level === 'verbose') return true;
      if (level === 'feedback') return msgType === 'chat' || msgType === 'tool_use';
      // minimal
      return msgType === 'chat';
    };

    // Ensure dispatch envelope exists
    const existingEnvelope = dispatchStore.getDispatchEnvelope(taskDir, dispatchId);
    if (!existingEnvelope) {
      try {
        dispatchStore.createDispatch(taskDir, {
          dispatchId,
          taskSlug,
          role: roleName,
          model: resolvedModel,
          cwd: absoluteCwd,
          startedAt: session.startedAt,
          status: 'running',
          botId: bot.id,
        });
      } catch { /* non-fatal */ }
    }

    emitEvent('user:message', { text: message });

    function resetStallTimer() {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        abortReason = 'stall';
        controller!.abort();
      }, stallTimeoutMs);
    }

    // Context reconstruction — on first turn, prepend task history if prior dispatches exist
    let effectiveMessage = message;
    if (isFirstTurn) {
      try {
        const taskManifestPath = path.join(taskDir, 'task.json');
        if (fs.existsSync(taskManifestPath)) {
          const taskContext = buildTaskContext(taskDir);
          if (taskContext.includes('### Previous Work')) {
            effectiveMessage = `${taskContext}\n\n---\n\n${message}`;
            emitEvent('session:context_reconstructed', { priorDispatches: true });
          }
        }
      } catch {
        // Non-fatal — proceed without context
      }
    }

    logger.info({
      botName,
      sessionId: session.sessionId,
      role: roleName,
      isFirstTurn,
      turnCount: session.turnCount,
    }, 'resuming bot session');

    try {
      resetStallTimer();

      for await (const msg of query({
        prompt: effectiveMessage,
        options: {
          cwd: absoluteCwd,
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: systemPromptText,
          },
          settingSources: ['project'],
          model: resolvedModel,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          maxTurns: this.config.agent.maxTurns,
          abortController: controller,
          pathToClaudeCodeExecutable: process.env.CLAUDE_EXECUTABLE_PATH,
          env: buildChildEnv(this.config.mcp.streamTimeout),
          ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
          ...(disallowedTools && disallowedTools.length > 0 ? { disallowedTools } : {}),
          ...sessionOpts,
          stderr: (data: string) => {
            const line = data.trim();
            if (line) logger.warn({ stderr: line }, 'bot agent subprocess stderr');
          },
        },
      })) {
        resetStallTimer();

        if (msg.type === 'auth_status' && msg.error) {
          logger.error({ botName, error: msg.error, output: msg.output }, 'authentication failed');
          emitEvent('harness:error', { message: `auth_status error: ${msg.error}` });
          await responseSink(AUTH_FAILURE_MSG);
          if (registry) {
            await registry.broadcast(makeChannelMessage(channelId, 'system', 'error', AUTH_FAILURE_MSG));
          }
          this.sessions.delete(botName);
          this.pool.release(session.agentId);
          controller.abort();
          break;
        } else if (msg.type === 'system' && msg.subtype === 'init') {
          emitEvent('session:init', { sessionId: msg.session_id, model: msg.model });
          if (!session.sessionInitialized) {
            session.sessionInitialized = true;
            this.persistSession(session);
          }
        } else if (msg.type === 'assistant') {
          // Check for API-level errors (auth, billing, rate limit, etc.)
          if (msg.error) {
            const errorLabel = msg.error === 'authentication_failed' ? AUTH_FAILURE_MSG
              : `API error: ${msg.error}. Check Claude Code CLI status.`;
            logger.error({ botName, error: msg.error }, 'assistant message error');
            emitEvent('harness:error', { message: `assistant error: ${msg.error}` });
            await responseSink(errorLabel);
            if (registry) {
              await registry.broadcast(makeChannelMessage(channelId, 'system', 'error', errorLabel));
            }
            if (msg.error === 'authentication_failed') {
              this.sessions.delete(botName);
              this.pool.release(session.agentId);
              controller.abort();
              break;
            }
          }
          for (const block of msg.message.content) {
            // Text → responseSink + registry broadcast
            if (block.type === 'text' && typeof (block as Record<string, unknown>).text === 'string') {
              const text = (block as Record<string, unknown>).text as string;
              if (text.trim()) {
                emitEvent('agent:text', { text: text.slice(0, 2000) });
                await responseSink(text);
                if (registry && shouldBroadcast('chat')) {
                  await registry.broadcast(makeChannelMessage(channelId, displayName, 'chat', text));
                }
              }
            }

            // Thinking → event capture + registry broadcast (verbose only)
            if (block.type === 'thinking' && typeof (block as Record<string, unknown>).thinking === 'string') {
              const thinking = (block as Record<string, unknown>).thinking as string;
              if (thinking.trim()) {
                emitEvent('agent:thinking', { text: thinking.slice(0, 2000) });
                if (registry && shouldBroadcast('thinking')) {
                  await registry.broadcast(makeChannelMessage(channelId, displayName, 'thinking', thinking));
                }
              }
            }

            // Tool use → event capture + error loop detection + registry broadcast (feedback+)
            if (block.type === 'tool_use') {
              const target = extractToolTarget(block.name, block.input);

              if (block.name !== 'StructuredOutput') {
                emitEvent('agent:tool_call', { toolCallId: block.id, tool: block.name, target });
                if (registry && shouldBroadcast('tool_use')) {
                  const summary = target ? `${block.name} ${target}` : block.name;
                  await registry.broadcast(makeChannelMessage(
                    channelId, role.name, 'tool_use', summary,
                    { tool: block.name, target },
                  ));
                }
              }

              if (block.id) {
                pendingToolCalls.set(block.id, { tool: block.name, target, startedAt: Date.now() });
              }

              toolCallWindow.push({ tool: block.name, target, timestamp: Date.now() });
              if (toolCallWindow.length > 10) toolCallWindow.shift();

              const loopDetection = detectErrorLoop(toolCallWindow, draftThresholds);
              if (loopDetection) {
                if (loopDetection.severity === 'kill') {
                  abortReason = 'error_loop';
                  emitEvent('harness:loop_kill', { pattern: loopDetection.pattern, count: loopDetection.count });
                  if (registry) {
                    await registry.broadcast(makeChannelMessage(
                      channelId, 'system', 'warning',
                      `Agent killed: error loop detected (${loopDetection.pattern}, ${loopDetection.count} repetitions). Session is still active — send another message to continue.`,
                    ));
                  }
                  controller.abort();
                  break;
                } else if (loopDetection.severity === 'warning' && !loopWarningPosted) {
                  logger.warn({ pattern: loopDetection.pattern, count: loopDetection.count }, 'bot session: error loop detected');
                  emitEvent('harness:loop_warning', { pattern: loopDetection.pattern, count: loopDetection.count });
                  loopWarningPosted = true;
                  if (registry) {
                    await registry.broadcast(makeChannelMessage(
                      channelId, 'system', 'warning',
                      `Agent appears stuck in a loop: \`${loopDetection.pattern}\` (${loopDetection.count} repetitions). Still running.`,
                    ));
                  }
                }
              }
            }
          }
        } else if (msg.type === 'user') {
          // Tool results → error detection
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
                    if (registry) {
                      await registry.broadcast(makeChannelMessage(
                        channelId, 'system', 'warning',
                        `Agent killed: non-retryable error (${nonRetryable.tool}::${nonRetryable.target}). Session is still active.`,
                      ));
                    }
                    controller.abort();
                  }
                }
              }
            }
          }
        } else if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
          logger.warn({ sessionId: session.sessionId }, 'bot session: context compacted');
          const compactTrigger = (msg as any).compact_metadata?.trigger ?? 'auto';
          const preTokens = (msg as any).compact_metadata?.pre_tokens ?? 0;
          emitEvent('session:compaction', { trigger: compactTrigger, preTokens });
          opts.onCompaction?.({ trigger: compactTrigger, preTokens });
        } else if (msg.type === 'system') {
          // Capture system events
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
          }, 'bot session turn completed');
          logger.debug({
            num_turns: msg.num_turns,
            usage: msg.usage,
            modelUsage: msg.modelUsage,
          }, 'bot session turn usage');
        }
      }

      // Update metrics
      if (resultMsg) {
        this.updateSessionMetrics(session, resultMsg);
        try {
          dispatchStore.updateDispatch(taskDir, dispatchId, {
            cost: session.cumulativeCostUsd,
            usage: extractUsageMetrics(resultMsg),
          });
        } catch { /* non-fatal */ }
      }
    } catch (err) {
      if (err instanceof AbortError) {
        if (abortReason === 'stall') {
          emitEvent('harness:stall', { timeoutMs: stallTimeoutMs });
          const stallMsg = 'Agent stalled (inactivity timeout). Session is still active — send another message to continue.';
          await responseSink(stallMsg);
          if (registry) {
            await registry.broadcast(makeChannelMessage(channelId, 'system', 'warning', stallMsg));
          }
        } else if (abortReason === 'error_loop' || abortReason === 'non_retryable_error') {
          // Already emitted above
          await responseSink('I got stuck and had to stop. Send another message to try again.');
        } else {
          emitEvent('harness:abort', { reason: abortReason ?? 'unknown' });
          const abortMsg = 'Agent turn was aborted. Session is still active.';
          await responseSink(abortMsg);
          if (registry) {
            await registry.broadcast(makeChannelMessage(channelId, 'system', 'warning', abortMsg));
          }
        }
        // Update metrics even on abort
        if (resultMsg) {
          this.updateSessionMetrics(session, resultMsg);
        }
        return;
      }

      // Non-abort error — may be session-specific
      const errMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err, botName, sessionId: session.sessionId }, 'bot session error');
      emitEvent('harness:error', { message: errMessage.slice(0, 500) });

      // Check for auth-related errors in thrown exceptions
      if (/auth|unauthorized|not.logged.in|login.*required/i.test(errMessage)) {
        await responseSink(AUTH_FAILURE_MSG);
        if (registry) {
          await registry.broadcast(makeChannelMessage(channelId, 'system', 'error', AUTH_FAILURE_MSG));
        }
        this.sessions.delete(botName);
        this.pool.release(session.agentId);
        try {
          dispatchStore.updateDispatch(taskDir, dispatchId, {
            status: 'crashed',
            completedAt: new Date().toISOString(),
          });
        } catch { /* non-fatal */ }
      } else if (errMessage.includes('session') || errMessage.includes('resume')) {
        const crashMsg = `Session error: ${errMessage}. Session auto-closed.`;
        await responseSink(crashMsg);
        if (registry) {
          await registry.broadcast(makeChannelMessage(channelId, 'system', 'error', crashMsg));
        }
        try { this.closeSession(botName); } catch { /* best effort */ }
        // Override status to crashed
        try {
          dispatchStore.updateDispatch(taskDir, dispatchId, {
            status: 'crashed',
            completedAt: new Date().toISOString(),
          });
        } catch { /* non-fatal */ }
      } else {
        const errorMsg = `Something went wrong: ${errMessage.slice(0, 200)}. I'll start fresh on your next message.`;
        await responseSink(errorMsg);
        if (registry) {
          await registry.broadcast(makeChannelMessage(channelId, 'system', 'error', errorMsg));
        }
        // Remove session so next message creates a fresh one
        this.sessions.delete(botName);
        this.pool.release(session.agentId);
      }
    } finally {
      if (stallTimer !== undefined) {
        clearTimeout(stallTimer);
      }
    }
  }

  // ── Public API ────────────────────────────────────────────────

  getSession(botName: string): BotSession | null {
    return this.sessions.get(botName) ?? null;
  }

  getAllSessions(): Map<string, BotSession> {
    return new Map(this.sessions);
  }

  /**
   * Close a bot session. Emits session:complete, updates dispatch envelope,
   * releases from pool, and returns a summary.
   */
  closeSession(botName: string): BotSessionSummary {
    const session = this.sessions.get(botName);
    if (!session) {
      throw new Error(`No active session for bot "${botName}"`);
    }

    session.status = 'closed';
    session.lastActivityAt = new Date().toISOString();
    this.persistSession(session);

    // Emit session:complete and update dispatch envelope
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

    // Release from pool
    try {
      this.pool.release(session.agentId);
    } catch { /* may already be released */ }

    const summary: BotSessionSummary = {
      sessionId: session.sessionId,
      botName: session.botName,
      taskSlug: session.taskSlug,
      turns: session.turnCount,
      costUsd: session.cumulativeCostUsd,
      durationMs: Date.now() - new Date(session.startedAt).getTime(),
    };

    logger.info({ sessionId: session.sessionId, botName, turns: summary.turns, costUsd: summary.costUsd }, 'bot session closed');
    this.sessions.delete(botName);
    return summary;
  }

  /**
   * Load persisted bot sessions from disk (recovery after restart).
   * Validates roles still exist, re-registers in pool.
   */
  loadSessions(projectsDir: string, projects: Map<string, { name: string }>): void {
    for (const project of projects.values()) {
      const tasksDir = path.join(projectsDir, project.name.toLowerCase(), 'tasks');
      if (!fs.existsSync(tasksDir)) continue;

      const dirs = fs.readdirSync(tasksDir, { withFileTypes: true }).filter(d => d.isDirectory());

      for (const dir of dirs) {
        const taskDir = path.join(tasksDir, dir.name);
        let files: string[];
        try {
          files = fs.readdirSync(taskDir).filter(f => f.startsWith('bot-session-') && f.endsWith('.json'));
        } catch {
          continue;
        }

        for (const file of files) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(taskDir, file), 'utf-8')) as BotSession;
            // Only restore active sessions for bots that still exist
            if (!this.bots.has(data.botName)) continue;
            if (data.status === 'closed') continue;

            // Validate role still exists
            if (!this.roles.has(data.role)) {
              logger.warn({ sessionId: data.sessionId, role: data.role }, 'recovered session references missing role');
              data.staleRole = true;
            }

            // Ensure agentId exists (backcompat with pre-Phase2 sessions)
            if (!data.agentId) {
              data.agentId = `bot-${data.botName}-${Date.now()}`;
            }

            // Backcompat: ensure new fields have defaults
            if (data.lastNumTurns === undefined) data.lastNumTurns = 0;
            if (data.filterLevel === undefined) data.filterLevel = 'feedback';

            // Re-register in pool
            const controller = new AbortController();
            const recoveredBot = this.bots.get(data.botName);
            try {
              this.pool.register({
                id: data.agentId,
                role: data.role,
                botId: recoveredBot?.id,
                botName: data.botName,
                taskSlug: data.taskSlug,
                startedAt: new Date(data.startedAt),
                controller,
              });
            } catch {
              logger.warn({ botName: data.botName }, 'failed to re-register recovered session in pool — skipping');
              continue;
            }

            this.sessions.set(data.botName, data);
            logger.info({ botName: data.botName, turnCount: data.turnCount, staleRole: data.staleRole ?? false }, 'recovered bot session');
          } catch {
            // Corrupt file — skip
          }
        }
      }
    }
  }

  /** Pin a model for a bot's session. Pass undefined to clear the pin. Works before session creation. */
  setModelOverride(botName: string, modelAlias: string | undefined): void {
    const session = this.sessions.get(botName);
    if (session) {
      session.modelOverride = modelAlias;
      this.persistSession(session);
    }
    // Also store in pending map (for draft → first submit flow)
    if (modelAlias !== undefined) {
      this.pendingModelOverrides.set(botName, modelAlias);
    } else {
      this.pendingModelOverrides.delete(botName);
    }
  }

  /** Get the current model override for a bot (checks session first, then pending). */
  getModelOverride(botName: string): string | undefined {
    return this.sessions.get(botName)?.modelOverride ?? this.pendingModelOverrides.get(botName);
  }

  /** Set the filter level for a bot's session event stream. */
  setFilterLevel(botName: string, level: 'minimal' | 'feedback' | 'verbose'): void {
    const session = this.sessions.get(botName);
    if (session) {
      session.filterLevel = level;
      this.persistSession(session);
    }
  }

  // ── Private ──────────────────────────────────────────────────

  private createSession(
    botName: string,
    roleName: string,
    project: string,
    taskSlug: string,
    taskDir: string,
    channelId: string,
  ): BotSession {
    const now = new Date().toISOString();
    const agentId = `bot-${botName}-${Date.now()}`;
    const session: BotSession = {
      botName,
      sessionId: randomUUID(),
      agentId,
      dispatchId: ulid(),
      project,
      taskSlug,
      taskDir,
      role: roleName,
      channelId,
      startedAt: now,
      lastActivityAt: now,
      turnCount: 0,
      status: 'active',
      sessionInitialized: false,
      cumulativeCostUsd: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      contextWindow: 0,
      maxOutputTokens: 0,
      lastNumTurns: 0,
      filterLevel: 'feedback',
    };

    // Register in pool
    const controller = new AbortController();
    const botDef = this.bots.get(botName);
    this.pool.register({
      id: agentId,
      role: roleName,
      botId: botDef?.id,
      botName,
      taskSlug,
      startedAt: new Date(),
      controller,
    });

    // Apply pending model override (set during draft before session exists)
    const pendingModel = this.pendingModelOverrides.get(botName);
    if (pendingModel) {
      session.modelOverride = pendingModel;
      this.pendingModelOverrides.delete(botName);
    }

    this.sessions.set(botName, session);
    this.persistSession(session);
    logger.info({ botName, sessionId: session.sessionId, dispatchId: session.dispatchId, agentId }, 'bot session created');
    return session;
  }

  private getSessionController(botName: string): AbortController | undefined {
    const session = this.sessions.get(botName);
    if (!session) return undefined;
    const agent = this.pool.list().find(a => a.id === session.agentId);
    return agent?.controller;
  }

  private updateSessionMetrics(session: BotSession, resultMsg: SDKResultMessage): void {
    session.turnCount++;
    session.lastActivityAt = new Date().toISOString();
    session.cumulativeCostUsd += resultMsg.total_cost_usd ?? 0;

    const usage = extractUsageMetrics(resultMsg);
    if (usage) {
      session.lastInputTokens = usage.inputTokens;
      session.lastOutputTokens = usage.outputTokens;
      session.contextWindow = usage.contextWindow;
      session.maxOutputTokens = usage.maxOutputTokens;
      session.lastNumTurns = usage.numTurns;
    }
    this.persistSession(session);
  }

  private persistSession(session: BotSession): void {
    const filePath = path.join(session.taskDir, `bot-session-${session.botName}.json`);
    try {
      fs.mkdirSync(session.taskDir, { recursive: true });
      const tmpPath = filePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2) + '\n', 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch {
      // Fallback
      try {
        fs.writeFileSync(filePath, JSON.stringify(session, null, 2) + '\n', 'utf-8');
      } catch { /* non-fatal */ }
    }
  }
}
