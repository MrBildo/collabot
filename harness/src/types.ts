import { z } from 'zod';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

// Re-export communication layer types for convenience
export type { InboundMessage, ChannelMessage, CommAdapter } from './comms.js';

export const AgentResultSchema = z.object({
  status: z.enum(['success', 'partial', 'failed', 'blocked']),
  summary: z.string(),
  changes: z.array(z.string()).optional(),
  issues: z.array(z.string()).optional(),
  questions: z.array(z.string()).optional(),
  pr_url: z.string().optional(),
});

export type AgentResult = z.infer<typeof AgentResultSchema>;

export type RoleDefinition = {
  name: string;
  displayName: string;
  category: string;
  model?: string;
  cwd?: string;
  prompt: string;
};

export type UsageMetrics = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextWindow: number;     // modelUsage[model].contextWindow
  maxOutputTokens: number;   // modelUsage[model].maxOutputTokens
  numTurns: number;
  durationApiMs: number;
};

export type DispatchResult = {
  status: 'completed' | 'aborted' | 'crashed';
  result?: string;              // raw text (fallback)
  structuredResult?: AgentResult;  // validated structured output
  cost?: number;
  error?: string;
  duration_ms?: number;
  journalFile?: string;         // journal filename (e.g., 'api-dev.md') — set by dispatch()
  model?: string;               // resolved model used for this dispatch
  usage?: UsageMetrics;
};

export type JournalOptions = {
  featureSlug: string;
  roleName: string;
  project: string;     // project name for the header (e.g., "backend-api")
  model: string;       // resolved model name for the initial log entry
  cwd: string;         // absolute path to target project — journal dir created here
  branch?: string;
  specPath?: string;
  taskDir?: string;         // Milestone C: task directory for journal placement
  journalFileName?: string; // Milestone C: custom filename (from nextJournalFile)
};

export type ToolCall = {
  tool: string;
  target: string;
  timestamp: number;
};

export type LoopDetectionThresholds = {
  repeatWarn: number;    // 0 = unlimited
  repeatKill: number;    // 0 = unlimited
  pingPongWarn: number;  // 0 = unlimited (alternation count)
  pingPongKill: number;  // 0 = unlimited (alternation count)
};

export type LoopDetection = {
  type: 'genericRepeat' | 'pingPong';
  pattern: string;   // e.g., "Bash::dotnet build" or "Read::foo.ts ↔ Edit::foo.ts"
  count: number;
  severity: 'warning' | 'kill';
};

export type ErrorTriplet = {
  tool: string;
  target: string;
  errorSnippet: string;  // first 200 chars, whitespace-normalized
  timestamp: number;
};

export type NonRetryableDetection = {
  tool: string;
  target: string;
  errorSnippet: string;
  count: number;
};

/** An event emitted from the SDK event stream during agent execution. */
export type AgentEvent = {
  type: 'chat' | 'tool_use' | 'thinking';
  content: string;
  metadata?: Record<string, unknown>;
};

export type DispatchOptions = {
  cwd?: string;          // target project dir (relative to platform root) — falls back to role.cwd
  role: string;          // role name to look up
  featureSlug: string;   // for journal path construction
  taskDir?: string;      // Milestone C: task directory for journal placement
  journalFileName?: string; // Milestone C: custom journal filename
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;        // per-dispatch override (highest priority)
  onLoopWarning?: (pattern: string, count: number) => void;
  onEvent?: (event: AgentEvent) => void; // SDK event stream forwarding (chat, tool_use, thinking)
  abortController?: AbortController; // Milestone E: external abort control (pool.kill() propagation)
  mcpServers?: Record<string, McpServerConfig>; // Milestone F: MCP servers to inject into child agent
  onCompaction?: (event: { trigger: string; preTokens: number }) => void;
  loopDetectionThresholds?: LoopDetectionThresholds;
};

export type DraftSession = {
  sessionId: string;
  agentId: string;
  role: string;
  taskSlug: string;
  taskDir: string;
  channelId: string;
  startedAt: string;       // ISO
  lastActivityAt: string;  // ISO
  turnCount: number;
  status: 'active' | 'closed';
  sessionInitialized: boolean;  // true after first query() starts — SDK session files exist on disk
  cumulativeCostUsd: number;
  lastInputTokens: number;
  lastOutputTokens: number;
  contextWindow: number;
  maxOutputTokens: number;
};

export type DraftSummary = {
  sessionId: string;
  taskSlug: string;
  turns: number;
  costUsd: number;
  durationMs: number;
};
