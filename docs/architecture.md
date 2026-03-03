# Agent Orchestration Architecture

> Living document. Last updated 2026-03-03.

## Overview

Collabot is a persistent Node.js/TypeScript service that dispatches, coordinates, and manages AI bots across projects. The **harness** is the core — always running, interface-independent. Humans interact through adapters. Bots are dispatched to work on tasks in project repositories.

```
                    +------------------------+
       Slack ------>|                        |
        CLI ------->|        Harness         |--------> Bots
  WebSocket ------->|                        |            |
        TUI ------->|  dispatch . events     |      +-----------+
                    |  tasks . MCP tools     |      |  Project  |
                    +------------------------+      |   repos   |
                                                    +-----------+
```

## Core Principles

1. **Bots are teammates, not tools.** They have names, personalities, roles, and (eventually) memories. The harness is home base.
2. **Curated context over large context.** The right 10K tokens beats 100K of vibes. Context is assembled precisely — role prompt, task history, project skills — not dumped wholesale.
3. **Tools over tokens.** Deterministic operations are scripts/tools/MCP, not agent reasoning. If the operation has a deterministic correct answer, it's a tool.
4. **Documentation is memory.** Bots have no memory between sessions. What's written down is what they know. Docs evolve in the same commit as code.
5. **Everything pluggable.** `CommunicationProvider`, `DispatchStoreProvider`, future `ToolProvider`, `HookProvider`. The platform provides infrastructure; users provide content.

## The Harness

The harness (`harness/src/`) is the orchestration engine:

| Module | Purpose |
|--------|---------|
| `index.ts` | Main entry — startup sequence, adapter wiring, inbound handler |
| `core.ts` | `handleTask()`, `draftAgent()` — adapter-agnostic dispatch |
| `draft.ts` | Draft session module — SDK dispatch with event capture |
| `dispatch.ts` | Autonomous dispatch — long-running agents with full lifecycle |
| `bot-session.ts` | `BotSessionManager` — multi-session, resume-per-message |
| `bot-queue.ts` | `BotMessageQueue` — per-bot FIFO with busy isolation |
| `bot-placement.ts` | `placeBots()` — config → project + role + meta resolution |
| `bots.ts` | Bot definition schema + loader |
| `comms.ts` | `CommunicationProvider` interface, `VirtualProjectRequest`, `filteredSend()` |
| `registry.ts` | `CommunicationRegistry` — register, broadcast, lifecycle |
| `dispatch-store.ts` | `DispatchStoreProvider` + `JsonFileDispatchStore` + `makeCapturedEvent()` |
| `context.ts` | `buildTaskContext()` — reads from dispatch store for context reconstruction |
| `mcp.ts` | MCP tools — draft, await, kill, context, tasks, projects |
| `task.ts` | Task CRUD, slug generation, lifecycle (`open` → `closed`) |
| `project.ts` | Project manifest loading, virtual project support |
| `config.ts` | TOML config schema — models, agent defaults, bots, adapters |
| `prompts.ts` | `assembleBotPrompt()` — role + skills + soul prompt assembly |
| `cron.ts` | `CronScheduler` — setInterval-based, multi-project task rotation |
| `entity-tools.ts` | Entity listing/reading tools (roles, bots, skills) |

## Adapters

Adapters implement `CommunicationProvider` and connect to the harness via `CommunicationRegistry`. No adapter is primary. The harness runs headless without any of them.

| Adapter | Transport | Entry point |
|---------|-----------|-------------|
| **Slack** | Socket Mode (one Bolt App per bot) | `adapters/slack.ts` |
| **CLI** | One-shot terminal dispatch | `adapters/cli.ts` via `cli.ts` |
| **WebSocket** | JSON-RPC 2.0 over WS | `adapters/ws.ts` |
| **TUI** | .NET 10 Terminal.Gui (connects via WS) | Separate repo: `collabot-tui` |

Adapters can implement optional SPI methods like `getVirtualProjects()` for provider interrogation at startup.

## Bots, Roles, and Skills

The entity hierarchy: **Bot** (WHO) → **Role** (WHAT) → **Skills** (HOW).

**Bots** are persistent identities defined in markdown files with YAML frontmatter. Each bot has a name, personality (soul prompt), a default project, and a role assignment. Bot definitions are instance content — not shipped with the platform.

**Roles** are behavioral profiles — identity, model hint, and permissions. They're tech-stack-focused, not project-specific. A `.NET developer` role works on any .NET project.

**Skills** are injected capabilities. `assembleBotPrompt()` layers them between the role prompt and soul prompt. Day-1 example: `SLACK_ETIQUETTE` teaches bots Slack formatting conventions.

## Dispatch

Two dispatch paths:

**Bot sessions** (`BotSessionManager`) — For adapter-initiated conversations. Resume-per-message: each inbound message resumes the bot's SDK session with full conversation history. Sessions persist to disk. `BotMessageQueue` provides per-bot FIFO with busy isolation.

**Draft/autonomous dispatch** (`draftAgent()` / `dispatch()`) — For programmatic dispatch via MCP tools or CLI. PM bots can dispatch sub-agents, await results, and synthesize. Supports parallel dispatch with git worktree isolation.

Both paths capture events through `DispatchStoreProvider`.

## Event System

Event system v2 provides a canonical event stream scoped to dispatches:

**Task** → **Dispatch** (envelope) → **Event[]** (content)

Events use a `category:action` taxonomy: `agent:*`, `session:*`, `harness:*`, `user:*`, `system:*` (20 event types). Each event gets a ULID and RFC 3339 timestamp via `makeCapturedEvent()`.

Storage: `task.json` (lean index) + `dispatches/{dispatchId}.json` (envelope + events). Day-1 provider is `JsonFileDispatchStore`. SQLite is a future option.

## Tasks and Projects

**Tasks** are the unit of persistence, scoped to projects. Lifecycle: `open` → `closed`. A task spans multiple dispatches, roles, and bots. Created via CLI, WebSocket, or MCP tools.

**Projects** are logical products that may span multiple repos. Registered in `.projects/<name>/project.yaml` (instance-local). Virtual projects can be injected by adapters at startup (e.g., Slack creates a `slack-room` project for conversational interactions).

## MCP Tool Surface

The harness exposes MCP tools that bots can call during dispatch:

| Tool | Purpose |
|------|---------|
| `draft_agent` | Dispatch a sub-agent with role and project |
| `await_agent` | Wait for a dispatched agent to complete |
| `kill_agent` | Abort a running agent |
| `get_task_context` | Reconstruct context from dispatch history |
| `list_tasks` | Query tasks for the current project |
| `list_projects` | List available projects |

All tools are scoped to the parent project — bots only see their own project's data.

## Startup Sequence

Per D18 design decision, the harness starts in a defined order:

1. **Construct** — load config, initialize stores
2. **Register** — create adapters, register with `CommunicationRegistry`
3. **Interrogate** — call `getVirtualProjects()` on all providers, ensure projects
4. **Place** — run `placeBots()` to resolve config → project + role + meta
5. **Wire** — set up inbound handler with placement-aware routing
6. **Banner** — print startup summary
7. **Start** — start all adapters (Socket Mode connections, WS server, etc.)
8. **Presence** — set bot presence on adapters that support it
9. **Cron** — start scheduled task rotation
