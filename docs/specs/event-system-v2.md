# Event System v2 — Canonical Event Capture & Dispatch Scoping

| Field | Value |
|-------|-------|
| **Source** | Spec discussion 2026-02-28 |
| **Status** | **Signed off** |
| **Created** | 2026-02-28 |
| **Last Updated** | 2026-03-01 |

## Summary

Redesign the Collabot event capture system from a flat, write-only log into a canonical event stream scoped to dispatches. The new model captures everything the Agent SDK emits, maps it to Collabot's own type system, and supports read-time filtering for multiple consumers: TUI session reconstruction, PM agent check-ins, context reconstruction, and future memory synthesis.

This replaces the current dual-persistence model (`events.json` flat log + `task.json` dispatch records) with a unified Dispatch → Event[] hierarchy.

## Motivation

The current system has known deficiencies rated 7-8/10 severity in the Role System v2 post-mortem:
- Event log is flat — no dispatch scoping, no way to tell which dispatch produced which events
- No parent-child relationships (PM dispatches workers — events are indistinguishable)
- Context reconstruction reads `task.json`, not `events.json` — the event system is effectively write-only
- `EventLog` type has a single `role` field, but multiple roles dispatch within a task
- `tool_result` event type is defined but never emitted
- Multiple SDK event types are silently dropped

The research-lab project (first production use case) requires Slack-initiated tasks with observable agent activity — the current system can't support this.

## Research

### OpenCode (github.com/anomalyco/opencode)

Researched as prior art for event capture and session management:
- **Message/Parts separation** — Messages are envelopes; parts are content with individual IDs and lifecycle. Validates our Dispatch → Event[] model.
- **Tool state machine** — Tools tracked through `pending → running → completed | error` with timing at each transition. Adopted for our `agent:tool_call` / `agent:tool_result` pair.
- **Streaming vs persistence split** — Streaming deltas are ephemeral (bus only, never persisted). Completed content is persisted. Validates our approach: stream to comm adapter, capture final text as event.
- **SQLite over flat files** — They moved from JSON to SQLite. Noted but not a day-1 requirement for us.
- **In-memory bus for real-time, DB for persistence** — Two-tier: ephemeral events for live UI, durable state for history. Clean separation of streaming from journaling.

### OpenClaw (github.com/openclaw/openclaw)

Researched as prior art for plugin/provider architecture:
- **Plugin** is the top-level packaging unit — directory with a manifest (`openclaw.plugin.json`) and a `register()` function.
- Within a plugin, contributions are typed: Tool, Hook, Channel, Provider, Service, Command.
- Common manifest fields across all plugins: `id`, `configSchema`, `name`, `description`, `version`.
- Registration is API-based: plugin receives an API object, calls typed registration methods.
- Medium-high complexity — more than we need, but the plugin→provider layering is a useful reference.

### SDK Event Coverage

The Agent SDK (`@anthropic-ai/claude-agent-sdk`) emits 17+ message types. The current harness handles 5. Events we're not capturing today:

| SDK Message | Content | Priority |
|---|---|---|
| `stream_event` | Token-by-token streaming deltas | Transport concern (D8) |
| `system/status` | Status updates | Observability |
| `system/hook_*` | Hook lifecycle events | When hooks are built |
| `system/files_persisted` | Files agent saved | Tracking changes |
| `system/task_*` | Background task lifecycle | If agents use background tasks |
| `tool_progress` | Tool execution elapsed time | Observability |
| `tool_use_summary` | Summary of tool calls | Potentially redundant |
| `rate_limit` | Rate limit events | Operational awareness |

## Design Decisions

### D1: Dispatch → Event[] hierarchy

Events are scoped to dispatches. A dispatch is the unit of agent execution — the harness sending an agent to do work. The hierarchy is:

```
Task
  └── Dispatch (envelope — who, when, cost, model, parent)
        └── Event[] (content — what happened during execution)
```

This replaces both the flat `events.json` and the `DispatchRecord[]` in `task.json`.

**Bot identity note:** The "spiritual" unit of work is the bot, not the dispatch. A bot (e.g., "Lucy as ts-dev") may be dispatched multiple times to the same task. The dispatch envelope carries a future `botId` field to support cross-dispatch recomposition of a bot's full experience on a task. Storage is dispatch-scoped; the bot experience is a read-time view.

### D2: Event taxonomy with category:action namespacing

Events use `category:action` naming for natural filtering (e.g., "all `agent:*` events" for session reconstruction, "all `harness:*` events" for debugging).

**Agent activity** (things the agent does):
| Event | SDK Source | Description |
|---|---|---|
| `agent:text` | `assistant` text block | Agent wrote text |
| `agent:thinking` | `assistant` thinking block | Extended thinking |
| `agent:tool_call` | `assistant` tool_use block | Tool invocation (carries metadata) |
| `agent:tool_result` | `user` tool_result block | Tool returned (carries status, duration) |

**Session lifecycle** (dispatch boundaries and SDK lifecycle):
| Event | SDK Source | Description |
|---|---|---|
| `session:init` | `system/init` | SDK session initialized (model, session ID) |
| `session:complete` | `result` | Dispatch finished (status, cost, usage, structured result) |
| `session:compaction` | `system/compact_boundary` | Context window compacted |
| `session:rate_limit` | `rate_limit` | Rate limit hit |
| `session:status` | `system/status` | Status change |

**Harness interventions** (harness acting on the agent):
| Event | Source | Description |
|---|---|---|
| `harness:loop_warning` | Loop detector | Pattern detected, warning issued |
| `harness:loop_kill` | Loop detector | Agent killed for looping |
| `harness:stall` | Stall timer | Inactivity timeout |
| `harness:abort` | External abort | Agent aborted (user, PM, pool kill) |
| `harness:error` | Exception | Unexpected error |

**Interaction** (mid-dispatch messages from users or other agents):
| Event | Source | Description |
|---|---|---|
| `user:message` | User or agent input | Someone sent this agent a message mid-dispatch |

**System observations** (future-facing, captured when SDK emits them):
| Event | SDK Source | Description |
|---|---|---|
| `system:files_persisted` | `system/files_persisted` | Agent saved files to disk |
| `system:hook_started` | `system/hook_started` | Hook began execution |
| `system:hook_progress` | `system/hook_progress` | Hook output |
| `system:hook_response` | `system/hook_response` | Hook completed |

### D3: Dispatch envelope with cached structured result

The dispatch envelope carries metadata for quick access without scanning events. The `session:complete` event is the source of truth for the structured result; the envelope caches it.

```
Dispatch envelope:
  dispatchId       — ULID
  taskSlug         — parent task
  role             — role name
  model            — resolved model ID
  cwd              — working directory
  startedAt        — RFC 3339
  completedAt      — RFC 3339
  status           — completed | aborted | crashed
  cost             — USD
  usage            — tokens, turns, duration
  structuredResult — cached from session:complete event
  parentDispatchId — null for top-level, set for PM → worker
  botId            — null (future — bot identity)
```

### D4: Parent-child dispatch relationships

When a PM agent dispatches workers via MCP tools, the tree is represented by `parentDispatchId`:

```
Dispatch A (product-analyst)        ← parentDispatchId: null
  ├── Dispatch B (ts-dev)           ← parentDispatchId: A
  └── Dispatch C (dotnet-dev)       ← parentDispatchId: A
```

### D5: ULID identifiers

Dispatch IDs and event IDs use ULIDs (consistent with existing entity IDs throughout Collabot). ULIDs provide natural time-ordering without prefixing.

### D6: Tool state machine

Tool calls are tracked as a pair of events linked by `toolCallId`:

```
agent:tool_call  → { toolCallId, tool, target, metadata: {} }
agent:tool_result → { toolCallId, tool, target, status: "completed"|"error", durationMs, metadata: {} }
```

This enables session reconstruction showing what was called, what came back, and how long it took.

### D7: Capture narrative, not artifacts

The journal captures the agent's activity, decisions, and outcomes — not the artifacts themselves. Files exist on disk; command output is ephemeral. The event stream records the "what happened" and "what the agent thought about it."

**Always capture (every tool):**
- Tool name, target, status, duration, error message (if error)

**Capture when meaningful (tool-specific metadata in generic bag):**
- Edit/Write: file path, size before/after
- Bash: command string, exit code
- Read/Glob/Grep: search terms, results found
- WebFetch/WebSearch: URL, query

**Never capture:**
- Full file contents (on disk)
- Full command output (ephemeral)
- Full web page content

Tool-specific data is carried in `metadata: Record<string, unknown>` — a generic bag. The event system is tool-agnostic; consumers that care about specific tools inspect metadata keys.

### D8: Streaming is a transport concern, not a persistence concern

The Agent SDK emits `stream_event` messages with token-by-token deltas. These are forwarded to comm adapters in real-time via `onEvent` callbacks but are NOT persisted to the event log. The completed `agent:text` event captures the final content. This matches OpenCode's architecture: ephemeral bus for streaming, durable store for completed content.

### D9: Bot identity is a future field

The dispatch envelope includes a `botId` field (null for now). When bot abstraction arrives, this links dispatches to persistent bot identities. Cross-dispatch recomposition ("everything Lucy did on this task") is a read-time query filtering by `botId`. No structural changes needed at that point.

### D10: Unified persistence — task manifest indexes dispatches

The dual-persistence model (`task.json` dispatch records + `events.json` flat log) is replaced by:

```
.projects/{project}/tasks/{slug}/
  task.json                      ← task metadata + lightweight dispatch index
  dispatches/
    {dispatchId}.json            ← dispatch envelope + events array
```

**task.json** carries task-level metadata (slug, name, project, status, created) plus a lightweight dispatch index — enough for quick listing without reading every dispatch file:

```json
{
  "slug": "research-llm-routing",
  "name": "Research LLM routing strategies",
  "project": "research-lab",
  "status": "open",
  "created": "2026-03-01T...",
  "dispatches": [
    { "dispatchId": "01JM...", "role": "product-analyst", "status": "completed", "cost": 0.15, "startedAt": "...", "parentDispatchId": null }
  ]
}
```

**Dispatch files** are self-contained — envelope at the top, events array below. One file per dispatch. Parallel dispatches write to separate files (no contention). Each dispatch file is independently readable and grep-able.

The dispatch index in `task.json` is a derived cache — the dispatch file is the source of truth.

### D11: No draft/autonomous distinction in the data model

There is one dispatch model. No `type: "draft" | "autonomous"` field on the envelope. A dispatch that has `user:message` events in its stream had user interaction. One that didn't, didn't. The data speaks for itself.

Mechanical differences in the harness code (SDK session resume, streaming callbacks, structured output requirements) remain as implementation details, not data model concerns. From the data perspective, an agent gets dispatched, does work, produces events, finishes.

### D12: Read-time views via utility functions

Events are captured at full fidelity. Consumers apply their own filtering at read time via utility functions:

- `getDispatchEvents(taskDir, dispatchId)` — full event stream for a dispatch
- `getRecentEvents(taskDir, dispatchId, count)` — last N events
- `getDispatchEnvelopes(taskDir)` — read task.json dispatch index
- `getDispatchEnvelope(taskDir, dispatchId)` — single dispatch envelope
- `renderSessionView(taskDir, dispatchId)` — TUI session reconstruction (replaces `renderJournalView()`)

No query language, no indexing. Functions read JSON files and filter. When/if storage moves to SQLite, these function signatures stay the same — the implementation changes.

**Consumers and their access patterns:**
| Consumer | What it reads | Access pattern |
|---|---|---|
| TUI session reconstruction | Full dispatch event stream | `getDispatchEvents` → render chronologically |
| PM agent check-in | Recent events from a worker | `getRecentEvents` with count/truncation |
| Context reconstruction | Dispatch envelopes (structured results) | `getDispatchEnvelopes` → filter by status |
| Future memory synthesis | Unknown — full fidelity available | Whatever it needs |

### D13: DispatchStoreProvider interface (adapter pattern)

The dispatch store is a provider — the first non-communication provider type in Collabot. The harness defines the interface; implementations are pluggable.

```typescript
interface DispatchStoreProvider {
  // Dispatch lifecycle
  createDispatch(taskDir: string, envelope: DispatchEnvelope): void;
  updateDispatch(taskDir: string, dispatchId: string, updates: Partial<DispatchEnvelope>): void;

  // Event capture
  appendEvent(taskDir: string, dispatchId: string, event: CapturedEvent): void;

  // Envelope reads (quick — task manifest index)
  getDispatchEnvelopes(taskDir: string): DispatchEnvelope[];
  getDispatchEnvelope(taskDir: string, dispatchId: string): DispatchEnvelope | null;

  // Event reads (full stream)
  getDispatchEvents(taskDir: string, dispatchId: string): CapturedEvent[];
  getRecentEvents(taskDir: string, dispatchId: string, count: number): CapturedEvent[];
}
```

Day-1 implementation: `JsonFileDispatchStore` — reads/writes JSON files in the `dispatches/` directory, maintains the task manifest dispatch index.

### D14: Plugin/provider architecture pattern

Collabot adopts a two-layer extensibility model informed by OpenClaw's architecture:

- **Plugin** = the packaging/discovery/loading unit. Has a manifest with common fields (id, name, version, description, provider type). Lives in a known directory.
- **Provider** = a typed capability implementation contributed by a plugin. Each provider type defines its own interface.

Provider types use verbose naming: `CommunicationProvider`, `DispatchStoreProvider`, `ToolProvider`, `HookProvider`.

Provider interfaces are independent — no shared base interface between provider types. The common manifest envelope is shared across all plugin types for consistent discovery and loading.

The full plugin/provider pattern (manifest schema, registration API, discovery mechanism) will be formalized in the Communication Provider spec (next initiative). This spec establishes the first concrete provider type (`DispatchStoreProvider`) and conforms to the pattern once defined.

## Design Constraints

- File-based storage for now (SQLite is future option, not day-1)
- Dispatch envelopes must be easy to read by tools (quick access to metadata)
- Event files must be grep-able by agents
- Must support "switching agents" in TUI — reconstructing complete session logs
- Must support cross-dispatch recomposition for future bot memory
- MVP scope — make it work for current state, don't over-engineer for unknown consumers
- Verbose type naming convention (e.g., `CommunicationProvider` not `CommProvider`)

## Needs Investigation

- Plugin manifest schema — common fields, type-specific extensions (deferred to comm provider spec)
- Plugin discovery and registration mechanism (deferred to comm provider spec)

## Out of Scope

- SQLite migration (future storage backend — provider interface supports it, not implementing now)
- Bot abstraction (field reserved on dispatch envelope, identity system is separate initiative)
- Memory synthesis (future consumer of the event stream, not designed here)
- Streaming/real-time delta transport (comm adapter concern, noted in D8)
- SMART links / entity linking infrastructure
- Full plugin/provider architecture specification (deferred to comm provider spec)

---

## Sign-off

- [x] Design discussion completed — 2026-03-01
