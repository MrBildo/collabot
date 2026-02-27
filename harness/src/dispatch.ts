import path from "node:path";
import { query, AbortError } from "@anthropic-ai/claude-agent-sdk";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "./logger.js";
import type { DispatchResult, DispatchOptions, RoleDefinition, ToolCall, ErrorTriplet, AgentEvent, UsageMetrics } from "./types.js";
import { AgentResultSchema } from "./types.js";
import { resolveModelId, type Config } from "./config.js";
import { assemblePrompt } from "./prompts.js";
import { extractToolTarget } from "./journal.js";
import { detectErrorLoop, detectNonRetryable } from "./monitor.js";
import { getEventStore, makeEvent } from "./events.js";

// JSON Schema for structured agent output — mirrors AgentResultSchema
const AGENT_RESULT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["success", "partial", "failed", "blocked"] },
    summary: { type: "string" },
    changes: { type: "array", items: { type: "string" } },
    issues: { type: "array", items: { type: "string" } },
    questions: { type: "array", items: { type: "string" } },
    pr_url: { type: "string" },
  },
  required: ["status", "summary"],
  additionalProperties: false,
};


/**
 * Build a sanitized env object for the child Claude Code process.
 *
 * Two Windows-specific issues must be addressed:
 *
 * 1. CLAUDECODE=1: cli.js checks this env var and exits with code 1 if found,
 *    treating it as a disallowed nested session. Strip it from the child env.
 *
 * 2. CLAUDE_CODE_GIT_BASH_PATH: cli.js auto-detects bash by resolving
 *    path.join(gitPath, "../../bin/bash.exe") where gitPath = first result of
 *    where.exe git. On this machine that is mingw64/bin/git.exe, so the
 *    resolved bash path is mingw64/bin/bash.exe which does not exist. Providing
 *    CLAUDE_CODE_GIT_BASH_PATH bypasses auto-detection. The path MUST use
 *    Windows backslashes; cli.js validates via execSync(dir "<path>") which
 *    fails with forward slashes.
 */
export function buildChildEnv(streamTimeoutMs?: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE"),
  );
  // If CLAUDE_CODE_GIT_BASH_PATH is set in the parent env, pass it through.
  // Windows requires this because the SDK's git-bash auto-detection resolves
  // to the wrong path (mingw64/bin/ instead of bin/). Non-Windows machines
  // can leave this unset. The path MUST use Windows backslashes.
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    env.CLAUDE_CODE_GIT_BASH_PATH = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  } else {
    delete env.CLAUDE_CODE_GIT_BASH_PATH;
  }
  // MCP tool calls (e.g., await_agent) can block for minutes while a sub-agent
  // runs. The SDK's default stream close timeout (~60s) is too short. Override
  // to accommodate long-running tool calls. Defaults to 10 minutes.
  env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = String(streamTimeoutMs ?? 600000);
  return env;
}

export function extractUsageMetrics(resultMsg: SDKResultMessage): UsageMetrics | undefined {
  if (!resultMsg.usage || !resultMsg.modelUsage) return undefined;
  const modelKey = Object.keys(resultMsg.modelUsage)[0];
  const md = modelKey ? resultMsg.modelUsage[modelKey] : undefined;
  const inputTokens = resultMsg.usage.input_tokens ?? 0;
  const cacheRead = resultMsg.usage.cache_read_input_tokens ?? 0;
  const cacheCreation = resultMsg.usage.cache_creation_input_tokens ?? 0;

  return {
    inputTokens: inputTokens + cacheRead + cacheCreation,
    outputTokens: resultMsg.usage.output_tokens ?? 0,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    contextWindow: md?.contextWindow ?? 0,
    maxOutputTokens: md?.maxOutputTokens ?? 0,
    numTurns: resultMsg.num_turns,
    durationApiMs: resultMsg.duration_api_ms,
  };
}

// TODO: maxTurns strategy needs PM review. error_max_turns may not be a meaningful
// error signal for real tasks — a coding agent legitimately needs many turns.
// Options: per-category limits in config.toml, role-level override, or removing
// the hard cap entirely in favor of budget-only limiting. Revisit before launch.

export async function dispatch(
  prompt: string,
  options: DispatchOptions,
  roles: Map<string, RoleDefinition>,
  config: Config,
): Promise<DispatchResult> {
  // Role lookup
  const role = roles.get(options.role);
  if (!role) {
    const available = [...roles.keys()].join(', ');
    const message = `Unknown role "${options.role}". Available roles: ${available}`;
    logger.error({ role: options.role }, message);
    return { status: "crashed", error: message, duration_ms: 0 };
  }

  // CWD resolution: always required in options (project provides path)
  const resolvedCwd = options.cwd;

  // Model resolution: per-dispatch override > role model-hint > config default
  const resolvedModel = options.model ?? resolveModelId(role.modelHint, config);

  // Inactivity timeout from config defaults (seconds → ms)
  const stallTimeoutMs = config.defaults.stallTimeoutSeconds * 1000;

  // Layered prompt assembly: system prompt + role prompt + conditional tool docs
  const assembledPrompt = assemblePrompt(role.prompt, role.permissions);

  // Project paths are absolute (from project manifests)
  const absoluteCwd = path.resolve(resolvedCwd);

  const maxTurns = options.maxTurns ?? config.agent.maxTurns;
  const maxBudgetUsd = options.maxBudgetUsd ?? config.agent.maxBudgetUsd;
  const startTime = Date.now();
  const controller = options.abortController ?? new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let abortReason: string | undefined;
  let sessionId: string | undefined;
  const toolCallWindow: ToolCall[] = [];
  const errorWindow: ErrorTriplet[] = [];
  // Map tool_use_id → {tool, target} for matching errors to their tool calls
  const pendingToolCalls = new Map<string, { tool: string; target: string }>();
  let loopWarningPosted = false;
  // Always false in Milestone B — no session resume. Build the check now so
  // kill logic is wired correctly; it becomes meaningful when resume lands.
  const humanRespondedSinceWarning = false;
  let model: string | undefined;
  let resultMsg: SDKResultMessage | undefined;
  // Captured directly from the StructuredOutput tool input (injected by the SDK
  // when outputFormat is set). More reliable than resultMsg.result, which
  // contains the agent's final text even when StructuredOutput was also called.
  let capturedStructuredOutput: unknown = undefined;

  // Event capture — write to task dir if available
  const eventStore = getEventStore();
  const taskDir = options.taskDir;
  const taskSlug = options.featureSlug;

  function emitEvent(type: Parameters<typeof makeEvent>[0], data?: Record<string, unknown>) {
    if (taskDir) {
      try {
        eventStore.append(taskDir, role!.name, taskSlug, makeEvent(type, data));
      } catch { /* event capture failure is non-fatal */ }
    }
  }

  function resetStallTimer() {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      abortReason = "stall";
      controller.abort();
    }, stallTimeoutMs);
  }

  logger.info({
    role: role.name,
    model: resolvedModel,
    cwd: absoluteCwd,
    taskSlug,
    stallTimeoutMs,
  }, "dispatching agent");

  // Emit dispatch_start event
  emitEvent('dispatch_start', { role: role.name, model: resolvedModel, cwd: absoluteCwd });

  try {
    resetStallTimer();

    for await (const msg of query({
      prompt,
      options: {
        cwd: absoluteCwd,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: assembledPrompt,
        },
        settingSources: ["project"],
        model: resolvedModel,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns,
        maxBudgetUsd,
        outputFormat: {
          type: "json_schema",
          schema: AGENT_RESULT_JSON_SCHEMA,
        },
        abortController: controller,
        pathToClaudeCodeExecutable: process.env.CLAUDE_EXECUTABLE_PATH,
        env: buildChildEnv(config.mcp.streamTimeout),
        ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
        stderr: (data: string) => {
          const line = data.trim();
          if (line) logger.warn({ stderr: line }, "agent subprocess stderr");
        },
      },
    })) {
      resetStallTimer();

      if (msg.type === "system" && msg.subtype === "init") {
        sessionId = msg.session_id;
        model = msg.model;
        logger.info({ sessionId, model }, "agent session started");
      } else if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          // Emit text blocks as chat events
          if (block.type === "text" && typeof (block as Record<string, unknown>).text === "string") {
            const text = (block as Record<string, unknown>).text as string;
            if (text.trim()) {
              logger.info({ sessionId, text: text.slice(0, 200) }, "agent text");
              options.onEvent?.({ type: 'chat', content: text });
              emitEvent('text', { text });
            }
          }

          // Emit thinking blocks
          if (block.type === "thinking" && typeof (block as Record<string, unknown>).thinking === "string") {
            const thinking = (block as Record<string, unknown>).thinking as string;
            if (thinking.trim()) {
              logger.info({ sessionId, thinking: thinking.slice(0, 200) }, "agent thinking");
              options.onEvent?.({ type: 'thinking', content: thinking });
              emitEvent('thinking', { text: thinking });
            }
          }

          if (block.type === "tool_use") {
            const inputSummary = JSON.stringify(block.input as Record<string, unknown>).slice(0, 100);
            logger.debug({ sessionId, tool: block.name, input: inputSummary }, "tool use (full)");

            // Capture structured output directly from the StructuredOutput tool
            // input — the SDK injects this tool when outputFormat is set, but
            // resultMsg.result contains the agent's final text, not this JSON.
            if (block.name === "StructuredOutput") {
              capturedStructuredOutput = block.input;
              logger.debug({ sessionId }, "structured output captured from StructuredOutput tool");
            }

            const target = extractToolTarget(block.name, block.input);

            if (block.name !== "StructuredOutput") {
              logger.info({ sessionId, tool: block.name, target }, "tool use");
              emitEvent('tool_use', { tool: block.name, target, input: inputSummary });
            }

            // Emit tool_use event (skip StructuredOutput — SDK internal)
            if (block.name !== "StructuredOutput") {
              const summary = target ? `${block.name} ${target}` : block.name;
              options.onEvent?.({
                type: 'tool_use',
                content: summary,
                metadata: { tool: block.name, target },
              });
            }

            // Track tool_use_id for matching tool results in user messages
            if (block.id) {
              pendingToolCalls.set(block.id, { tool: block.name, target });
            }

            // Sliding window error loop detection
            toolCallWindow.push({ tool: block.name, target, timestamp: Date.now() });
            if (toolCallWindow.length > 10) toolCallWindow.shift();

            const loopDetection = detectErrorLoop(toolCallWindow, options.loopDetectionThresholds);
            if (loopDetection) {
              if (loopDetection.severity === 'kill' && !humanRespondedSinceWarning) {
                abortReason = 'error_loop';
                emitEvent('loop_kill', { pattern: loopDetection.pattern, count: loopDetection.count });
                controller.abort();
                break; // exit inner block loop; outer for-await throws AbortError
              } else if (loopDetection.severity === 'warning' && !loopWarningPosted) {
                logger.warn({ pattern: loopDetection.pattern, count: loopDetection.count }, 'error loop detected');
                loopWarningPosted = true;
                emitEvent('loop_warning', { pattern: loopDetection.pattern, count: loopDetection.count });
                options.onLoopWarning?.(loopDetection.pattern, loopDetection.count);
              }
            }
          }
        }
      } else if (msg.type === "user") {
        // Inspect tool results for errors (non-retryable detection)
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              typeof block === "object" &&
              block !== null &&
              "type" in block &&
              (block as Record<string, unknown>).type === "tool_result" &&
              (block as Record<string, unknown>).is_error === true
            ) {
              const toolResultBlock = block as Record<string, unknown>;
              const toolUseId = typeof toolResultBlock.tool_use_id === "string" ? toolResultBlock.tool_use_id : "";
              const pending = pendingToolCalls.get(toolUseId);
              if (pending) pendingToolCalls.delete(toolUseId);
              const tool = pending?.tool ?? "unknown";
              const target = pending?.target ?? "";

              // Extract error snippet (first 200 chars, whitespace-normalized)
              let errorSnippet = "";
              if (typeof toolResultBlock.content === "string") {
                errorSnippet = toolResultBlock.content;
              } else if (Array.isArray(toolResultBlock.content)) {
                errorSnippet = (toolResultBlock.content as Array<Record<string, unknown>>)
                  .filter((b) => b.type === "text" && typeof b.text === "string")
                  .map((b) => b.text as string)
                  .join(" ");
              }
              errorSnippet = errorSnippet.replace(/\s+/g, " ").trim().slice(0, 200);

              errorWindow.push({ tool, target, errorSnippet, timestamp: Date.now() });
              if (errorWindow.length > 20) errorWindow.shift();

              const nonRetryable = detectNonRetryable(errorWindow);
              if (nonRetryable) {
                abortReason = "non_retryable_error";
                logger.warn({
                  tool: nonRetryable.tool,
                  target: nonRetryable.target,
                  errorSnippet: nonRetryable.errorSnippet,
                  count: nonRetryable.count,
                }, "non-retryable error detected");
                emitEvent('error', {
                  message: `Non-retryable error: ${nonRetryable.tool}::${nonRetryable.target} (${nonRetryable.count}x)`,
                  snippet: nonRetryable.errorSnippet,
                });
                controller.abort();
              }
            }
          }
        }
      } else if (msg.type === "system" && msg.subtype === "compact_boundary") {
        logger.warn({ sessionId }, "context compacted");
        emitEvent('compaction', {
          trigger: (msg as any).compact_metadata?.trigger ?? 'auto',
          preTokens: (msg as any).compact_metadata?.pre_tokens ?? 0,
        });
        options.onCompaction?.({
          trigger: (msg as any).compact_metadata?.trigger ?? 'auto',
          preTokens: (msg as any).compact_metadata?.pre_tokens ?? 0,
        });
      } else if (msg.type === "result") {
        resultMsg = msg;
        logger.info({
          sessionId,
          status: msg.subtype,
          cost: msg.total_cost_usd,
          model,
          duration_ms: Date.now() - startTime,
        }, "agent completed");
      }
    }

    if (resultMsg && resultMsg.subtype === "success") {
      emitEvent('dispatch_end', { status: 'completed', cost: resultMsg.total_cost_usd });

      // Prefer StructuredOutput tool capture over resultMsg.result (which is
      // the agent's final text and may not be JSON even when outputFormat is set).
      if (capturedStructuredOutput !== undefined) {
        const validated = AgentResultSchema.safeParse(capturedStructuredOutput);
        if (validated.success) {
          return {
            status: "completed",
            structuredResult: validated.data,
            cost: resultMsg.total_cost_usd,
            duration_ms: Date.now() - startTime,
            model: resolvedModel,
            usage: extractUsageMetrics(resultMsg),
          };
        }
        logger.warn({ input: capturedStructuredOutput }, "StructuredOutput tool input failed schema validation, using raw text");
      }

      // Fall back: try to parse resultMsg.result as JSON
      if (resultMsg.result) {
        try {
          const parsed = JSON.parse(resultMsg.result) as unknown;
          const validated = AgentResultSchema.safeParse(parsed);
          if (validated.success) {
            return {
              status: "completed",
              structuredResult: validated.data,
              cost: resultMsg.total_cost_usd,
              duration_ms: Date.now() - startTime,
              model: resolvedModel,
              usage: extractUsageMetrics(resultMsg),
            };
          }
          logger.warn({ result: resultMsg.result.slice(0, 200) }, "structured output validation failed, using raw text");
        } catch {
          logger.warn("agent result is not valid JSON, using raw text");
        }
        return {
          status: "completed",
          result: resultMsg.result,
          cost: resultMsg.total_cost_usd,
          duration_ms: Date.now() - startTime,
          model: resolvedModel,
          usage: extractUsageMetrics(resultMsg),
        };
      }

      return { status: "completed", cost: resultMsg.total_cost_usd, duration_ms: Date.now() - startTime, model: resolvedModel, usage: extractUsageMetrics(resultMsg) };
    }

    if (resultMsg) {
      // Error subtypes: error_max_turns, error_max_budget_usd → aborted
      //                 error_during_execution, error_max_structured_output_retries → crashed
      const subtype = resultMsg.subtype;
      const isHardLimit = subtype === "error_max_turns" || subtype === "error_max_budget_usd";
      logger.warn({ subtype, cost: resultMsg.total_cost_usd }, `agent stopped with error: ${subtype}`);
      emitEvent('dispatch_end', { status: isHardLimit ? 'aborted' : 'crashed', reason: subtype, cost: resultMsg.total_cost_usd });
      return {
        status: isHardLimit ? "aborted" : "crashed",
        error: subtype,
        cost: resultMsg.total_cost_usd,
        duration_ms: Date.now() - startTime,
        model: resolvedModel,
        usage: extractUsageMetrics(resultMsg),
      };
    }

    emitEvent('dispatch_end', { status: 'completed' });
    return { status: "completed", duration_ms: Date.now() - startTime, model: resolvedModel };
  } catch (err) {
    if (err instanceof AbortError) {
      if (abortReason === "stall") {
        logger.warn({ prompt: prompt.slice(0, 50), stallTimeoutMs }, "agent stalled (inactivity timeout)");
        emitEvent('stall', { timeoutMs: stallTimeoutMs });
      } else if (abortReason === "error_loop") {
        // Event already emitted before controller.abort()
        logger.warn({ prompt: prompt.slice(0, 50) }, "agent killed: error loop");
      } else if (abortReason === "non_retryable_error") {
        // Event already emitted before controller.abort()
        logger.warn({ prompt: prompt.slice(0, 50) }, "agent killed: non-retryable error");
      } else {
        logger.warn({ prompt: prompt.slice(0, 50) }, "agent aborted");
        emitEvent('abort', { reason: abortReason ?? 'external' });
      }
      emitEvent('dispatch_end', { status: 'aborted', reason: abortReason });
      return { status: "aborted", cost: resultMsg?.total_cost_usd, duration_ms: Date.now() - startTime, model: resolvedModel, usage: resultMsg ? extractUsageMetrics(resultMsg) : undefined };
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, message }, "agent crashed");
    emitEvent('error', { message });
    emitEvent('dispatch_end', { status: 'crashed', error: message });
    logger.flush();
    return { status: "crashed", error: message, duration_ms: Date.now() - startTime, model: resolvedModel };
  } finally {
    if (stallTimer !== undefined) {
      clearTimeout(stallTimer);
    }
  }
}
