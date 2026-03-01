import { z } from 'zod';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

// Re-export communication layer types for convenience
export type { InboundMessage, ChannelMessage, CommAdapter } from './comms.js';
export type { Project } from './project.js';

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
  // Common entity fields
  id: string;                    // ULID (26 chars)
  version: string;               // Semver
  name: string;                  // [a-z0-9-], 1-64 chars
  description: string;           // 1-1024 chars
  createdOn: string;             // RFC 3339
  createdBy: string;             // 1-32 chars
  updatedOn?: string;            // RFC 3339
  updatedBy?: string;            // 0-32 chars
  displayName?: string;          // 0-64 chars, falls back to name
  metadata?: Record<string, string>;
  // Role-specific fields
  modelHint: string;             // 'opus-latest' | 'sonnet-latest' | 'haiku-latest'
  permissions?: string[];        // 'agent-draft' | 'projects-list' | 'projects-create'
  // Body
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
  cwd: string;           // target project dir (relative to platform root) — required
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
  project: string;
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
  staleRole?: boolean;      // true if recovered draft references a role that no longer exists
};

export type DraftSummary = {
  sessionId: string;
  taskSlug: string;
  turns: number;
  costUsd: number;
  durationMs: number;
};

// ── Event Capture ────────────────────────────────────────────

export type EventCategory = 'agent' | 'session' | 'harness' | 'user' | 'system';

export type EventType =
  // Agent activity
  | 'agent:text'
  | 'agent:thinking'
  | 'agent:tool_call'
  | 'agent:tool_result'
  // Session lifecycle
  | 'session:init'
  | 'session:complete'
  | 'session:compaction'
  | 'session:rate_limit'
  | 'session:status'
  // Harness interventions
  | 'harness:loop_warning'
  | 'harness:loop_kill'
  | 'harness:stall'
  | 'harness:abort'
  | 'harness:error'
  // Interaction
  | 'user:message'
  // System observations
  | 'system:files_persisted'
  | 'system:hook_started'
  | 'system:hook_progress'
  | 'system:hook_response';

export type CapturedEvent = {
  id: string;                          // ULID
  type: EventType;
  timestamp: string;                   // RFC 3339
  data?: Record<string, unknown>;
};

export type DispatchEnvelope = {
  dispatchId: string;                  // ULID
  taskSlug: string;
  role: string;
  model: string;
  cwd: string;
  startedAt: string;                   // RFC 3339
  completedAt?: string;                // RFC 3339 — null while running
  status: 'running' | 'completed' | 'aborted' | 'crashed';
  cost?: number;
  usage?: UsageMetrics;
  structuredResult?: AgentResult;
  parentDispatchId?: string;           // null for top-level
  botId?: string;                      // null (future)
};

export type DispatchFile = DispatchEnvelope & {
  events: CapturedEvent[];
};

export type DispatchIndexEntry = {
  dispatchId: string;
  role: string;
  status: string;
  cost?: number;
  startedAt: string;
  parentDispatchId?: string;
};
