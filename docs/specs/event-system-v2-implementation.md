# Event System v2 — Implementation Plan

| Field | Value |
|-------|-------|
| **Spec** | `docs/specs/event-system-v2.md` |
| **Created** | 2026-03-01 |
| **Branch** | `feature/event-system-v2` |

## Phase Overview

```
Phase 1: Foundation (types + provider interface + JsonFileDispatchStore)
         Sequential — everything else depends on this.
         Branch: feature/event-system-v2

Phase 2: Write path + Read path (PARALLEL)
         Agent A: dispatch.ts + draft.ts refactor (write path)
         Agent B: read utilities + context.ts + mcp.ts (read path)
         Both work on feature/event-system-v2 branch.

Phase 3: Migration + cleanup + integration testing
         Sequential — needs Phase 2 complete.

Phase 4: PR review + merge
```

---

## Phase 1: Foundation

**Goal:** New types, `DispatchStoreProvider` interface, and `JsonFileDispatchStore` implementation. After this phase, both Phase 2 agents have a stable foundation to build on.

**Files to create/modify:**
- `harness/src/dispatch-store.ts` — NEW: `DispatchStoreProvider` interface + `JsonFileDispatchStore` implementation
- `harness/src/dispatch-store.test.ts` — NEW: tests for the store
- `harness/src/types.ts` — update: new event types, dispatch envelope type, replace old event types

**Files NOT to touch:**
- `dispatch.ts`, `draft.ts`, `context.ts`, `mcp.ts` — Phase 2 work
- `events.ts` — still used by current code, removed in Phase 3

### Types to define in `types.ts`

Replace the existing event capture types (lines 148-175) with:

```typescript
// ── Event System v2 ───────────────────────────────────────

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

export type CapturedEventV2 = {
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
  events: CapturedEventV2[];
};

export type DispatchIndexEntry = {
  dispatchId: string;
  role: string;
  status: string;
  cost?: number;
  startedAt: string;
  parentDispatchId?: string;
};
```

### DispatchStoreProvider interface in `dispatch-store.ts`

```typescript
export interface DispatchStoreProvider {
  createDispatch(taskDir: string, envelope: DispatchEnvelope): void;
  updateDispatch(taskDir: string, dispatchId: string, updates: Partial<DispatchEnvelope>): void;
  appendEvent(taskDir: string, dispatchId: string, event: CapturedEventV2): void;
  getDispatchEnvelopes(taskDir: string): DispatchEnvelope[];
  getDispatchEnvelope(taskDir: string, dispatchId: string): DispatchEnvelope | null;
  getDispatchEvents(taskDir: string, dispatchId: string): CapturedEventV2[];
  getRecentEvents(taskDir: string, dispatchId: string, count: number): CapturedEventV2[];
}
```

### JsonFileDispatchStore implementation

- Creates `dispatches/` subdirectory under taskDir
- Each dispatch: `dispatches/{dispatchId}.json` containing `DispatchFile` (envelope + events)
- Maintains dispatch index in `task.json` (read-modify-write the `dispatches` array)
- `appendEvent` reads the dispatch file, pushes the event, writes back
- `getRecentEvents` reads the file, slices the last N events

### Tests

- Create dispatch, verify file exists with correct envelope
- Append events, verify they accumulate in the file
- Update dispatch (status, cost, structuredResult), verify envelope updates
- Verify task.json dispatch index is maintained
- Read envelopes from index
- Read events from dispatch file
- getRecentEvents returns correct slice
- Handle missing/corrupt files gracefully

### Acceptance criteria

- [ ] `DispatchStoreProvider` interface exported from `dispatch-store.ts`
- [ ] `JsonFileDispatchStore` implements the interface
- [ ] All tests pass
- [ ] `task.json` dispatch index maintained correctly
- [ ] Old types (`CapturedEventType`, `CapturedEvent`, `EventLog`) still exist (not removed yet — Phase 3)
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (existing tests still work)

---

## Phase 2A: Write Path (dispatch.ts + draft.ts)

**Depends on:** Phase 1 complete

**Goal:** Refactor `dispatch.ts` and `draft.ts` to emit v2 events through `DispatchStoreProvider` instead of the old `EventStore`. Capture all SDK events we're currently dropping.

**Files to modify:**
- `harness/src/dispatch.ts` — use `DispatchStoreProvider`, emit v2 events, capture new SDK message types
- `harness/src/draft.ts` — same treatment, plus `user:message` events for conversation turns

**Files NOT to touch:**
- `context.ts`, `mcp.ts` — Phase 2B work
- `events.ts` — still exists, removed in Phase 3
- `types.ts`, `dispatch-store.ts` — Phase 1 (already done)

### dispatch.ts changes

1. Import `DispatchStoreProvider` and get the singleton (or accept as parameter)
2. At dispatch start: call `createDispatch()` with envelope (status: 'running')
3. Replace all `emitEvent()` calls with `appendEvent()` using v2 event types:
   - `dispatch_start` → `session:init`
   - `text` → `agent:text`
   - `thinking` → `agent:thinking`
   - `tool_use` → `agent:tool_call` (with `toolCallId` from block.id)
   - NEW: `agent:tool_result` — emit from the `user` message handler when tool_result blocks arrive
   - `compaction` → `session:compaction`
   - `loop_warning` → `harness:loop_warning`
   - `loop_kill` → `harness:loop_kill`
   - `stall` → `harness:stall`
   - `abort` → `harness:abort`
   - `error` → `harness:error`
   - `dispatch_end` → `session:complete`
4. Capture new SDK messages we're currently dropping:
   - `system/status` → `session:status`
   - `system/files_persisted` → `system:files_persisted`
   - `system/hook_started` → `system:hook_started`
   - `system/hook_progress` → `system:hook_progress`
   - `system/hook_response` → `system:hook_response`
   - `rate_limit` → `session:rate_limit` (if the SDK emits it)
5. At dispatch end: call `updateDispatch()` with final status, cost, usage, structuredResult
6. Tool metadata: use `extractToolTarget()` (from `journal.ts`) for target, populate generic metadata bag based on tool type

### draft.ts changes

Same event mapping as dispatch.ts, plus:
1. Emit `user:message` event when the user sends a message during a draft session
2. The `dispatchId` should be created when the draft session starts and persist across turns (one dispatch per draft session per D11)

### Tests

- Verify v2 events are emitted for each SDK message type
- Verify dispatch envelope is created at start and updated at end
- Verify `agent:tool_call` + `agent:tool_result` pairs are linked by `toolCallId`
- Verify `user:message` events appear in draft session dispatches
- Existing loop detection, stall detection, structured output parsing still work

### Acceptance criteria

- [ ] dispatch.ts emits all v2 event types through DispatchStoreProvider
- [ ] draft.ts emits all v2 event types including user:message
- [ ] All currently-dropped SDK events are now captured
- [ ] Tool call/result pairs linked by toolCallId
- [ ] Dispatch envelope created at start, updated at end with cost/usage/result
- [ ] Existing dispatch behavior unchanged (structured output, loop detection, stall timer)
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes

---

## Phase 2B: Read Path (context.ts + mcp.ts + utilities)

**Depends on:** Phase 1 complete. **Independent of Phase 2A.**

**Goal:** Build read-time utility functions and update consumers to use the new dispatch store.

**Files to modify:**
- `harness/src/context.ts` — rewrite `buildTaskContext()` to read from dispatch envelopes
- `harness/src/mcp.ts` — update `get_task_context` tool to use new store
- `harness/src/dispatch-store.ts` — add utility functions if not already there from Phase 1

**Files to create:**
- `harness/src/session-view.ts` — NEW: `renderSessionView()` (replaces `renderJournalView()`)
- `harness/src/session-view.test.ts` — NEW: tests

**Files NOT to touch:**
- `dispatch.ts`, `draft.ts` — Phase 2A work
- `events.ts` — still exists, removed in Phase 3

### context.ts rewrite

`buildTaskContext()` currently reads `task.json` dispatch records. Rewrite to:
1. Read dispatch envelopes via `getDispatchEnvelopes(taskDir)`
2. Filter to dispatches with `structuredResult`
3. Build the same markdown context format (task history, previous work, changes, issues, questions)
4. The output format stays the same — this is a transparent refactor of the data source

### mcp.ts updates

`get_task_context` tool calls `buildTaskContext()` — should work automatically after context.ts rewrite.

For `draft_agent` / `await_agent`: when a child dispatch is created via MCP, the `parentDispatchId` must be set to the parent's dispatch ID. This requires the parent's dispatch ID to be available in the MCP tool context. Check how `options.parentTaskDir` is currently passed and extend with `parentDispatchId`.

### renderSessionView()

New function replacing `renderJournalView()`. Takes a dispatch ID and renders the full session log:

```
## Session: ts-dev (01JM...)
Model: claude-sonnet-4-6 | Started: 10:00:00 | Cost: $0.08

10:00:01 [thinking] Let me analyze the routing options...
10:00:05 [tool] Read src/router.ts (45ms)
10:00:06 [text] Based on the current router implementation...
10:00:15 [tool] Edit src/router.ts (120ms)
10:00:16 [text] I've updated the router to support...
10:02:33 [complete] Success — $0.08, 45K input / 3.2K output, 8 turns
```

This is the view used for TUI session reconstruction and PM check-ins.

### Tests

- `buildTaskContext()` reads from new dispatch envelopes
- `buildTaskContext()` handles tasks with no dispatches, dispatches with no results
- `renderSessionView()` produces correct chronological output
- `renderSessionView()` handles all event types
- MCP `get_task_context` returns correct data from new store

### Acceptance criteria

- [ ] `buildTaskContext()` reads from DispatchStoreProvider
- [ ] `renderSessionView()` reconstructs full session log
- [ ] MCP tools use new dispatch store
- [ ] Parent dispatch ID propagated for child dispatches via MCP
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes

---

## Phase 3: Migration + Cleanup + Phase 2 Fixes

**Depends on:** Phase 2A and 2B complete (merged into `release/event-system-v2`)

**Goal:** Remove old code, fix issues found in Phase 2 review, verify end-to-end.

### Original Phase 3 scope

**Files to modify/remove:**
- `harness/src/events.ts` — REMOVE (replaced by dispatch-store.ts)
- `harness/src/events.test.ts` — REMOVE
- `harness/src/journal.ts` — REMOVE `watchJournals()`, `getJournalStatus()`. KEEP `extractToolTarget()` (move to `dispatch.ts` or a shared util)
- `harness/src/types.ts` — REMOVE old event types (`CapturedEventType`, `CapturedEvent`, `EventLog`)
- `harness/src/task.ts` — update `TaskManifest` type: `dispatches` becomes `DispatchIndexEntry[]`
- `harness/src/core.ts` — remove `recordDispatch` calls (new dispatch store handles this)
- Any remaining imports of old event types (old types were already removed from `types.ts` in Phase 1)

### Phase 2 review fixes (folded into Phase 3)

**Issue 1 (HIGH): `parentDispatchId` not propagated end-to-end.**
MCP layer (`mcp.ts`) correctly passes `parentDispatchId` to `draftFn`, but it's dropped before reaching `dispatch.ts`. Fix:
- Add `parentDispatchId?: string` to `DispatchOptions` in `types.ts`
- Pass it through `draftFn` in `index.ts` and `cli.ts` to `draftAgent()` in `core.ts`
- Pass it through `core.ts` `draftAgent()` to `dispatch()` in `dispatch.ts`
- Set it on the `DispatchEnvelope` in `dispatch.ts` `createDispatch()` call

**Issue 2 (HIGH): Dual-write — old `recordDispatch()` still called.**
- Remove `recordDispatch()` call from `core.ts` `handleTask()` (lines ~251-263)
- Remove `recordDispatch()` call from `mcp.ts` `await_agent` (lines ~320-329)
- The new dispatch store already handles this via `createDispatch()` / `updateDispatch()`

**Issue 3 (MEDIUM): Field name mismatches in `session-view.ts`.**
- `session:status` events: `dispatch.ts` emits `{ status }` but `session-view.ts` reads `data.message`. Fix renderer to read `data.status`.
- `system:hook_*` events: `dispatch.ts` emits `{ hookName }` but `session-view.ts` reads `data.hook`. Fix renderer to read `data.hookName`.

**Issue 4 (LOW): Text truncation inconsistency.**
- `draft.ts` truncates `agent:text` / `agent:thinking` to 2000 chars, `dispatch.ts` captures full text
- Normalize: both should truncate to 2000 chars

**Issue 5 (LOW): Wrong event type for non-retryable errors in `draft.ts`.**
- `draft.ts` emits `harness:loop_kill` for non-retryable error detection — should be `harness:error`

### Migration considerations

- Existing tasks have `events.json` + old-format `task.json` with `DispatchRecord[]`
- Recommendation: ignore old data — it's pre-production dev data. Old files are just ignored by the new code.

### Acceptance criteria

- [ ] Old `events.ts` and `events.test.ts` removed
- [ ] `extractToolTarget()` preserved (moved to shared location)
- [ ] No remaining imports of old event types
- [ ] `task.json` uses `DispatchIndexEntry[]` format
- [ ] `parentDispatchId` propagated end-to-end from MCP through to dispatch envelope
- [ ] Old `recordDispatch()` calls removed — no dual-write
- [ ] `session-view.ts` field names match emitter (`data.status`, `data.hookName`)
- [ ] Text truncation consistent between `dispatch.ts` and `draft.ts`
- [ ] Non-retryable error in `draft.ts` emits `harness:error` not `harness:loop_kill`
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes

---

## Dispatch Prompts

### Phase 1 — Foundation (COMPLETE)

Implemented on `release/event-system-v2` at commits `c096e26` + `26ed369`.

### Phase 2A — Write Path

Open Claude Code in `../collabot-wt-write-path/harness/`

> You are in a git worktree on branch `feature/esv2-write-path` (branched from `release/event-system-v2` with Phase 1 complete). Read the spec at `docs/specs/event-system-v2.md` and the implementation plan at `docs/specs/event-system-v2-implementation.md`. Implement **Phase 2A: Write Path** — refactor `dispatch.ts` and `draft.ts` to emit events through `DispatchStoreProvider` instead of the old `EventStore`. Capture all SDK event types we're currently dropping. Emit `user:message` events in draft sessions. Link tool call/result pairs via `toolCallId`. Create dispatch envelopes at start, update at end. Do NOT modify `context.ts` or `mcp.ts` — a parallel agent is handling those in a separate worktree. Do NOT remove `events.ts` — Phase 3. Run `npm run typecheck` and `npm test`. When everything passes, commit your changes and push to origin.

### Phase 2B — Read Path

Open Claude Code in `../collabot-wt-read-path/harness/`

> You are in a git worktree on branch `feature/esv2-read-path` (branched from `release/event-system-v2` with Phase 1 complete). Read the spec at `docs/specs/event-system-v2.md` and the implementation plan at `docs/specs/event-system-v2-implementation.md`. Implement **Phase 2B: Read Path** — rewrite `buildTaskContext()` in `context.ts` to read from `DispatchStoreProvider`, update MCP tools in `mcp.ts` to use the new dispatch store (including propagating `parentDispatchId` for child dispatches), and create a new `session-view.ts` with `renderSessionView()` that reconstructs a full session log from dispatch events. Write tests in `session-view.test.ts`. Do NOT modify `dispatch.ts` or `draft.ts` — a parallel agent is handling those in a separate worktree. Do NOT remove `events.ts` — Phase 3. Run `npm run typecheck` and `npm test`. When everything passes, commit your changes and push to origin.

### Phase 3 — Migration + Cleanup + Phase 2 Fixes

Open Claude Code in `../collabot/harness/`

> You are on branch `release/event-system-v2` with Phases 1, 2A, and 2B merged. Read the spec at `docs/specs/event-system-v2.md` and the implementation plan at `docs/specs/event-system-v2-implementation.md`. Implement **Phase 3: Migration + Cleanup + Phase 2 Fixes**. This phase has two parts:
>
> **Part A — Original cleanup:** Remove `events.ts` and `events.test.ts`. Move `extractToolTarget()` from `journal.ts` to a shared util. Remove `watchJournals()` and `getJournalStatus()` from `journal.ts`. Update `TaskManifest` in `task.ts` to use `DispatchIndexEntry[]`. Fix any remaining broken imports.
>
> **Part B — Phase 2 review fixes:**
> 1. **(HIGH) Wire `parentDispatchId` end-to-end.** Add `parentDispatchId?: string` to `DispatchOptions` in `types.ts`. Pass it through `draftFn` in `index.ts` and `cli.ts`, through `draftAgent()` in `core.ts`, into `dispatch()` in `dispatch.ts`, and set it on the `DispatchEnvelope` in the `createDispatch()` call. The MCP layer in `mcp.ts` already passes it — the gap is downstream.
> 2. **(HIGH) Remove dual-write.** Remove the old `recordDispatch()` call from `core.ts` `handleTask()` and from `mcp.ts` `await_agent`. The new dispatch store already handles persistence.
> 3. **(MEDIUM) Fix field name mismatches in `session-view.ts`.** For `session:status` events, read `data.status` not `data.message`. For `system:hook_*` events, read `data.hookName` not `data.hook`.
> 4. **(LOW) Normalize text truncation.** `draft.ts` truncates `agent:text`/`agent:thinking` to 2000 chars but `dispatch.ts` captures full text. Make both truncate to 2000.
> 5. **(LOW) Fix non-retryable error event type in `draft.ts`.** It emits `harness:loop_kill` for non-retryable errors — should be `harness:error`.
>
> Run `npm run typecheck` and `npm test` to verify clean build. When everything passes, commit and push to origin.
