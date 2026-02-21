# Milestone D Handoff — Communication Layer & Core Decoupling

**Date:** 2026-02-19
**Branch:** `workflow-v2`
**Commit:** `2c5b733`
**Tests:** 50 passing (was 36), tsc clean
**E2E:** CLI dispatch verified, Slack regression passed, headless startup confirmed

---

## What Was Built

Milestone D is architecturally the most significant milestone. It decoupled the harness core from Slack, establishing the principle that **the harness is the core orchestration engine and interfaces are adapters**. Before Milestone D, Slack was wired directly into dispatch logic. After Milestone D, the harness runs with or without Slack, and any interface connects via the `CommAdapter` abstraction.

### Step 0: Communication Layer Types

- New `src/comms.ts` with three abstractions:
  - `InboundMessage` — a message from any interface (Slack, CLI, programmatic)
  - `ChannelMessage` — a message flowing through the communication layer
  - `CommAdapter` — the interface contract: `send(msg)` + `setStatus(channelId, status)`
- Types are lean — only what's exercised now. `Channel` and `Participant` models deferred until bot communication is real.

### Step 1: Core Extraction (the big refactor)

- New `src/core.ts` — adapter-agnostic dispatch orchestration:
  - `handleTask()` — adapter-facing entry point (resolves role, creates task, dispatches)
  - `draftAgent()` — the stable pool primitive (future PM bots call this directly)
- New `src/adapters/slack.ts` — implements `CommAdapter` for Slack
  - `send()` → `chat.postMessage()` with persona formatting
  - `setStatus()` → emoji reaction management
  - Only file that touches Slack APIs
- New `src/debounce.ts` — generic debouncer extracted from Slack-specific code
- Refactored `src/slack.ts` to thin Slack entrypoint:
  - Initializes Bolt app, registers message listener
  - Translates Slack events → `InboundMessage`
  - Calls `handleTask()` from core.ts

### Step 2: CLI Adapter

- New `src/adapters/cli.ts` — implements `CommAdapter` for terminal:
  - `send()` → formatted stdout via logger
  - `setStatus()` → prints status changes
- New `src/cli.ts` — CLI entrypoint:
  - `--role <role>` (required), `--cwd <path>` (optional), prompt as positional arg
  - Generates threadId, constructs InboundMessage, calls handleTask
  - Exits with code 0 (success) or 1 (failed)
- npm script: `npm run cli`

### Step 3: Agent Pool

- New `src/pool.ts` — `AgentPool` class:
  - `register()` / `release()` / `kill()` / `list()` / `size`
  - `maxConcurrent` capacity limit (0 = unlimited)
  - `kill()` calls `controller.abort()` on the agent's AbortController
- Wired into `draftAgent()`: register before dispatch, release in `finally` block

### Step 4: Config Updates

- `slack` section made optional in config.yaml
- New `pool` section: `maxConcurrent: 3`
- Harness starts without Slack tokens — no crash, CLI works independently

### Step 5: Wiring

- `index.ts` refactored:
  - Conditional Slack startup (if tokens present)
  - Pool initialization from config
  - Both adapters share the same core functions

---

## Architectural Significance

This milestone established the foundational principle: **the harness IS the product; interfaces are adapters.** Key decisions made during the planning session:

1. The harness is the product, interfaces are adapters
2. Communication layer, not notification bridge (supports any-to-any messaging)
3. Build for parallel, sequential is organic
4. Two-layer entry: `handleTask` (adapter-facing) and `draftAgent` (pool primitive)
5. Debounce and routing are adapter concerns, not core
6. Three interface modes: Chat (Slack), CLI (one-shot), Programmatic (future)

---

## Known Gaps at Milestone D

| Gap | Closed In |
|-----|-----------|
| `pool.kill()` doesn't propagate abort to dispatch | Milestone E |
| No PM bot | Future milestone |
| No bot chatrooms | Future milestone |
| No agent-as-tool-user (MCP) | Milestone F |
| CLI adapter is minimal (one-shot) | Future TUI milestone |
| No private chat / TUI | Future milestone |

---

## Test Coverage

14 new tests added (50 total, up from 36):
- CommAdapter contract tests
- Core handleTask/draftAgent unit tests
- CLI adapter tests
- AgentPool tests (register, release, kill, capacity)
- Config optional slack validation

> **Note:** This handoff doc was written retroactively on 2026-02-20 to fill a documentation gap. The milestone was complete and verified on 2026-02-19 but no handoff was archived at the time.
