# Milestone D — Communication Layer & Pool Mechanics

> **Parent spec:** `docs/specs/workflow-harness.md`
> **Predecessor:** Milestone C (complete — config, routing, tasks, monitoring, debounce)
> **Goal:** Decouple Slack from the harness core, introduce the communication layer abstraction, enable parallel dispatch, and let the human act as PM.
> **Status:** **Complete** — 2026-02-19

This is the first Phase 2 milestone. Phase 1 proved the loop (A), the workflow (B), and multi-project hardening (C). Phase 2 shifts focus from "make it work via Slack" to "build the harness as a product with Slack as one adapter."

Each step is independently verifiable. Don't move to the next step until the current one works.

---

## Design Decisions (from planning meeting 2026-02-19)

These decisions were made during the Milestone D spec-discuss session. Coding agents should treat them as constraints, not suggestions.

1. **The harness is the product, interfaces are adapters.** Slack, CLI, future UI, future private chat — all plug into the same harness core. No interface is primary. New features must work without Slack running.

2. **Communication layer, not notification bridge.** The abstraction supports any-to-any messaging: bots, harness, human, system. Bot-to-bot communication (chatrooms, knowledge sharing) plugs in later without replumbing. Types are lean — only define what's exercised now. `Channel` and `Participant` models are deferred until bot communication is real.

3. **Build for parallel, sequential is organic.** The harness supports N concurrent agents. Sequential ordering is the coordinating agent's decision (PM bot or human), not a harness constraint. The core primitive is `draftAgent(role, taskContext, ...) → Promise<DispatchResult>`.

4. **Two-layer entry: `handleTask` and `draftAgent`.** `handleTask` is adapter-facing — takes a raw inbound message, resolves role, creates/finds task, calls `draftAgent`. `draftAgent` is the stable pool primitive — takes an explicit role + task context, dispatches, tracks in pool. Future PM bots call `draftAgent` directly. Role resolution is the adapter's responsibility (routing rules for Slack, `--role` flag for CLI, explicit parameter for programmatic callers).

5. **Debounce and routing are adapter concerns, not core.** Debounce solves a chat-UX problem (rapid-fire messages). Routing solves an ambiguity problem (unstructured text → role). Neither applies to programmatic callers. Both stay available as utilities but are owned by adapters, not core. When agents can make harness tool calls (MCP), they specify the role explicitly — no routing needed.

6. **Human plants the seed.** For non-automated tasks, the human kicks things off — drafts bots, gives direction. The "how do I kick it off" UX stays rough. Polish comes later.

7. **Task sizing calibration.** Milestone C (7 steps, one context compaction near end) is the right ceiling for a single coding dispatch. This milestone targets 6 steps.

8. **Three interface modes, one abstraction.** Chat (conversational: Slack, future private chat), CLI (one-shot: scripting/automation), Programmatic (module import: future UI backend, PM bot, cron). All implement the same `CommAdapter` interface. Private chat — a conversational interface wired to the harness replacing Claude Code CLI for daily work — is a future milestone but the abstraction accommodates it.

## Known Gaps (not bugs — document in handoff)

| Gap | Why | Closes When |
|-----|-----|-------------|
| No PM bot | Human plays PM for now | PM bot milestone |
| No bot chatrooms | Abstraction accommodates them, not built yet | Bot communication milestone |
| No cron/triggers | Human-initiated only | Automation milestone |
| No agent-as-tool-user | Bots can't call harness APIs (spawn, kill) | MCP tools milestone |
| CLI adapter is minimal | One-shot, proves the abstraction | CLI UX / private chat milestone |
| No private chat | User's desired daily interface — conversational, wired to harness | Private chat milestone |
| Channel/Participant types deferred | Not exercised until bot communication | Bot communication milestone |

---

## Step 0: Communication Layer Types

**Who:** Agent

**Do:**

1. Create `harness/src/comms.ts` with the communication abstractions that are exercised in this milestone:

```typescript
/** An inbound message from any interface */
interface InboundMessage {
  id: string;
  content: string;
  threadId: string;        // conversation grouping key
  source: string;          // 'slack', 'cli', 'http', etc.
  role?: string;           // pre-resolved role (CLI --role flag, programmatic caller). If absent, adapter/handleTask resolves via routing.
  metadata?: Record<string, unknown>;
}

/** A message flowing through the communication layer */
interface ChannelMessage {
  id: string;
  channelId: string;
  from: string;            // participant identifier (role name, 'harness', 'human')
  timestamp: Date;
  type: 'lifecycle' | 'chat' | 'question' | 'result' | 'warning' | 'error';
  content: string;
  metadata?: Record<string, unknown>;  // adapter-specific data lives here
}

/** The adapter interface — each interface (Slack, CLI, etc.) implements this */
interface CommAdapter {
  readonly name: string;

  /** Send a message to a channel */
  send(msg: ChannelMessage): Promise<void>;

  /** Update channel status (e.g., reactions in Slack, spinner in CLI) */
  setStatus(channelId: string, status: 'received' | 'working' | 'completed' | 'failed'): Promise<void>;
}

// NOTE: Channel and Participant types are intentionally deferred.
// They will be defined when bot-to-bot communication (chatrooms, knowledge sharing) is built.
// The current CommAdapter interface is designed to accommodate them without breaking changes.
```

2. Export all types from `types.ts` as well for convenience.

**Verify:** `npx tsc --noEmit` passes with new types.

---

## Step 1: Extract Core + Slack Adapter

**Who:** Agent

**Do:** This is one atomic refactor. Read `slack.ts` fully, then create the new files and rewire in one pass.

### 1a. Create `harness/src/core.ts` — the interface-agnostic dispatch orchestrator.

Define two functions:

**`handleTask`** — the adapter-facing entry point:
```typescript
async function handleTask(
  message: InboundMessage,
  adapter: CommAdapter,
  roles: Map<string, RoleDefinition>,
  config: Config,
): Promise<DispatchResult>
```

Responsibilities:
- If `message.role` is set, use it directly. Otherwise, resolve role via routing rules (import from `router.ts`).
- Get or create task (import from `task.ts`).
- Call `adapter.setStatus(channelId, 'working')`.
- Call `draftAgent()` with resolved role + task context.
- Call `adapter.setStatus(channelId, 'completed' | 'failed')` based on result.
- Record dispatch in task.json.
- Return result.

**`draftAgent`** — the stable pool primitive:
```typescript
async function draftAgent(
  role: string,
  taskContext: string,
  adapter: CommAdapter,
  roles: Map<string, RoleDefinition>,
  config: Config,
  options?: { taskSlug?: string; channelId?: string; cwd?: string },
): Promise<DispatchResult>
```

Responsibilities:
- Resolve cwd (from options, role frontmatter, or error).
- Create journal file.
- Call `dispatch()` (from dispatch.ts) with appropriate options.
- Wire `onLoopWarning` to `adapter.send()`.
- Return structured result.

### 1b. Create `harness/src/adapters/slack.ts` — implements `CommAdapter` for Slack.

- `send(msg)` → calls `client.chat.postMessage()` with persona formatting (username, icon from role).
- `setStatus(channelId, status)` → manages emoji reactions using `config.slack.reactions`. Uses `safeReaction` pattern for silent failure.
- Holds `WebClient` reference and reaction config. Nothing outside this file touches Slack APIs.

### 1c. Extract debounce into `harness/src/debounce.ts` — generic utility.

- `Debouncer<T>` class keyed on a generic string.
- `debounce(key, item, delayMs, onFlush)` — accumulates items, calls `onFlush` after delay.
- Slack entrypoint instantiates with Slack-specific metadata.

### 1d. Refactor `slack.ts` to thin Slack entrypoint.

- Initializes Bolt app.
- Registers `app.message()` listener.
- Translates Slack events → `InboundMessage` (extracts text, user, thread_ts as threadId, channel in metadata).
- Instantiates the Slack `CommAdapter`.
- Uses `Debouncer` for message grouping.
- Calls `handleTask()` from core.ts.

**Verify:** All existing tests pass. `npx tsc --noEmit` clean. Harness still works via Slack with identical behavior.

---

## Step 2: CLI Adapter (Proof of Abstraction)

**Who:** Agent

**Do:**

1. Create `harness/src/adapters/cli.ts` — implements `CommAdapter` for terminal usage.

2. Minimal implementation:
   - `send(msg)` → prints formatted message to stdout (via logger)
   - `setStatus(channelId, status)` → prints status change (e.g., `[working] task-slug`, `[completed] task-slug`)

3. Create `harness/src/cli.ts` — a CLI entrypoint:
   - Accepts args: `--role <role>` (required), `--cwd <path>` (optional, falls back to role default), prompt as positional arg or from stdin
   - Generates a threadId (e.g., `cli-<timestamp>`)
   - Constructs `InboundMessage` with `role` pre-set (no routing needed)
   - Loads config and roles
   - Calls `handleTask()` with the CLI adapter
   - Prints the `DispatchResult` as formatted JSON
   - Exits with code 0 (success/partial) or 1 (failed)

4. Add npm script: `"cli": "tsx src/cli.ts"`

**Verify:** `npm run cli -- --role api-dev "Describe the project structure"` dispatches an agent and prints the result to terminal. No Slack tokens required. Same harness core, different adapter.

---

## Step 3: Agent Pool

**Who:** Agent

**Do:**

1. Create `harness/src/pool.ts` — the concurrent agent tracker.

```typescript
interface ActiveAgent {
  id: string;
  role: string;
  taskSlug?: string;
  startedAt: Date;
  controller: AbortController;
}

class AgentPool {
  private active: Map<string, ActiveAgent>;
  private maxConcurrent: number;  // 0 = unlimited

  /** Register an agent as active. Rejects if at capacity. */
  register(agent: ActiveAgent): void;

  /** Remove an agent from the pool (completed or failed). */
  release(agentId: string): void;

  /** Abort a running agent. */
  kill(agentId: string): void;

  /** List all active agents. */
  list(): ActiveAgent[];

  /** Current count of active agents. */
  get size(): number;
}
```

2. Wire `draftAgent()` in core.ts to use the pool:
   - Register before dispatch starts.
   - Release after dispatch completes (success or failure).
   - Pass the pool's `AbortController` to dispatch.

3. Update `task.ts:recordDispatch()` — verify it handles concurrent writes (multiple dispatches recording to the same task.json). If there's a race condition, add a simple file-level guard.

4. Add pool unit tests (mock dispatch, no real SDK calls):
   - Register two agents, verify both tracked, both in `list()`
   - Release one, verify only one remains
   - Kill one, verify `controller.abort()` called
   - Register at capacity → rejection
   - Register with `maxConcurrent: 0` (unlimited) → always succeeds

**Verify:** Tests pass. Pool tracks concurrent agents correctly.

---

## Step 4: Config Updates

**Who:** Agent

**Do:**

1. Make `slack` section optional in `config.yaml`. The harness should start without Slack config when using CLI only.

2. Add optional `pool` section:
```yaml
pool:
  maxConcurrent: 3        # max simultaneous agents (0 = unlimited)
```

3. Defaults: if `pool` section is absent, default to `maxConcurrent: 0` (unlimited).

4. Keep `slack` section structure unchanged for backward compatibility — just make it optional.

5. Update config validation tests for optional slack, new pool section.

**Verify:** Config loads with and without slack section. Pool defaults work. Existing config files still valid.

---

## Step 5: Wire It Together

**Who:** Agent

**Do:**

1. Update `index.ts` entrypoint:
   - If Slack tokens are present → start Slack app (current behavior)
   - If Slack tokens are missing → log that Slack is disabled, harness runs in headless mode
   - Initialize `AgentPool` from config, pass to core functions
   - CLI entrypoint (`cli.ts`) works independently, initializes its own pool

2. Ensure the journal system, task system, and monitoring all work regardless of which adapter is active.

3. Verify existing Slack flow still works end-to-end (regression).

4. Verify CLI flow works end-to-end (new capability).

**Verify:**
- With Slack tokens: everything works as before
- Without Slack tokens: harness starts headless, CLI dispatch works, no crashes
- `npx tsc --noEmit` clean, all tests pass

---

## E2E Verification (Human)

**Checklist:**

- [ ] Slack DM → bot responds, reactions work, result posted (regression — same behavior, different plumbing)
- [ ] CLI dispatch → agent runs, result printed to terminal (`npm run cli -- --role api-dev "prompt"`)
- [ ] Two concurrent CLI dispatches (two terminal windows) → both complete, both tracked in pool, both in task.json
- [ ] Harness starts without Slack tokens → no crash, logs "Slack disabled"
- [ ] Kill a running agent via pool → clean abort, journal updated

---

## Vision Context (not in scope — captured for architectural awareness)

### Bot Drafting
Drafting will evolve from "human specifies role" to a pseudo-deterministic harness decision based on bot frontmatter/metadata + task requirements + weighting + lottery. The `draftAgent` primitive is designed to be the stable foundation — the drafting *logic* above it changes, the dispatch mechanics below it don't.

### Bot Identity & Specialization
Bots carry persistent identity (personality, taste, desire, motivation). The theory: diversity of context leads to diversity of thought and better outcomes. Some bots are curated specialists (one PM bot, finely crafted). Others are from a large pool (many junior devs with unique traits). All grow and specialize organically through experience. Role selection (what kind of work) is distinct from bot selection (which individual from the pool).

### Private Chat
The user's desired daily interface — a conversational session wired to the harness, replacing Claude Code CLI. Same category as Slack (chat adapter), different rendering. The `CommAdapter` abstraction supports this without replumbing.

### Interface Modes
| Mode | Nature | Examples |
|------|--------|---------|
| Chat (conversational) | Back-and-forth, persistent | Slack, future private chat |
| CLI (mechanical) | One-shot, scripting | `npm run cli`, automation scripts |
| Programmatic (API) | Module import, called by code | Future UI backend, PM bot, cron |
