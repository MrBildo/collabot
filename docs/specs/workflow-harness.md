# Infrastructure: Workflow Harness

| Field | Value |
|-------|-------|
| **Source** | Architecture discussion 2026-02-17 |
| **Status** | **Signed off** — 2026-02-17 |
| **Created** | 2026-02-17 |
| **Last Updated** | 2026-02-17 (stalling detection, agent categories, deliverables) |
| **Release** | None — new project, independent of app releases |
| **Location** | `kindkatch-agent-hub/harness/` |

## Summary

A persistent Node.js orchestration engine that manages Claude Code agent lifecycle, task state, context reconstruction, and the MCP tool surface. The harness is the core — always running, interface-independent. Interfaces (Slack, CLI, future TUI/web UI) connect to it as adapters implementing the `CommAdapter` interface. The harness replaced the original `claude -p` dispatch pattern with a robust, observable, multi-adapter approach.

> **Historical note:** This spec was originally written 2026-02-17 when Slack was the only interface. Milestone D (2026-02-19) decoupled core from Slack, establishing the adapter pattern. Sections below reflect both the original design intent and the evolved architecture. Phase 1 implementation details are historical records of what was built.

## Vision

The human's primary interface shifts from "sitting in Claude Code" to **interacting with agents through the harness via any adapter** — Slack, CLI, TUI, or future UI. Agents are treated as employees — they have names, report progress, ask questions, and get directed by the human. The harness is the persistent infrastructure that makes this possible. No interface is primary; each is an adapter to the same core.

```
Human (any adapter) ←→ Workflow Harness (always on) ←→ Claude Agent Instances (ephemeral)
                              ↓                              ↓
                     Adapters (Slack, CLI,          Journals, Tasks, Logs,
                      TUI, future web UI)           MCP Tool Surface
```

## Core Principles

1. **Files are the communication bus** — journals, specs, logs. If an agent dies, the files survive.
2. **Tools over tokens** — if an operation has a deterministic correct answer, it's a tool/script, not agent reasoning. If you find yourself prompting an agent to do the same mechanical operation repeatedly, extract it into a tool.
3. **Iterate, don't one-shot** — small milestones, prove each layer, then build the next.
4. **Stalling is the enemy** — agents that aren't making progress get killed. The harness monitors activity and intervenes. Aggressive timeouts are acceptable when journals preserve state for recovery.
5. **Agents are portable workers** — role definitions are additive (appended to Claude Code preset), not replacements. Agents work "over" projects, not married to them. Project-specific context comes from the project (CLAUDE.md, skills), not the agent.
6. **Generic, not project-specific** — the harness is general-purpose orchestration infrastructure. It lives in `kindkatch-agent-hub` and its role definitions reference KindKatch, but the harness code itself has zero knowledge of KindKatch APIs, schemas, domains, or projects. Any project-specific context comes from role definitions and project CLAUDE.md files, not the harness.

---

## Agent Roles

The monolithic "hub agent" is replaced by specialized roles:

### Product Analyst (pre-dispatch)

- Pulls Trello card context
- Discusses design with the human
- Writes and refines specs
- Analyzes cross-project impact
- Owns the spec through sign-off

### Project Coordinator (post-dispatch)

- Reads signed-off spec, plans dispatch order
- Monitors progress (reads journals, synthesizes)
- Handles blocked agents (retry, escalate, redirect)
- Coordinates PR rework cycles
- Reports status to human on demand

### Coding Agents (implementation)

- API Dev, Portal Dev, Tester (project-based for now)
- Receive spec content and work autonomously
- Write progress commentary to journals
- Return structured results

Role definitions live as markdown files (e.g., `harness/roles/product-analyst.md`) with YAML frontmatter (name, category, displayName, iconUrl, model) and a markdown body (prompt content). The harness parses frontmatter with `js-yaml` + Zod validation at startup, stores all roles in a `Map<string, RoleDefinition>`. The markdown body is passed to the SDK via `systemPrompt: { type: "preset", preset: "claude_code", append: roleContent }`. This preserves the full Claude Code system prompt, project CLAUDE.md, and project skills. Frontmatter feeds the harness (persona, timeout category, model selection); body feeds the agent.

Role naming evolves as agent identity matures. Post-mortems are facilitated by either role as needed — no dedicated role yet.

### Model Selection

Each dispatch resolves a model through a layered override system (specific beats general):

1. **Dynamic override** (per-dispatch) — human or coordinator specifies model in spawn command. Phase 2.
2. **Role default** (frontmatter `model` field) — "this role typically needs this reasoning level." Optional.
3. **Category override** (`config.yaml` `models.overrides`) — change model for an entire category without editing role files.
4. **Global default** (`config.yaml` `models.default`) — fallback.

**Phase 1 starting values:**

| Role | Model | Rationale |
|------|-------|-----------|
| Product Analyst | `claude-opus-4-6` | Reasoning quality matters for spec work; cost per conversational turn is negligible (~$0.03). The spec is the document everything flows from — Opus earns its keep here. |
| Project Coordinator | `claude-sonnet-4-6` | More mechanical — journals, status, dispatch decisions |
| API Dev | `claude-sonnet-4-6` | 79.3% SWE-bench (vs Opus 80.8%) at 1/5 cost ($3/$15 vs $5/$25). Escalate to Opus via config if quality is insufficient. |
| Portal Dev | `claude-sonnet-4-6` | Same rationale as API Dev |
| Tester (future) | `claude-sonnet-4-6` | Test writing is more formulaic |

**Escalation path:** If Sonnet 4.6 quality is insufficient for a role/category, change the model in `config.yaml` (category override) or the role frontmatter (role override) and re-dispatch. Not an automated mechanism — a manual config change informed by cost capture data and code review outcomes. Automated re-dispatch on a better model (agent returns `failed`/`partial` → harness re-dispatches on Opus) is Phase 3 territory.

Cost data from `SDKResultMessage` (captured every session) informs whether Sonnet quality is sufficient per role.

---

## Agent Categories

Roles declare a **category** that determines timeout behavior and future meta-hints. Categories are defined in harness configuration — tune values in one place, they apply to all roles in that category.

### Category Definitions

```yaml
# harness/config.yaml (or equivalent)
categories:
  coding:
    inactivityTimeout: 300       # 5 min — tool calls every 5-30s normally; 2-3 min pauses for builds/thinking
  conversational:
    inactivityTimeout: 180       # 3 min — per-turn only (from human message to first response event)
  research:
    inactivityTimeout: 420       # 7 min — more reading, longer think pauses than coding
```

### Role → Category Mapping

Each role definition declares its category:

```yaml
# harness/roles/api-dev.md frontmatter
category: coding
```

| Role | Category |
|------|----------|
| Product Analyst | `conversational` |
| Project Coordinator | `conversational` |
| API Dev | `coding` |
| Portal Dev | `coding` |
| Tester | `coding` |

### Starting Values & Tuning

All timeout values are **starting guesses** based on expected activity profiles. The harness logs every stall detection event, every loop flag, and every kill with full context. Expect to tune aggressively once real usage data is available. Err on the side of logging too much — verbosity can be backed off later.

### Future Extensions

- **Inject timeouts into sessions:** Harness appends current timeout config to role content so agents know their limits and are encouraged to journal frequently ("Your inactivity timeout is 5 minutes. Write to the journal before long operations.")
- **Verbosity controls:** Per-category settings for how often agents should write journal entries
- **Additional meta-hints:** Budget ceilings, model preferences, tool restrictions — all scoped by category
- **1M context window:** The beta flag `betas: ["context-1m-2025-08-07"]` enables 1M tokens (vs 200K default) on Sonnet 4.6 and Opus 4.6. Not used in Phase 1 — prefer smaller, focused context windows. Revisit when long-running sessions or large codebase ingestion is needed. Note: 1M triggers long-context pricing (2x input at $6/MTok, 1.5x output at $22.50/MTok) when input exceeds 200K tokens.
- **Runtime config via harness:** Adjust timeouts, budgets, and thresholds via Slack commands without editing files or restarting.
- **Slack Agents & AI Apps features:** Slack's native AI app surface (enabled via `assistant:write` scope) provides text streaming (`chat.startStream`/`appendStream`/`stopStream`), structured task/plan progress display, loading states, and suggested prompts. Evaluate for Milestone B — stream SDK events to Slack in real-time instead of posting completed messages, show agent progress as native task updates. See research below.

---

## Tech Stack

**Core (always required):**

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Runtime | Node.js (LTS) | Harness application |
| Language | TypeScript | Type safety, SDK compatibility |
| Agents | `@anthropic-ai/claude-agent-sdk` | Spawn/manage Claude instances |
| MCP | Agent SDK `createSdkMcpServer` | In-process MCP tools for agent-callable harness |
| Task Queue | In-memory (PoC) → SQLite (later) | Task lifecycle management |
| File Watching | `chokidar` | Journal file change detection |
| Schema Validation | `zod` | Structured agent output validation |

**Adapters (optional — harness runs without any):**

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Slack adapter | `@slack/bolt` | Slack connection, events, messaging (Socket Mode) |
| CLI adapter | Built-in | Terminal one-shot dispatch |

> **Technical implementation notes** (project setup, dependencies, TS patterns, Slack Bolt patterns, SDK integration details, stalling implementation, logging, testing, Windows considerations) are in the companion document: `docs/specs/workflow-harness-tech-notes.md`

---

## Phase 1: PoC — Prove the Loop

### Milestones

**Milestone A — The pipe works:**
- Harness starts, connects to Slack via Socket Mode
- Human DMs the bot
- Harness spawns a Claude agent (simple task)
- Agent does something observable
- Harness posts the result back to Slack
- Prove: Slack ↔ harness ↔ SDK ↔ agent ↔ Slack

**Milestone B — The workflow works:**
- Harness dispatches an agent with a real spec prompt to a real project
- Agent writes to a journal
- Harness detects journal changes, posts updates to thread
- Agent completes, harness posts structured result
- Conversational turn-based interaction works (analyst ↔ human via session resume)
- Prove: journals, file watching, real dispatch, structured output, conversations

### Components

#### 1. Slack App Setup

- Single Slack app registered in the corporate workspace
- Socket Mode enabled (no public URL required)
- Scopes: `chat:write`, `chat:write.customize`, `chat:write.public`, `files:write`, `reactions:write`, `channels:read`, `app_mentions:read`, `im:read`, `im:write`
- App-level token (`xapp-` prefix) with `connections:write` scope
- Multiple agent personas via `chat:write.customize` (different `username` + `icon_url` per message)
- Upgrade to separate Slack apps per agent later when DM-per-agent is needed

#### 2. Harness Core (`src/core.ts` + `src/index.ts`)

> **Note:** This section describes the original Phase 1 design. The actual implementation evolved during Milestone D (2026-02-19), which decoupled core from Slack into `core.ts` (adapter-agnostic logic) + `adapters/slack.ts` + `adapters/cli.ts`. The original `harness.ts` was split into `index.ts` (startup/wiring) and `core.ts` (dispatch orchestration).

The core provides two entry points: `handleTask` (adapter-facing, resolves role and creates tasks) and `draftAgent` (the stable pool primitive, called directly by PM bots and MCP tools). Interfaces connect via the `CommAdapter` interface.

```
index.ts (entry point)
├── Config + Roles loader (fail fast)
├── AgentPool (concurrent agent tracking)
├── MCP Servers (full + readonly, in-process)
├── Conditional Slack adapter (if tokens present)
├── Journal Watcher (chokidar on .agents/journals/)
└── Shutdown handler (abort agents, close connections)

core.ts (adapter-agnostic orchestration)
├── handleTask (resolve role, get/create task, dispatch)
├── draftAgent (pool primitive, direct dispatch)
└── Context reconstruction (prior dispatch results → follow-up prompt)
```

**Startup sequence:**
1. Load config + roles (fail fast before any connections)
2. Initialize AgentPool, MCP servers, DispatchTracker
3. Conditionally start Slack adapter (if tokens present)
4. Start journal file watcher
5. Begin heartbeat (if verbose mode)

**Shutdown:** Graceful — abort active agents, close journal watcher, stop Slack adapter if running.

#### 3. Agent Dispatch (`src/dispatch.ts`)

Wraps the Agent SDK `query()` function with:

- **Role loading:** Read role definition from `harness/roles/<role>.md`
- **Journal creation:** Create journal file with header before spawning
- **Event streaming:** Process `SDKMessage` events as they arrive
- **Hybrid journal updates:** Harness writes SDK events automatically (tool calls, file edits); agent adds meaningful commentary (section starts/completes, blockers, decisions)
- **Stalling detection:** Monitor event stream per agent category timeouts (see Stalling Detection section)
- **Error handling:** Try/catch around entire `query()`. On crash, update journal status to `failed`, notify human
- **Structured output:** Validate agent result against `AgentResult` schema
- **Session tracking:** Capture `session_id`, map to Slack thread for resume
- **Cost capture:** Log `total_cost_usd` and per-model breakdown from every completed session

**Key SDK configuration:**

```typescript
query({
  prompt: taskPrompt,
  options: {
    cwd: projectPath,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: roleDefinition,                            // Role-specific instructions
    },
    settingSources: ["project"],                         // Load project's CLAUDE.md + skills
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    model: resolvedModel,                                 // From role/config/override layers
    maxBudgetUsd: 10.00,                                 // Generous ceiling, tune with data
    maxTurns: 100,                                       // Coding agents only
    abortController: controller,                         // Wall-clock timeout
    outputFormat: { type: "json_schema", schema: agentResultSchema },
  }
})
```

**Conversational agents (Analyst, Coordinator):** No `maxBudgetUsd` or `maxTurns` per turn — turns are short and cheap. Inactivity timeout still applies. Session resumed via `resume: sessionId` on each human reply.

#### 4. Agent Result Schema

```typescript
const AgentResultSchema = z.object({
  status: z.enum(["success", "partial", "failed", "blocked"]),
  summary: z.string(),
  changes: z.array(z.string()).optional(),
  issues: z.array(z.string()).optional(),
  questions: z.array(z.string()).optional(),
  pr_url: z.string().optional(),
});
```

#### 5. Harness Command System (`src/commands.ts`)

The harness recognizes structured commands from two sources:

**Human commands (Slack messages):** Plain text commands in DMs or threads. The harness checks if an inbound message starts with a known command verb before routing to a conversational agent.

```
spawn api-dev kindkatchapi          # Spawn coding agent with role against project
kill api-dev                        # Kill active agent by role
status                              # Report active agents, costs, health
```

**Coordinator commands (structured output):** The coordinator agent's output schema includes an optional `commands` array. After each coordinator turn completes, the harness reads and executes any commands:

```typescript
const CoordinatorOutputSchema = z.object({
  response: z.string(),
  commands: z.array(z.object({
    action: z.enum(["spawn", "kill", "status"]),
    role: z.string().optional(),
    project: z.string().optional(),
    prompt: z.string().optional(),
  })).optional(),
});
```

**Phase 1:** Human commands only (simple string parsing). Coordinator structured output commands designed and typed but execution is manual — coordinator recommends, human confirms.

**Phase 2 target:** Coordinator commands execute automatically. MCP tool approach — harness runs a lightweight MCP server exposing `spawn_agent`, `kill_agent`, `get_status` as tools that conversational agents can call directly mid-turn. Eliminates text parsing entirely.

#### 6. Journal System (`src/journal.ts`)

**Structure:**
```
.agents/journals/<feature-slug>/
  api.md
  portal.md
  tester.md
```

**Journal file format:**
```markdown
# Journal: <feature name>
Spec: docs/specs/<feature>.md
Project: kindkatchapi
Branch: feature/<branch-name>
Started: 2026-02-17 12:34
Status: in-progress | completed | failed | blocked

## Log

- 12:34 — [harness] Branch `feature/...` created from `master`
- 12:34 — [agent] Starting §1: <spec section name>
- 12:35 — [harness] tool_use: Edit `path/to/file.cs`
- 12:35 — [agent] Modified `path/to/file.cs` — added IsDefault property
- 12:36 — [agent] §1 complete
```

**Hybrid authorship:** Entries prefixed `[harness]` are automatic (from SDK events). Entries prefixed `[agent]` are written by the agent. Both contribute to a complete picture. If the agent crashes, harness entries still capture tool activity.

**Journal watcher:** Uses `chokidar` to detect journal file changes. On change, reads new entries and posts to the relevant Slack thread.

#### 7. Slack Message Routing (`src/router.ts`)

**Inbound message routing:**
1. DM to bot → route to appropriate agent handler
2. @mention in channel → route based on channel context or create new task
3. Reply in tracked thread → resume the agent session that owns that thread

**Session lifecycle:**
- New thread → spawn new agent session, store `session_id ↔ thread_ts`
- Reply in existing thread → resume session with `resume: sessionId`
- Context compacted → harness logs it, agent continues
- Context exhausted → harness forks session or spawns fresh with thread summary
- Stale thread (hours/days later) → resume works (sessions persist 30 days)

**Thread-to-agent mapping:**
- Primary: In-memory `Map<thread_ts, AgentContext>`
- Backup: Slack message metadata on parent message (survives restarts)

**Outbound message formatting:**
- Agent persona via `username` + `icon_url` per message
- Status reactions on parent message (👀 picked up, 🔨 in progress, ✅ complete, ❌ failed)
- Block Kit for structured reports
- File upload (`files.uploadV2`) for long content (specs, journals)

#### 8. Agent Personas (PoC)

| Persona | Display Name | Role |
|---------|-------------|------|
| Analyst | KK Analyst | Product analysis, spec writing, design discussion |
| Coordinator | KK Coordinator | Project coordination, status, dispatch |
| API Dev | KK API Dev | kindkatchapi implementation |
| Portal Dev | KK Portal Dev | kindkatchportal implementation |

Avatar hosting: TBD (Azure Blob Storage, static hosting, or embedded data URIs for PoC).

### Slack UX

**Every task is a thread.** The human DMs the bot or @mentions it, starting a thread. All conversation, updates, and results for that task live in the thread. Multiple threads = multiple concurrent tasks.

| Where | What happens there |
|-------|--------------------|
| DM with bot | General conversation — status checks, kicking off tasks, spec planning |
| Thread (in DM) | One task/conversation. Spec planning, implementation updates, all contained. |
| `#agent-ops` | System-level: harness startup, agent crashes, cost reports (optional for PoC) |

Persona names change per message so the human knows which "hat" is talking. Coding agent updates are lightweight — branch created, section started, section complete — not walls of text.

### PoC Success Criteria

- [ ] Harness starts and connects to Slack via Socket Mode
- [ ] Human can DM the bot and receive a response from a spawned agent
- [ ] Turn-based conversation works (human replies → session resumes → agent responds)
- [ ] Harness can spawn a coding agent that does real work in a sub-project
- [ ] Coding agent writes to journal as it works (hybrid: harness events + agent commentary)
- [ ] Harness detects journal changes and posts updates to Slack thread
- [ ] Agent crash is handled gracefully (journal preserves state, human is notified)
- [ ] Cost metrics captured for every completed session
- [ ] All running on Windows dev machine

---

## Stalling Detection & Self-Healing

### Failure Taxonomy

Four distinct failure patterns, prioritized by phase:

| Pattern | Phase | Detection Source | Description |
|---------|-------|-----------------|-------------|
| **Silent stall** | Phase 1 | SDK event stream | Agent stops producing events entirely. Process alive, nothing happening. |
| **Error loop** | Phase 1 | SDK event stream | Agent is active but stuck — hitting the same error, trying the same fix, repeating. |
| **Off-task drift** | Phase 2 | Journal + file paths | Agent is doing work but on the wrong thing. Edits outside expected paths, tangential investigation. |
| **Context exhaustion spiral** | Phase 2 | `SDKCompactBoundaryMessage` | Repeated context compactions, agent losing the thread, repeating itself. |

### Silent Stall Detection (Phase 1)

**Mechanism:** Track timestamp of last `SDKMessage` event received from the async generator. If the gap exceeds the agent's category timeout, the agent is stalled.

**Detection flow:**
1. On each SDK event, reset the inactivity timer
2. Timer fires → agent is stalled
3. Abort via `AbortController.abort()` (clean `AbortError`, not exit code 1)
4. Update journal status to `stalled`
5. Notify human in Slack thread: "Agent stalled (no activity for N min). Journal preserved."
6. Wait for human direction (respawn, abandon, investigate)

**Timeout values by category:** See Agent Categories section. `coding: 300s`, `conversational: 180s` (per-turn), `research: 420s`.

**Conversational agent nuance:** The timeout applies only during an active turn — from when the human message is sent to when the first response event arrives. No timeout between turns (human may be away for hours). The timer resets when the harness sends a message to the agent session.

### Error Loop Detection (Phase 1)

**Mechanism:** Sliding window over recent tool calls extracted from `SDKAssistantMessage` events (which contain `ToolUseBlock` entries).

**What constitutes a loop:**
- Same tool name + same target (file path, command) repeating
- Matching doesn't need to be exact — same tool + same primary target is sufficient
- Common patterns: repeated `Bash` with same build/test command, same file edited multiple times in quick succession, same tool call failing repeatedly

**Response — escalate, then kill:**
1. **3 repetitions:** Post warning to Slack thread — "Agent appears stuck in a loop: [pattern summary]. Still running."
2. Human can intervene at any time (kill, redirect, let it work)
3. **5 repetitions with no human response:** Kill automatically
4. Journal captures the loop pattern for recovery context

**Rationale for escalate-first:** Agents sometimes self-correct on attempt 4-5. Immediate kill is too aggressive. But 5 repetitions with no human input is enough — the waste ceiling is bounded.

### Observability (Phase 1 — Critical)

**Principle: Measure everything, tune later.** We cannot predict how agents will behave in practice. The harness must capture detailed data from day one so we can tune thresholds, identify new patterns, and back off verbosity once we understand the landscape.

**What gets logged (every session):**
- All SDK events with timestamps (tool name, target file/command, duration)
- Every stall detection trigger (which timer, how long, what the last event was)
- Every error loop flag (pattern matched, repetition count, tool call details)
- Every kill (reason, agent state at death, journal state, cost at termination)
- Cost and token usage per session (from `SDKResultMessage`)
- Context compaction events (`SDKCompactBoundaryMessage`)

**Where it goes:** Harness logs (structured, parseable). Slack `#agent-ops` channel for human-visible events (stalls, kills, cost anomalies). Journal files for per-agent history.

### Human-in-the-Loop (Phase 1 Policy)

All stall and error responses are directed to the human for decisions. The harness detects and reports — it does not autonomously recover, retry, or redirect.

**Future phases** may introduce autonomous recovery: harness decides whether to respawn, redirect, or escalate — potentially using a lightweight agent to assess the situation. But this requires real operational data to build trust in the harness's judgment.

---

## Phase 2: Multi-Agent Coordination

> **Status: Milestones D–F complete.** Core decoupled from Slack (D), multi-agent handoff with context reconstruction (E), MCP tools for agent-callable harness (F). Remaining Phase 2 items listed below.

### Completed (Milestones D–F)

- Core decoupled from Slack — `CommAdapter` interface, CLI adapter, headless mode
- Agent pool with concurrent dispatch and abort propagation
- Context reconstruction — follow-up agents receive prior dispatch results automatically
- MCP tools — agents can draft/await/kill other agents, query tasks
- PM role with full MCP access

### Remaining Phase 2 Scope

- PM bot autonomy — PM dispatches and coordinates without human in the loop after initial kick-off
- TUI adapter — interactive terminal interface to the harness (replaces Claude Code CLI as daily driver)
- Git worktree isolation for parallel agents on the same repo
- Agent-to-human question/answer flow via `AskHuman` MCP tool
- Advanced self-healing: off-task drift detection, context exhaustion spiral detection
- Observability — MCP tool usage telemetry, cost/budget governance on `draft_agent`
- Recursion depth limit on agent-initiated dispatch

---

## Phase 3: Agent Meetings & Advanced Communication

> Not building yet. Captured for vision alignment.

### Scope

- Multi-agent threads: multiple agents + human in one conversation
- Hub chairs "meetings" — invites relevant agents, manages turn-taking
- Spec review sessions with specialized agents contributing domain expertise
- Scheduled reports (daily standup summaries, end-of-day progress)
- Slack Canvas integration for living spec documents

---

## Known Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| SDK exit code 1 (opaque crashes) | Critical | Try/catch on all `query()`. Journal captures state. Harness spawns replacement. |
| Agent stalling (no progress) | Critical | Category-based inactivity timeouts + error loop sliding window. Escalate to human, then kill. Journals enable recovery. See Stalling Detection section. |
| Long session context exhaustion | Moderate | 200K default window with client-side compaction (Claude Code handles auto-compaction). Monitor `SDKCompactBoundaryMessage` events. Scope tasks smaller rather than expanding context. 1M beta flag available as future escalation path (see Future Extensions). |
| `chokidar`/`fs.watch` on Windows | Moderate | Test early. Fall back to polling if unreliable. |
| Single Slack app identity limits | Low | Acceptable for PoC. Upgrade to multi-app in Phase 2. |
| SDK version churn | Low | Pin exact version (target 2.1.45+ for `SDKRateLimitEvent` and subagent MCP fix). Upgrade deliberately. |

---

## Needs Investigation

- [x] **Inactivity timeout values** — resolved: category-based (`coding: 300s`, `conversational: 180s` per-turn, `research: 420s`). Starting values, tune with real data.
- [ ] **Avatar hosting** — where to host agent avatar images for `icon_url`
- [ ] **Slack app manifest** — exact manifest YAML for the PoC app
- [ ] **chokidar vs polling on Windows** — reliability test needed
- [ ] **Concurrent SDK sessions** — practical limit on parallel `query()` calls
- [ ] **Session resume after crash** — is session_id still valid after exit code 1?
- [ ] **Cost reporting format** — how to surface per-agent cost data meaningfully

---

## File Organization & Cleanup

### What Gets Committed vs Ignored

The harness generates transient files that should never hit source control. File organization must be right from Phase 1.

**Committed (source):**

| Path | Content |
|------|---------|
| `harness/src/` | Harness application code |
| `harness/roles/` | Role definition markdown files |
| `harness/config.yaml` | Default configuration (categories, timeouts — no secrets) |
| `harness/docs/` | Setup guide, documentation |
| `docs/specs/` | Feature specs (work products, permanent) |
| `docs/` | Permanent reference docs |

**Gitignored (transient/generated):**

| Path | Content | Lifecycle |
|------|---------|-----------|
| `.agents/journals/` | Work-in-progress journals | Live during a feature, stale after merge |
| `harness/logs/` | Session logs, SDK event streams, stalling detection logs | Rotated/deleted periodically |
| `harness/.env` | Secrets (Slack tokens, API keys) | Never committed |
| `harness/node_modules/` | Dependencies | Standard ignore |

**Metrics (long-term value):**

Cost and usage metrics have value beyond any single session — they inform timeout tuning, model selection, and budget planning. These should be persisted separately from throwaway session logs. Options: a `harness/metrics/` directory with structured JSON files, or a SQLite database. Exact format TBD (see Needs Investigation), but the key point is: **metrics are not logs**. Logs rotate. Metrics accumulate.

### `.gitignore` Rules (Phase 1)

The harness project setup must include gitignore entries for all transient paths from day one. This prevents accidental commits of journals, session logs, secrets, or node_modules.

### Cleanup Strategy

**Phase 1 — Manual cleanup, clear conventions:**
- Journals: developer deletes `<feature-slug>/` directory after feature is merged
- Session logs: developer periodically clears `harness/logs/`
- The harness does NOT auto-delete anything in Phase 1

**Phase 2 — Harness-managed cleanup:**
- **Journal archival:** After a feature's PR is merged, harness moves completed journals to an archive (or deletes them). Trigger: human command or detected merge event.
- **Log rotation:** Harness rotates session logs — keep last N days, delete older. Configurable retention period.
- **Stale session cleanup:** Journals with `stalled` or `failed` status older than N days get flagged for human review, then archived/deleted.
- **Cleanup as a tool:** A deterministic cleanup script, not agent reasoning. "Clean up journals older than 7 days" is a script, not a prompt.

---

## Tooling Candidates

Operations that should be deterministic tools (scripts/CLIs), not agent reasoning:

| Operation | Type | Priority |
|-----------|------|----------|
| Send Slack message | Harness core | Phase 1 |
| Create journal file with header | Harness core | Phase 1 |
| Post journal updates to Slack | Harness core | Phase 1 |
| Stalling detection + kill | Harness core | Phase 1 |
| Cost metrics capture | Harness core | Phase 1 |
| Read journal, extract status summary | Script/tool | Phase 2 |
| Create git worktree for agent | Script/tool | Phase 2 |
| Clean up git worktree | Script/tool | Phase 2 |
| Parse PR comments from Bitbucket | `bb` CLI (exists) | Phase 2 |
| Clean up stale journals | Script/tool | Phase 2 |
| Rotate/purge session logs | Script/tool | Phase 2 |

---

## Deliverables

### Setup Guide (`harness/docs/setup-guide.html`)

An interactive HTML guide covering:
- Slack workspace and app creation (scopes, Socket Mode, tokens)
- Harness configuration (config file, role definitions, environment variables)
- First run and verification
- Troubleshooting common issues

**Requirements:** Copy-to-clipboard on all code/config blocks, collapsible sections, step-by-step with screenshots where helpful. Built incrementally — starts with Slack setup for Milestone A, grows with each milestone.

**Platform note:** Instructions assume Windows dev machine. POSIX equivalents noted where different.

---

## Deployment

| Phase | How |
|-------|-----|
| Active harness development | `tsx watch` (auto-restart on code changes) |
| Using the harness day-to-day | `node` in a terminal |
| Production (Mac Mini) | PM2 (process manager, auto-restart, logs) |

---

## Research References

Full research: `.agents/research/agent-orchestration/`

| Reference | Key Takeaway |
|-----------|-------------|
| `sleepless-agent` | Closest architecture — Slack → queue → Claude SDK → git |
| `mpociot/claude-code-slack-bot` | TypeScript Slack-to-SDK bridge reference |
| `ccswarm` | Git worktree isolation pattern |
| Claude Code in Slack (Anthropic) | Target UX — thread-as-context, progress updates |
| Agent SDK docs | `query()` API, session management, structured output |
| Slack Bolt docs | Socket Mode, `chat:write.customize`, message metadata |
| Slack Agents & AI Apps | Native AI surface: text streaming, task/plan display, loading states, suggested prompts. `assistant:write` scope. Evaluate for Milestone B. Docs: https://docs.slack.dev/ai/ |
| Claude Code CHANGELOG 2.1.45 | `SDKRateLimitEvent`/`SDKRateLimitInfo` types, subagent MCP fix, Sonnet 4.6 support |
| Sonnet 4.6 announcement | 79.3% SWE-bench, 1M context (beta), same pricing as Sonnet 4.5 |

---

## Phase Management

This spec is a **living document** that evolves across phases:

- **Phase 1** sections are fully specified and ready for implementation
- **Phase 2/3** sections are captured for vision alignment — they get fleshed out when Phase 1 is complete and we have real operational data
- As phases complete, their sections are marked as implemented (with deviations from spec noted)
- "Needs Investigation" items are resolved and checked off as testing occurs
- New insights from real usage get captured back into the spec

One spec, one document, full picture always in one place.
