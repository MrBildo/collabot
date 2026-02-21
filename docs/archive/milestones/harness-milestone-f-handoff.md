# Milestone F Handoff — MCP Tools for Agent-Callable Harness

**Date:** 2026-02-20
**Branch:** `workflow-v2`
**Commit:** `a2fe588`
**Tests:** 106 passing (was 71), tsc clean
**E2E:** CLI regression, PM full-server injection, dev readonly-server injection, startup banner verified

---

## What Was Built

Milestone F gives dispatched agents the ability to call back into the harness. An in-process MCP server exposes 6 tools — 3 readonly (available to all agents) and 3 lifecycle (available only to conversational roles like the PM).

### Step 0: Smoke Test Spike
- Verified SDK MCP primitives (`createSdkMcpServer`, `tool`) work at runtime
- Added `mcpServers` to `DispatchOptions` in types.ts
- Added `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` to `buildChildEnv()` for long-running tool calls
- Wired `mcpServers` through `dispatch()` → SDK `query()` options

### Step 1: MCP Server Foundation + Read-Only Tools
- New `src/mcp.ts` with `createHarnessServer()` factory
- 3 readonly tools:
  - `list_agents` — shows active agents in the pool
  - `list_tasks` — lists all tasks in the task inventory
  - `get_task_context` — returns reconstructed context for a task (history of prior dispatches)
- Server uses `'sdk'` transport — in-process, no HTTP, no ports

### Step 2: Draft & Lifecycle Tools
- `DispatchTracker` class — maps agent IDs to in-flight dispatch promises
- `DraftAgentFn` type — callback injected to avoid circular dependency with core.ts
- 3 lifecycle tools:
  - `draft_agent` — fires off a new agent asynchronously, returns an agent ID immediately
  - `await_agent` — blocks until a previously drafted agent completes, returns its result
  - `kill_agent` — aborts a running agent via pool + tracker cleanup

### Step 3: Access Control & Config
- New `mcp` section in config.yaml and ConfigSchema
- `fullAccessCategories` determines which role categories get lifecycle tools (default: `['conversational']`)
- `streamTimeout` configurable (default: 600000ms / 10 minutes) for long-running MCP calls
- Dev roles (coding category) get readonly server; PM (conversational) gets full server

### Step 4: Integration & Wiring
- `handleTask()` selects full vs readonly MCP server based on role category
- `draftAgent()` passes selected server as `mcpServers: { harness: server }` to dispatch
- Both `cli.ts` and `index.ts` create shared `DispatchTracker` + `draftFn` + both server instances
- `slack.ts` accepts and forwards `mcpServers` to `handleTask()`
- Startup banner shows MCP config: `mcp: full=[conversational] streamTimeout=600000ms`

---

## Files Changed

### New Files
| File | Purpose |
|------|---------|
| `harness/src/mcp.ts` | MCP server factory, DispatchTracker, all 6 tools |
| `harness/src/mcp.test.ts` | 20 unit tests for MCP tools and tracker |
| `harness/src/mcp-smoke.test.ts` | 5 smoke tests for SDK MCP primitives |
| `harness/src/integration.test.ts` | 6 integration tests (full flow, kill, parallel, access control) |
| `docs/specs/workflow-harness-milestone-f.md` | Milestone spec |

### Modified Files
| File | Change |
|------|--------|
| `harness/src/types.ts` | Added `mcpServers` to `DispatchOptions` |
| `harness/src/dispatch.ts` | `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` env var, mcpServers passthrough to query() |
| `harness/src/core.ts` | `McpServers` type, role-category server selection in handleTask, mcpServer param in draftAgent |
| `harness/src/config.ts` | `mcp` section in ConfigSchema (streamTimeout, fullAccessCategories) |
| `harness/config.yaml` | `mcp:` section with defaults |
| `harness/src/cli.ts` | Creates tracker, draftFn, both MCP servers, passes to handleTask |
| `harness/src/index.ts` | Same MCP setup, headless adapter for MCP-initiated dispatches, banner update |
| `harness/src/slack.ts` | Accepts and forwards mcpServers to handleTask |
| `harness/src/router.test.ts` | Added `mcp` field to manual config construction |
| `harness/src/config.test.ts` | +4 tests for MCP config section |
| `CLAUDE.md` | Updated milestone table with F status |

---

## Design Decisions

1. **Two server instances, not per-client filtering.** MCP spec has no per-client tool filtering. We create two servers at startup (full + readonly) and select at dispatch time based on role category. Simple, no runtime reflection.

2. **DraftAgentFn callback injection.** The MCP server needs to call `draftAgent()` from core.ts, but core.ts imports types from mcp.ts. Solved by defining a `DraftAgentFn` type in mcp.ts and having callers (cli.ts, index.ts) inject the concrete function. No circular dependency.

3. **Fire-and-forget draft, blocking await.** `draft_agent` returns an agent ID immediately without awaiting the dispatch. `await_agent` blocks until the tracked promise resolves. This lets a PM agent draft multiple agents in parallel, then await them individually or together.

4. **Stream timeout as env var.** SDK's `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` prevents the parent from killing child connections during long MCP tool calls (e.g., `await_agent` blocking for minutes). Configurable in config.yaml, defaults to 10 minutes.

5. **Tracker cleanup is caller responsibility.** `await_agent` deletes the tracker entry after returning results. `kill_agent` deletes after abort. No automatic pruning — simple and predictable.

---

## E2E Verification

| Test | Result |
|------|--------|
| CLI regression (api-dev dispatch) | Pass — agent completes normally |
| Startup banner shows MCP config | Pass — `mcp: full=[conversational] streamTimeout=600000ms` |
| PM role gets full MCP server (6 tools) | Pass — agent reports all tools available |
| Dev role gets readonly MCP server (3 tools) | Pass — agent sees only list_agents, list_tasks, get_task_context |

---

## Test Counts by File

| Test File | Tests | Coverage |
|-----------|-------|----------|
| `config.test.ts` | 15 | Config schema + MCP section |
| `context.test.ts` | 7 | Context reconstruction |
| `core.test.ts` | 3 | Core handleTask + context wiring |
| `debounce.test.ts` | 5 | Input debouncing |
| `integration.test.ts` | 6 | Full MCP flow, kill, parallel, access control |
| `mcp.test.ts` | 20 | DispatchTracker, all 6 tools, server creation |
| `mcp-smoke.test.ts` | 5 | SDK MCP primitive verification |
| `monitor.test.ts` | 17 | Error loop + non-retryable detection |
| `pool.test.ts` | 7 | Agent pool + abort propagation |
| `roles.test.ts` | 4 | Frontmatter parsing |
| `router.test.ts` | 9 | Routing resolution |
| `task.test.ts` | 8 | Task creation, result persistence |
| **Total** | **106** | |

---

## Known Gaps

| Gap | Why | Closes When |
|-----|-----|-------------|
| No live PM-drafts-agent test | Requires real multi-dispatch scenario | First real PM task |
| No Slack MCP regression | MCP wiring confirmed via CLI; Slack just forwards | Next Slack session |
| Agent ID collision (theoretical) | `${role}-${Date.now()}-${random4}` — negligible risk at current scale | UUID if pool grows to hundreds |
| No MCP tool usage telemetry | Tools work but no logging of which tools agents actually call | Observability milestone |
| Tracker memory unbounded | Entries accumulate if callers forget to delete | Add TTL or periodic sweep |

---

## What's Next

The harness is now a programmable platform. Agents can see state and spawn other agents. Natural next steps:

1. **PM bot autonomy** — PM reads its own analysis, calls `draft_agent` for implementation steps, feeds results forward via `await_agent`. The plumbing is ready; this is a role prompt + behavior milestone.
2. **Observability** — log which MCP tools agents call, how often, latency. Critical for tuning tool descriptions and understanding agent behavior.
3. **Context budget management** — as task histories grow, `get_task_context` output needs to be selective. Summarization, recency weighting, role relevance filtering.
4. **Bot abstraction** — persistent identity layer above roles. Bots get drafted, accumulate experience, return to pool richer. MCP tools are the primitive this builds on.
5. **Slack UX for multi-agent** — surface draft/await/kill activity in threads. PM bot posts status updates as it coordinates sub-agents.
