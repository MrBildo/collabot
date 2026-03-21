# Agent Orchestration Architecture

> Living document. Last updated 2026-03-21.

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
| `dispatch.ts` | Autonomous dispatch — long-running agents with full lifecycle |
| `bot-session.ts` | `BotSessionManager` — unified session system (resume-per-message, event capture, pool registration) |
| `bot-queue.ts` | `BotMessageQueue` — per-bot FIFO with busy isolation |
| `bot-placement.ts` | `placeBots()` + `BotPlacementStore` — config → project + role + runtime state |
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
| `collab-dispatch.ts` | `collabDispatch()` — unified dispatch entry point (entity model, task lifecycle, SDK call, event capture) |
| `cron.ts` | `CronScheduler` v2 — cron expressions, per-job state, singleton enforcement, pause/resume, state persistence |
| `cron-loader.ts` | Job folder parser — reads `job.md` frontmatter + `settings.toml`, produces typed `CronJobDefinition` |
| `cron-bridge.ts` | Execution bridge — builds runnable handlers from job definitions, manages `CronHandlerContext`, run log persistence |
| `cron-mcp.ts` | Cron MCP tools — list, get, create, delete, pause, resume, run log query |
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

**Bot sessions** (`BotSessionManager`) — The unified session system for all interactive work. Resume-per-message: each inbound message resumes the bot's SDK session with full conversation history. Sessions persist to disk, register in the agent pool, broadcast via registry (TUI/WS) or responseSink (Slack), and support context reconstruction from prior dispatches. `BotPlacementStore` tracks runtime state (available/busy/drafted) with operator overrides for bot mobility. `BotMessageQueue` provides per-bot FIFO with busy isolation.

**Autonomous dispatch** (`draftAgent()` / `dispatch()`) — For programmatic dispatch via MCP tools or CLI. PM bots can dispatch sub-agents (including cross-project via the `project` parameter), await results, and synthesize. `parentDispatchId` threads through MCP servers for event nesting. Supports parallel dispatch with git worktree isolation.

Both paths capture events through `DispatchStoreProvider`.

## Event System

Event system v2 provides a canonical event stream scoped to dispatches:

**Task** → **Dispatch** (envelope) → **Event[]** (content)

Events use a `category:action` taxonomy: `agent:*`, `session:*`, `harness:*`, `user:*`, `system:*` (20 event types). Each event gets a ULID and RFC 3339 timestamp via `makeCapturedEvent()`.

Storage: `task.json` (lean index) + `dispatches/{dispatchId}.json` (envelope + events). Day-1 provider is `JsonFileDispatchStore`. SQLite is a future option.

## Tasks and Projects

**Tasks** are the unit of persistence, scoped to projects. Lifecycle: `open` → `closed`. A task spans multiple dispatches, roles, and bots. Created via CLI, WebSocket, or MCP tools.

**Projects** are logical products that may span multiple repos. Registered in `.projects/<name>/project.toml` (instance-local). Virtual projects can be injected by adapters at startup (e.g., Slack creates a `slack-room` project for conversational interactions).

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
| `list_cron_jobs` | List all cron jobs with state |
| `get_cron_job` | Get job definition + state + run log |
| `create_cron_job` | Create a new agent cron job on disk |
| `delete_cron_job` | Remove a cron job folder |
| `pause_cron_job` | Pause a job without deleting |
| `resume_cron_job` | Resume a paused job |
| `get_cron_run_log` | Query recent run log entries |

All tools are scoped to the parent project — bots only see their own project's data. Cron MCP tools require the `agent-draft` permission on the role.

## Cron System

The cron system (v2) enables scheduled autonomous agent work — recurring tasks, board monitoring, standup reports, and any job that should fire on a schedule without human initiation.

### Architecture

Four modules collaborate:

```
job.md + settings.toml + handler.ts     (instance content, in COLLABOT_HOME/cron/)
         │
         ▼
   cron-loader.ts        parse job folders → CronJobDefinition[]
         │
         ▼
   cron-bridge.ts        build executable handlers, manage CronHandlerContext, run logs
         │
         ▼
    cron.ts               CronScheduler — tick loop, state persistence, pause/resume
         │
   cron-mcp.ts           MCP tools for runtime job management
```

### Job Types

**Agent jobs** — the simple path. A `job.md` with YAML frontmatter (name, schedule, role, project) and a markdown body that becomes the agent prompt. The bridge calls `collabDispatch()` directly. No custom code needed.

**Handler jobs** — the programmable path. A `job.md` with `handler: true` plus a `handler.ts` file (and optional `settings.toml`). The handler receives a `CronHandlerContext` with config access, dispatch capability, run log history, and an abort signal. Handlers can make HTTP calls, inspect external state, and conditionally dispatch zero or more agents. The board-watcher is the canonical example: it checks Collaboard for activity and only dispatches when there's work to do.

### Job Lifecycle

1. **Load** — `loadCronJobs()` scans the configured jobs directory, parses each subfolder's `job.md`
2. **Register** — `buildJobHandler()` wraps each definition into a runnable function, `registerDefinition()` adds it to the scheduler
3. **Schedule** — the scheduler's 1-second tick loop evaluates cron expressions, intervals, or one-shot times
4. **Fire** — when a job's next fire time arrives, the handler executes
5. **Bridge** — agent jobs call `collabDispatch()`, handler jobs call the loaded TypeScript function
6. **Run log** — every execution (success or failure) appends to `runs/{jobName}.jsonl`
7. **State** — per-job state (lastRunAt, runCount, consecutiveFailures) persists to `cron-state.json`

### CronHandlerContext

Handler jobs receive a context object with:

| Property | Type | Purpose |
|----------|------|---------|
| `config.job` | `Record<string, unknown>` | Parsed `settings.toml` for this job |
| `config.harness` | `Config` | Full harness config |
| `config.projectEnv(project)` | `Record<string, string>` | Read a project's `.agents.env` |
| `job` | `CronJobDefinition` | The job's definition |
| `lastRunAt` | `Date \| null` | When this job last fired |
| `dispatch(opts)` | `Promise<CollabDispatchResult>` | Dispatch an agent via `collabDispatch()` |
| `getRunLog(limit?)` | `RunLogEntry[]` | Recent run history |
| `signal` | `AbortSignal` | Abort signal for cancellation |
| `log` | `Logger` | Structured logger |

### Configuration

The `[cron]` section in `config.toml`:

```toml
[cron]
enabled = true
jobsDirectory = "cron"               # relative to COLLABOT_HOME
maxConsecutiveFailures = 5            # auto-disable threshold (overridable per job)
```

### Auto-Disable

Jobs that fail consecutively are automatically disabled. The threshold defaults to `maxConsecutiveFailures` in config but can be overridden per job in frontmatter. Disabled jobs can be resumed via the `resume_cron_job` MCP tool or by restarting the harness (which resets state).

### Templates

Shipped templates in `harness/templates/cron/` provide starting points:

- `board-watcher/` — handler job that checks Collaboard for activity
- `collabot-standup/` — agent job that generates daily standup reports
- `task-rotation/` — handler job stub for daily task rotation (legacy)

Users copy templates to their instance's cron directory and customize.

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
9. **Cron** — load job definitions, build handlers, hydrate state, start scheduler + MCP server
