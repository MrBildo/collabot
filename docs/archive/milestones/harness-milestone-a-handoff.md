# Workflow Harness — Milestone A Handoff

**Branch:** `workflow-v2` (pushed to remote, up to date)
**Date:** 2026-02-18
**Status:** Milestone A complete ✅ — all deferred items resolved, ready for Milestone B

---

## What Was Built

Milestone A goal: prove the full pipe — *Slack DM → harness → Claude agent → Slack reply*.

**That pipe is working.** All 6 build steps completed:

| Step | What | Status |
|------|------|--------|
| 1 | Slack app created (Socket Mode, scopes, tokens) | ✅ Done (manual) |
| 2 | Harness project scaffolded (Node.js/TypeScript, pino, Bolt) | ✅ Done |
| 3 | Slack Socket Mode connection | ✅ Done |
| 4 | Echo handler (message routing proven) | ✅ Done |
| 5 | Agent SDK dispatch (`query()` wrapping real Claude agents) | ✅ Done |
| 6 | Polish: persona, reactions, stall timer, log enhancements | ✅ Done |

Step 7 (formal E2E verification checklist) was done informally during Step 6 testing — all items confirmed working.

---

## Current Behaviour

When a user DMs the bot:

1. 👀 reaction appears on their message immediately
2. 👀 removed, 🔨 added — agent is being dispatched
3. Claude agent runs the task (real `claude-sonnet-4-6` via Agent SDK)
4. 🔨 removed, ✅ added — agent response posted in thread as "KK Agent"
5. On failure/crash: ❌ reaction, formatted error message in thread

Logs capture: session ID, model, tool calls, cost, duration.

---

## Technical Snapshot

```
harness/
├── src/
│   ├── index.ts      — entry point, env validation, graceful shutdown
│   ├── slack.ts      — Bolt message handler, agentBusy mutex, reaction flow, formatResult()
│   ├── dispatch.ts   — SDK query() wrapper, stall timer, buildChildEnv(), DispatchOptions
│   ├── logger.ts     — pino (sync, debug level)
│   └── types.ts      — DispatchResult, DispatchOptions
├── .env              — tokens + env vars (gitignored)
├── .env.example      — documents all required/optional env vars
└── package.json
```

**Key Windows workarounds in `dispatch.ts`** (documented, stable):
- Strips `CLAUDECODE` from child process env (nested session guard)
- `CLAUDE_CODE_GIT_BASH_PATH` read from env — must be set in `.env` on Windows (backslashes required)
- Uses installed `claude.exe` via `CLAUDE_EXECUTABLE_PATH` env var (not SDK bundled binary)

**Running:** `npm run dev` from `harness/` — `tsx watch` + pino-pretty.

> ⚠️ Always `Stop-Process -Name node -Force` before starting a new harness instance on Windows.
> Closing a terminal does not kill the process. Stale instances accumulate and intercept Slack messages.

---

## Dispatch API (current)

```typescript
dispatch(prompt: string, options?: DispatchOptions): Promise<DispatchResult>

type DispatchOptions = {
  cwd?: string;         // target project dir; defaults to process.cwd()
  maxTurns?: number;    // per-dispatch > AGENT_MAX_TURNS env > 10
  maxBudgetUsd?: number; // per-dispatch > AGENT_MAX_BUDGET_USD env > 1.00
};

type DispatchResult = {
  status: 'completed' | 'aborted' | 'crashed';
  result?: string;
  cost?: number;
  error?: string;
  duration_ms?: number;
};
```

Concurrency: one agent at a time (`agentBusy` mutex in `slack.ts`). Concurrent requests get a "busy" reply.

---

## .env Configuration

| Var | Required | Notes |
|-----|----------|-------|
| `SLACK_BOT_TOKEN` | Yes | `xoxb-...` |
| `SLACK_APP_TOKEN` | Yes | `xapp-...` (Socket Mode) |
| `CLAUDE_EXECUTABLE_PATH` | Yes (Windows) | Path to installed `claude.exe` |
| `CLAUDE_CODE_GIT_BASH_PATH` | Yes (Windows) | `C:\Program Files\Git\bin\bash.exe` — backslashes required |
| `AGENT_MAX_TURNS` | No | Default: `10`. Interim solution — will move to `config.yaml` in Milestone B. |
| `AGENT_MAX_BUDGET_USD` | No | Default: `1.00`. Interim solution — will move to `config.yaml` in Milestone B. |

---

## Deferred Items

### Address before MVP — ✅ All done (2026-02-18)

| Item | Location | Resolution | Status |
|------|----------|------------|--------|
| `maxBudgetUsd: 1.00` hardcoded | `dispatch.ts` | `AGENT_MAX_BUDGET_USD` env var + `DispatchOptions.maxBudgetUsd` per-dispatch override | ✅ Done |
| `maxTurns: 10` hardcoded | `dispatch.ts` | `AGENT_MAX_TURNS` env var + `DispatchOptions.maxTurns` per-dispatch override | ✅ Done |
| `CLAUDE_CODE_GIT_BASH_PATH` hardcoded | `dispatch.ts` | Reads from env var; omitted if not set (non-Windows safe). **`.env` must set this on Windows.** | ✅ Done |
| Agent runs from `harness/` cwd | `dispatch.ts` | `DispatchOptions.cwd` per-dispatch; defaults to `process.cwd()` | ✅ Done |
| No rate limiting | `slack.ts` | `agentBusy` mutex — one agent at a time, "busy" reply if concurrent request arrives | ✅ Done |

> ⚠️ **Windows setup note:** `.env` must include `CLAUDE_CODE_GIT_BASH_PATH=C:\Program Files\Git\bin\bash.exe`
> The hardcoded fallback was removed — dispatch will fail on Windows without this env var set.

### Milestone B scope (not blockers)

> **Milestone B planning is complete.** See `docs/specs/workflow-harness-milestone-b.md` for the full build plan.

**In Milestone B:**
- **Config system** — `config.yaml` with model defaults and category timeouts
- **Role definitions** — per-agent system prompts from `harness/roles/`
- **Dispatch upgrade** — role-aware, project-aware, dispatches to real sub-projects
- **Journal system** — file per agent, dir per feature; harness writes SDK events, agent writes commentary
- **Journal watcher** — internal monitoring (health signals); does NOT post to Slack
- **Structured output** — agent returns JSON schema result, Zod-validated
- **Error loop detection** — sliding window, warn at 3, kill at 5

**Deferred beyond Milestone B:**
- **Session resume** — conversational context across multiple DMs; currently stateless
- **Command routing** — `/status`, `/dispatch <agent> <task>` type commands from Slack
- **Multi-agent** — multiple named bot identities (Hub, API Agent, Portal Agent) with separate personas
- **Proactive messaging** — harness posts to Slack without waiting for a DM (notifications, progress pings)

---

## What Milestone B Looks Like

Milestone B goal: *the hub can dispatch real sub-project work and report back.*

At completion:
- Human DMs hub bot → harness dispatches API Dev agent to `../kindkatchapi`
- Agent works against real project, picks up project CLAUDE.md and skills
- Journal file tracks progress (harness events = ground truth, agent entries = best-effort)
- Agent returns structured result (status, summary, changes, issues, questions)
- Harness posts minimal completion summary to Slack
- Error loop detection monitors agent health, kills spinning agents

Slack is minimal — dispatch notification, completion summary, agent questions only. Journal and tool logging are internal plumbing for the harness and future PM agent, not Slack-facing.

---

## Reference Docs

| Doc | Path |
|-----|------|
| Architecture | `docs/process/agent-orchestration-architecture.md` |
| Full spec | `docs/specs/workflow-harness.md` |
| Milestone A spec | `docs/specs/workflow-harness-milestone-a.md` |
| **Milestone B spec** | **`docs/specs/workflow-harness-milestone-b.md`** |
| Tech notes | `docs/specs/workflow-harness-tech-notes.md` |
