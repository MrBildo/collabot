import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { query, AbortError } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { ulid } from 'ulid';
import { logger } from './logger.js';
import { buildChildEnv, extractUsageMetrics } from './dispatch.js';
import { extractToolTarget } from './util.js';
import { getDispatchStore, makeCapturedEvent } from './dispatch-store.js';
import { detectErrorLoop, detectNonRetryable } from './monitor.js';
import { resolveModelId, type Config } from './config.js';
import { assembleBotPrompt } from './prompts.js';
import type { AgentPool } from './pool.js';
import type {
  RoleDefinition,
  BotDefinition,
  ToolCall,
  ErrorTriplet,
  LoopDetectionThresholds,
  EventType,
} from './types.js';

// ── BotSession type ────────────────────────────────────────────

export type BotSession = {
  botName: string;
  sessionId: string;      // UUID — SDK session resume key
  dispatchId: string;     // ULID — event capture envelope
  project: string;
  taskSlug: string;
  taskDir: string;
  role: string;
  startedAt: string;
  lastActivityAt: string;
  turnCount: number;
  sessionInitialized: boolean;
  cumulativeCostUsd: number;
};

// ── BotSessionManager ──────────────────────────────────────────

export class BotSessionManager {
  private sessions = new Map<string, BotSession>();

  constructor(
    private config: Config,
    private roles: Map<string, RoleDefinition>,
    private bots: Map<string, BotDefinition>,
    private pool: AgentPool,
  ) {}

  /**
   * Handle an inbound message addressed to a bot.
   * Creates or resumes a session, calls the SDK, and streams text back via responseSink.
   */
  async handleBotMessage(opts: {
    botName: string;
    roleName: string;
    message: string;
    project: string;
    taskSlug: string;
    taskDir: string;
    cwd: string;
    responseSink: (text: string) => Promise<void>;
  }): Promise<void> {
    const { botName, roleName, message, project, taskSlug, taskDir, cwd, responseSink } = opts;

    const bot = this.bots.get(botName);
    if (!bot) {
      throw new Error(`Bot "${botName}" not found`);
    }

    const role = this.roles.get(roleName);
    if (!role) {
      throw new Error(`Role "${roleName}" not found`);
    }

    // Get or create session
    let session = this.sessions.get(botName);
    if (!session || session.taskSlug !== taskSlug) {
      session = this.createSession(botName, roleName, project, taskSlug, taskDir);
    }

    const isFirstTurn = !session.sessionInitialized;
    const dispatchId = session.dispatchId;

    // Resolve model from role
    const resolvedModel = resolveModelId(role.modelHint, this.config);

    // Build prompt
    const systemPromptText = assembleBotPrompt(bot.soulPrompt, role.prompt, role.permissions);

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
    const controller = new AbortController();

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
        controller.abort();
      }, stallTimeoutMs);
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
        prompt: message,
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
          ...sessionOpts,
          stderr: (data: string) => {
            const line = data.trim();
            if (line) logger.warn({ stderr: line }, 'bot agent subprocess stderr');
          },
        },
      })) {
        resetStallTimer();

        if (msg.type === 'system' && msg.subtype === 'init') {
          emitEvent('session:init', { sessionId: msg.session_id, model: msg.model });
          if (!session.sessionInitialized) {
            session.sessionInitialized = true;
            this.persistSession(session);
          }
        } else if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            // Text → responseSink
            if (block.type === 'text' && typeof (block as Record<string, unknown>).text === 'string') {
              const text = (block as Record<string, unknown>).text as string;
              if (text.trim()) {
                emitEvent('agent:text', { text: text.slice(0, 2000) });
                await responseSink(text);
              }
            }

            // Thinking → event capture only
            if (block.type === 'thinking' && typeof (block as Record<string, unknown>).thinking === 'string') {
              const thinking = (block as Record<string, unknown>).thinking as string;
              if (thinking.trim()) {
                emitEvent('agent:thinking', { text: thinking.slice(0, 2000) });
              }
            }

            // Tool use → event capture + error loop detection
            if (block.type === 'tool_use') {
              const target = extractToolTarget(block.name, block.input);

              if (block.name !== 'StructuredOutput') {
                emitEvent('agent:tool_call', { toolCallId: block.id, tool: block.name, target });
              }

              if (block.id) {
                pendingToolCalls.set(block.id, { tool: block.name, target, startedAt: Date.now() });
              }

              toolCallWindow.push({ tool: block.name, target, timestamp: Date.now() });
              if (toolCallWindow.length > 10) toolCallWindow.shift();

              const loopDetection = detectErrorLoop(toolCallWindow, draftThresholds);
              if (loopDetection?.severity === 'kill') {
                abortReason = 'error_loop';
                emitEvent('harness:loop_kill', { pattern: loopDetection.pattern, count: loopDetection.count });
                controller.abort();
                break;
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
                      message: `Non-retryable error: ${nonRetryable.tool}::${nonRetryable.target}`,
                      snippet: nonRetryable.errorSnippet,
                    });
                    controller.abort();
                  }
                }
              }
            }
          }
        } else if (msg.type === 'result') {
          resultMsg = msg;
        }
      }

      // Update metrics
      if (resultMsg) {
        session.turnCount++;
        session.lastActivityAt = new Date().toISOString();
        session.cumulativeCostUsd += resultMsg.total_cost_usd ?? 0;
        this.persistSession(session);

        const usage = extractUsageMetrics(resultMsg);
        try {
          dispatchStore.updateDispatch(taskDir, dispatchId, {
            cost: session.cumulativeCostUsd,
            usage,
          });
        } catch { /* non-fatal */ }
      }
    } catch (err) {
      if (err instanceof AbortError) {
        if (abortReason === 'stall') {
          emitEvent('harness:stall', { timeoutMs: stallTimeoutMs });
          await responseSink('I stalled out (inactivity timeout). Send another message to continue.');
        } else if (abortReason === 'error_loop') {
          await responseSink('I got stuck in a loop and had to stop. Send another message to try again.');
        } else if (abortReason === 'non_retryable_error') {
          await responseSink('I hit an error I can\'t recover from. Send another message to try a different approach.');
        }
        // Update metrics even on abort
        if (resultMsg) {
          session.turnCount++;
          session.lastActivityAt = new Date().toISOString();
          session.cumulativeCostUsd += resultMsg.total_cost_usd ?? 0;
          this.persistSession(session);
        }
        return;
      }

      // Non-abort error — session may be corrupted, mark for recreation
      const message2 = err instanceof Error ? err.message : String(err);
      logger.error({ err, botName, sessionId: session.sessionId }, 'bot session error');
      emitEvent('harness:error', { message: message2.slice(0, 500) });

      // Remove session so next message creates a fresh one
      this.sessions.delete(botName);
      await responseSink(`Something went wrong: ${message2.slice(0, 200)}. I'll start fresh on your next message.`);
    } finally {
      if (stallTimer !== undefined) {
        clearTimeout(stallTimer);
      }
    }
  }

  getSession(botName: string): BotSession | null {
    return this.sessions.get(botName) ?? null;
  }

  /**
   * Load persisted bot sessions from disk (recovery after restart).
   */
  loadSessions(projectsDir: string, projects: Map<string, { name: string }>): void {
    for (const project of projects.values()) {
      const tasksDir = path.join(projectsDir, project.name.toLowerCase(), 'tasks');
      if (!fs.existsSync(tasksDir)) continue;

      const dirs = fs.readdirSync(tasksDir, { withFileTypes: true }).filter(d => d.isDirectory());

      for (const dir of dirs) {
        const taskDir = path.join(tasksDir, dir.name);
        // Look for bot-session-*.json files
        let files: string[];
        try {
          files = fs.readdirSync(taskDir).filter(f => f.startsWith('bot-session-') && f.endsWith('.json'));
        } catch {
          continue;
        }

        for (const file of files) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(taskDir, file), 'utf-8')) as BotSession;
            // Only restore if the bot still exists
            if (this.bots.has(data.botName)) {
              this.sessions.set(data.botName, data);
              logger.info({ botName: data.botName, turnCount: data.turnCount }, 'recovered bot session');
            }
          } catch {
            // Corrupt file — skip
          }
        }
      }
    }
  }

  // ── Private ──────────────────────────────────────────────────

  private createSession(
    botName: string,
    roleName: string,
    project: string,
    taskSlug: string,
    taskDir: string,
  ): BotSession {
    const now = new Date().toISOString();
    const session: BotSession = {
      botName,
      sessionId: randomUUID(),
      dispatchId: ulid(),
      project,
      taskSlug,
      taskDir,
      role: roleName,
      startedAt: now,
      lastActivityAt: now,
      turnCount: 0,
      sessionInitialized: false,
      cumulativeCostUsd: 0,
    };

    this.sessions.set(botName, session);
    this.persistSession(session);
    logger.info({ botName, sessionId: session.sessionId, dispatchId: session.dispatchId }, 'bot session created');
    return session;
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
