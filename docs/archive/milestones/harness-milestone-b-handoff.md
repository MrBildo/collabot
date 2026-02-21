# Workflow Harness — Milestone B Handoff

**Branch:** `workflow-v2` (pushed to remote)
**Date:** 2026-02-18
**Status:** Milestone B complete ✅ — E2E verified via live Slack test

---

## What Was Built

Milestone B goal: *the hub dispatches real sub-project work and reports back.*

**That workflow is working.** Human DMs the bot → harness dispatches a role-based Claude agent to a real sub-project → agent works with the project's own CLAUDE.md and skills → journal tracks every tool call → agent returns structured JSON → harness validates and posts formatted summary to Slack.

| Step | What | Status |
|------|------|--------|
| 0 | QoL: startup banner (ASCII art, versions, config/role summary) + heartbeat logger | ✅ Done |
| 1 | Config system: `config.yaml` + `js-yaml` + Zod validation at startup | ✅ Done |
| 2 | Role definitions: `harness/roles/api-dev.md` with YAML frontmatter + markdown body, role loader | ✅ Done |
| 3 | Dispatch upgrade: role-aware, project-aware, model resolution chain, config-driven timeouts | ✅ Done |
| 4 | Journal system: create before dispatch, harness writes SDK events, agent writes commentary | ✅ Done |
| 5 | Journal watcher: chokidar monitors journals internally (health signals, not Slack) | ✅ Done |
| 6 | Structured output: `AgentResultSchema`, Zod validation, formatted Slack summary, graceful fallback | ✅ Done |
| 7 | Error loop detection: sliding window (10 calls), warn at 3, kill at 5, unit tests | ✅ Done |
| 8 | E2E verification: full checklist passed against live Slack + kindkatchapi dispatch | ✅ Done |

---

## Technical Snapshot

```
harness/
├── src/
│   ├── index.ts        — entry point, banner, config/roles load, Slack start, journal watcher, shutdown
│   ├── slack.ts        — Bolt message handler, agentBusy mutex, reaction flow, formatResult()
│   ├── dispatch.ts     — SDK query() wrapper, role/model resolution, journal lifecycle, error loop integration
│   ├── config.ts       — loadConfig() / getConfig(), Zod-validated config.yaml
│   ├── roles.ts        — loadRoles(), frontmatter parser, Zod-validated role definitions
│   ├── journal.ts      — createJournal, appendJournal, updateJournalStatus, watchJournals, getJournalStatus
│   ├── monitor.ts      — detectErrorLoop() pure function
│   ├── logger.ts       — pino (sync, debug level)
│   ├── types.ts        — all shared types + AgentResultSchema (Zod)
│   ├── config.test.ts  — config schema validation tests
│   ├── roles.test.ts   — frontmatter parsing tests
│   └── monitor.test.ts — error loop detection tests (12 cases)
├── roles/
│   └── api-dev.md      — first role definition (KK API Dev, coding, claude-sonnet-4-6)
├── config.yaml         — model defaults + category timeouts
├── .env                — tokens + env vars (gitignored)
├── .env.example        — documents all env vars
└── package.json        — 15 tests passing
```

---

## Key Architecture Decisions

1. **Slack communication model:** Slack is for human ↔ PM agent conversation, not a firehose. Worker agents talk to journals. PM agent (future) bridges journals to Slack. Journal watcher is internal plumbing.

2. **Two journal channels:** Tool use events from SDK stream = harness ground truth (guaranteed). Agent journal entries = best-effort narrative for PM/humans (not validated).

3. **Role prompt placeholders:** `{journal_path}` in role templates, harness fills in at dispatch time. Tools over tokens.

4. **Structured output capture:** The SDK injects a `StructuredOutput` tool when `outputFormat` is set. The JSON lives in `block.input` of that tool call, NOT in `resultMsg.result`. Harness captures from the event stream.

5. **Project paths:** Resolved relative to hub root for now. Flagged as future abstraction point.

---

## Dispatch API (current)

```typescript
dispatch(
  prompt: string,
  options: DispatchOptions,
  roles: Map<string, RoleDefinition>,
  config: Config,
): Promise<DispatchResult>

type DispatchOptions = {
  cwd: string;           // target project dir (relative to hub root)
  role: string;          // role name to look up
  featureSlug: string;   // journal path construction
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;        // per-dispatch override (highest priority)
  onLoopWarning?: (pattern: string, count: number) => void;
};

type DispatchResult = {
  status: 'completed' | 'aborted' | 'crashed';
  result?: string;              // raw text fallback
  structuredResult?: AgentResult;  // validated structured output
  cost?: number;
  error?: string;
  duration_ms?: number;
};
```

Model resolution: `options.model` > `role.model` > `config.models.default`
Timeout resolution: `config.categories[role.category].inactivityTimeout` (seconds → ms)

---

## .env Configuration

| Var | Required | Notes |
|-----|----------|-------|
| `SLACK_BOT_TOKEN` | Yes | `xoxb-...` |
| `SLACK_APP_TOKEN` | Yes | `xapp-...` (Socket Mode) |
| `CLAUDE_EXECUTABLE_PATH` | Yes (Windows) | Path to installed `claude.exe` |
| `CLAUDE_CODE_GIT_BASH_PATH` | Yes (Windows) | `C:\Program Files\Git\bin\bash.exe` — backslashes required |
| `AGENT_MAX_TURNS` | No | Default: `50`. See TODO in dispatch.ts — needs PM review. |
| `AGENT_MAX_BUDGET_USD` | No | Default: `1.00` |
| `HARNESS_VERBOSE` | No | `true` enables 60s heartbeat logging |
| `HARNESS_POLL_JOURNALS` | No | `true` forces chokidar polling mode (Windows fallback) |

---

## Known Gaps (intentional, not bugs)

| Gap | Why | Closes When |
|-----|-----|-------------|
| Agent questions posted but loop not closed | No session resume — agent terminated when questions surface | Milestone C (session resume) |
| Hardcoded test dispatch | No routing/command system — every DM dispatches api-dev to kindkatchapi | Milestone D (command routing) |
| `humanRespondedSinceWarning` always false | Error loop kill fires unconditionally at 5 reps | Milestone C (session resume) |
| Journal watcher is internal only | PM agent is the intended Slack-facing consumer | Milestone C (PM agent) |
| maxTurns at 50 with TODO | Not clear if turn limits are meaningful for coding agents | Needs PM review — options in dispatch.ts comment |
| Project paths hub-relative | Works for KK; not portable | Harness generalization (future) |

---

## Post-Mortem Highlights (2026-02-18)

**What went well:**
- Coding agents were exceptional — clean one-shot handoffs, discovered SDK behaviors (StructuredOutput tool), caught bugs (error subtypes silently passing as completed)
- Step-by-step independently-verifiable pattern carried perfectly from Milestone A
- Agents compensated for user's TS/Node knowledge gap — the dispatch-to-specialist model works

**Process improvements captured:**
- Dispatch prompts now have a standard "Before reporting done" footer (testing responsibilities)
- Between-milestone cleanup step added to `WORKFLOW.md` (PM-owned)
- Slack communication model should be discussed during planning, not mid-build

---

## What Milestone C Looks Like

Milestone C goal: *the harness is conversational.*

At completion:
- Human DMs the bot and has a back-and-forth conversation (session resume)
- PM agent role (Analyst or Coordinator) handles conversation, reads journals, directs work
- Agent questions can be answered — the loop is closed
- Thread-based context: each thread is a conversation with a specific agent

This is where the harness goes from "demo" to "daily driver."

---

## Reference Docs

| Doc | Path |
|-----|------|
| Architecture | `docs/process/agent-orchestration-architecture.md` |
| Full spec | `docs/specs/workflow-harness.md` |
| Milestone A spec | `docs/specs/workflow-harness-milestone-a.md` |
| Milestone B spec | `docs/specs/workflow-harness-milestone-b.md` |
| Tech notes | `docs/specs/workflow-harness-tech-notes.md` |
| Milestone A handoff | `docs/archive/milestones/harness-milestone-a-handoff.md` |
