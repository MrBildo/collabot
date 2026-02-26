# Draft Sessions — Conversational Agent Interaction

| Field | Value |
|-------|-------|
| **Source** | Spec discussion 2026-02-22 |
| **Status** | **Draft** |
| **Created** | 2026-02-22 |

## Summary

Add a conversational draft session model to the harness. A user drafts an agent by role, interacts with it back-and-forth like a Claude Code CLI session, and undrafts when done. The drafted agent can itself draft worker agents (if its role permits), delegating tasks while maintaining a conversation with the user.

This leverages the Agent SDK's native session resume (`resume` option on `query()`) for conversation continuity. The harness manages session lifecycle, context metrics, and cost tracking. Worker agents dispatched by the drafted agent continue to use the existing autonomous dispatch path with structured output.

## Mental Model

```
User (TUI) ←→ Harness ←→ Drafted Agent (conversational, persistent session)
                                ↓
                         Worker Agents (autonomous, structured output, ephemeral)
```

- One active draft per TUI session (for now)
- TUI is scoped to a single project (for now — project scoping is a separate effort)
- The drafted agent is the only agent that talks to the user
- Workers report back to the drafted agent via MCP `await_agent` → structured `DispatchResult`

## Design Decisions

### SDK Session Resume Over Custom Context Reconstruction

The SDK's `query()` supports `sessionId` (assign on first turn) and `resume` (resume on follow-ups). Session state is persisted to disk by the SDK. This gives us true conversation continuity without building our own message history management.

**First turn:** `query({ prompt, options: { sessionId, ... } })`
**Follow-up turns:** `query({ prompt, options: { resume: sessionId, ... } })`

Each turn still spawns a subprocess (cold-start), but the SDK loads conversation history from disk. The agent sees the full prior conversation natively.

### Two Dispatch Paths

| Concern | Draft session (conversational) | Task dispatch (autonomous) |
|---------|-------------------------------|---------------------------|
| Output format | None — agent responds naturally | Structured JSON schema |
| Session | Resumed via sessionId | Fresh each dispatch |
| Result | Text stream to user | Parsed AgentResult |
| MCP tools | Permissions-gated per role | Permissions-gated per role |
| Pool tracking | Register on draft, release on undraft | Register → release on completion |
| Initiated by | User via TUI | User via any adapter, or agent via MCP |

The existing `handleTask` → `draftAgent` → `dispatch` path remains unchanged for autonomous work. Draft sessions add a parallel path.

### MCP Gating Unchanged

MCP tool access is permissions-driven via the role's `permissions` frontmatter field (see `docs/specs/role-system-v2.md`). A drafted `product-analyst` with `permissions: [agent-draft, projects-list, projects-create]` gets full MCP tools (draft/await/kill). A drafted `dotnet-dev` with no permissions gets readonly tools.

### Manual Compaction Not Available

The SDK does not expose a method to trigger manual compaction. Auto-compaction is handled internally by the SDK when context pressure is high. A `/compact` command is **not feasible** in this iteration. The `/context` command surfaces metrics so the user knows where they stand.

---

## Data Model

### DraftSession

```typescript
type DraftSession = {
  sessionId: string;         // SDK session ID (UUID, assigned by harness)
  role: string;              // role name
  taskSlug: string;          // task tracking
  taskDir: string;           // .agents/tasks/{slug}/
  channelId: string;         // adapter routing
  startedAt: Date;
  lastActivityAt: Date;
  turnCount: number;         // number of user→agent exchanges
  status: 'active' | 'closed';

  // Metrics (updated after each turn)
  cumulativeCostUsd: number;
  lastInputTokens: number;   // input tokens on most recent turn (≈ context usage)
  lastOutputTokens: number;
  contextWindow: number;     // model's total context window size
  maxOutputTokens: number;
};
```

### Persistence

Draft session state persists to `{taskDir}/draft.json`. On harness restart:

1. Scan task directories for `draft.json` with `status: 'active'`
2. Reconstruct `DraftSession` in memory
3. SDK session files exist on disk — next user message triggers `resume` transparently
4. User doesn't need to know the harness restarted

---

## Metrics Capture

The SDK's `SDKResultMessage` (emitted at end of each `query()` call) contains:

| Field | Use |
|-------|-----|
| `total_cost_usd` | Accumulate on `cumulativeCostUsd` |
| `usage.inputTokens` | Store as `lastInputTokens` — approximates current context size |
| `usage.outputTokens` | Store as `lastOutputTokens` |
| `modelUsage[model].contextWindow` | Total context window for the model |
| `modelUsage[model].maxOutputTokens` | Max output capacity |
| `num_turns` | Log for diagnostics |

**Context percentage:** `(lastInputTokens / contextWindow) * 100`

This is an approximation — `inputTokens` on the most recent turn reflects conversation history + system prompt + new message + tool results. It's the best proxy for "how full is the context window" without internal SDK access.

The SDK also emits `SDKCompactBoundaryMessage` (subtype `compact_boundary`) when auto-compaction fires, with `pre_tokens` (token count before compaction). The harness should capture this and notify the TUI.

---

## WS Protocol Changes

### New Methods (Client → Server)

| Method | Params | Result | Description |
|--------|--------|--------|-------------|
| `draft` | `{ role, project, task }` | `{ sessionId, taskSlug, project }` | Draft an agent by role into an existing task. Error if draft already active or task not found. |
| `undraft` | `{}` | `{ sessionId, taskSlug, turns, cost }` | Close the active draft. Returns session summary. Error if no active draft. |
| `get_draft_status` | `{}` | `{ active, session? }` | Returns current draft state including metrics. `active: false` if no draft. |

### Modified Method

**`submit_prompt`** — when a draft is active, the prompt routes to the draft session automatically. No changes to the method signature (`{ content, role?, taskSlug? }`). The harness checks for an active draft first:

1. If active draft exists → route to draft session (resume)
2. If no draft → existing behavior (autonomous dispatch)

The `role` and `taskSlug` params are ignored when a draft is active — the draft owns routing.

### New Notifications (Server → Client)

| Method | Params | Description |
|--------|--------|-------------|
| `draft_status` | `{ sessionId, role, turnCount, costUsd, contextPct, lastActivity }` | Pushed after each turn completes. TUI updates status display. |
| `context_compacted` | `{ sessionId, preTokens, trigger }` | Pushed when SDK auto-compaction fires. |

### New Error Codes

| Code | Meaning |
|------|---------|
| `-32004` | Draft already active |
| `-32005` | No active draft |

---

## TUI Changes

### New Commands

| Command | Action |
|---------|--------|
| `/draft <role>` | Call `draft` RPC with active project + task. Requires both. On success, TUI enters "draft mode" — title bar updates, subsequent messages route to draft. |
| `/undraft` | Call `undraft` RPC. TUI exits draft mode. Display session summary (turns, cost, duration). |
| `/context` | Call `get_draft_status` RPC. Display context metrics: input tokens, context window, % used, cumulative cost, turn count. |

### Title Bar Updates

When a draft is active, the title bar should show:

```
Collabot ● Connected | Draft: product-analyst | Context: 34% | Turns: 5 | $0.23
```

When no draft is active:

```
Collabot ● Connected | No draft | Agents: 0
```

### Message Flow in Draft Mode

1. User types a message (not a slash command)
2. TUI calls `submit_prompt({ content: message })`
3. Harness routes to active draft session
4. Agent streams responses back as `channel_message` notifications (same as today)
5. When the turn completes, harness pushes `draft_status` notification
6. TUI updates title bar metrics

---

## Harness Implementation

### New Module: `harness/src/draft.ts`

Manages draft session lifecycle:

- `createDraft({ role, project, projectsDir, taskSlug, taskDir, channelId, pool })` → DraftSession
  - Generate sessionId (UUID)
  - Task is required — provided by caller (adapter resolves before calling)
  - Register in pool (stays registered until undraft)
  - Persist `draft.json`
  - Return session

- `resumeDraft(session, prompt, adapter)` → void
  - Call `query()` with `resume: session.sessionId`
  - Stream responses to adapter
  - On completion: update metrics from `SDKResultMessage`, persist `draft.json`, push `draft_status`

- `closeDraft(session, pool)` → DraftSummary
  - Release from pool
  - Update `draft.json` with `status: 'closed'`
  - Return summary (turns, cost, duration)

- `loadActiveDraft(tasksDir)` → DraftSession | null
  - Scan for `draft.json` with `status: 'active'`
  - Reconstruct in memory

### Modified: `harness/src/dispatch.ts`

Extract metrics from `SDKResultMessage` that are currently ignored:

```typescript
// On result message:
usage: msg.usage,                              // inputTokens, outputTokens, cache tokens
modelUsage: msg.modelUsage,                    // contextWindow, maxOutputTokens per model
numTurns: msg.num_turns,
durationApiMs: msg.duration_api_ms,
```

This benefits both draft sessions (context tracking) and autonomous dispatch (better observability).

### Modified: `harness/src/ws-methods.ts`

Register new RPC methods: `draft`, `undraft`, `get_draft_status`.

Modify `submit_prompt` handler to check for active draft before falling through to `handleTask`.

### Modified: `harness/src/index.ts`

- Load active draft on startup (crash recovery)
- Pass draft state to WS method registration

---

## Harness Restart / Crash Recovery

| Scenario | Recovery |
|----------|----------|
| Harness restarts, draft was active | `loadActiveDraft()` finds `draft.json`. Next user message triggers `resume` against existing SDK session files. Seamless. |
| Harness restarts, agent was mid-turn | Agent process dies. Turn is lost. Next user message starts a new turn with `resume` — SDK replays history up to last completed turn. |
| SDK session files corrupted/deleted | `resume` fails. Harness catches error, notifies user, auto-undrafts. User can `/draft` again (fresh session). |

---

## Implementation Steps

### Step 1: Metrics Capture in Dispatch

**Scope:** `harness/src/dispatch.ts`, `harness/src/types.ts`

- Extend `DispatchResult` with usage metrics (inputTokens, outputTokens, contextWindow, maxOutputTokens)
- Capture from `SDKResultMessage.usage` and `SDKResultMessage.modelUsage`
- Capture `compact_boundary` events
- This benefits all dispatch paths, not just draft sessions

### Step 2: DraftSession Data Model + Lifecycle

**Scope:** New `harness/src/draft.ts`, `harness/src/types.ts`

- `DraftSession` type
- `createDraft()` — session creation, pool registration, persistence (task provided by caller)
- `closeDraft()` — pool release, persistence, summary
- `loadActiveDraft()` — crash recovery
- `draft.json` read/write

### Step 3: Conversational Dispatch Path

**Scope:** `harness/src/draft.ts`, `harness/src/dispatch.ts`

- `resumeDraft()` — call `query()` with `resume` (follow-ups) or `sessionId` (first turn)
- No `outputFormat` — agent responds naturally
- Stream text responses to adapter via `channel_message` notifications
- Update metrics on turn completion
- MCP server injection (permissions-gated per role frontmatter)

### Step 4: WS Protocol + Method Registration

**Scope:** `harness/src/ws-methods.ts`, `harness/src/adapters/ws.ts`

- `draft` method — validate project + task + no active draft, create session, return sessionId + taskSlug + project
- `undraft` method — validate active draft, close session, return summary
- `get_draft_status` method — return current draft state + metrics
- Modify `submit_prompt` — check for active draft, route accordingly
- `draft_status` notification after each turn
- `context_compacted` notification on compaction events

### Step 5: TUI Commands + Status Display

**Scope:** `harness/tui/Views/MainWindow.cs`, `harness/tui/Services/HarnessConnection.cs`, `harness/tui/Models/Protocol.cs`

- `/draft <role>` command — call `draft` RPC, enter draft mode
- `/undraft` command — call `undraft` RPC, display summary, exit draft mode
- `/context` command — call `get_draft_status`, display metrics
- Title bar: show draft role, context %, turn count, cost when draft is active
- Handle `draft_status` notifications — update local state + title bar
- Handle `context_compacted` notifications — display system message

---

## Future Direction: Agent-to-Agent Conversation

Currently, worker agents drafted by the user's agent use autonomous dispatch (structured output, fire-and-forget via MCP `draft_agent`/`await_agent`). In a future iteration, the user-drafted agent should be able to hold conversational sessions with its own drafted agents — the same resume-based model, but between agents rather than between user and agent. This enables richer collaboration patterns (e.g., PM discusses architecture with an API dev before committing to a plan). Not in scope for this spec.

## Out of Scope

- **Multiple concurrent drafts** — one draft at a time for now.
- **Manual compaction (`/compact`)** — SDK doesn't expose this. Rely on auto-compaction.
- **Bot abstraction** — persistent identity/personality layer sits above this. Future work.
- **Web UI / mobile adapters** — protocol is adapter-agnostic, but only TUI is implemented.
