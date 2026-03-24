# Collabot — The Collaborative Agent Platform

## Identity

Collabot is a general-purpose agent orchestration platform. It dispatches, coordinates, and manages AI coding agents across any number of projects. A **project** is a logical product that may span multiple repositories (e.g., API + portal + mobile app). Collabot provides the infrastructure; projects bring the domain knowledge.

**Collabot never stores project domain knowledge.** Domain docs (ecosystem maps, API contracts, glossaries, release tracking) belong in the project repos, not here. The platform owns orchestration, roles, skills, and agent lifecycle.

## .agents/ Directory Structure

`.agents/` is the instance-local workspace (gitignored). Every file has a designated home. **No loose files anywhere.**

```
.agents/
├── roadmap/
│   └── INDEX.md              # Living backlog — what's next, ideas, decisions
├── specs/
│   ├── TEMPLATE.md           # Spec template
│   └── <active specs only>   # Specs being planned or implemented
├── kb/
│   └── <stack>/<topic>/      # Knowledge bases — META.md + INDEX.md + topic files
├── research/
│   └── <topic>/              # Research outputs — one folder per effort
├── temp/                        # Scratch files, working docs, agent handoffs — cleaned regularly
├── archive/
│   ├── specs/                # Completed specs
│   ├── milestones/           # Milestone handoff docs
│   ├── postmortems/          # Retrospectives + meeting logs
│   └── vision/               # Early brainstorming docs
└── WORKFLOW.md               # Planning workflow and cleanup checklist
```

### Rules

1. **No loose files.** Every file goes in its designated folder. Nothing in `.agents/` root except `WORKFLOW.md`.
2. **Specs are working set only.** When an initiative merges to master, move the spec to `archive/specs/`.
3. **Roadmap is the source of truth for future work.** Ideas from specs, postmortems, and discussions are extracted (copied, never cut) into `roadmap/INDEX.md`. See the roadmap: `.agents/roadmap/INDEX.md`.
4. **Research is grouped.** Each research effort gets its own folder under `research/`. No loose files.
5. **Archive is append-only.** Things go in, nothing comes out.
6. **Wikilink-style linking.** Cross-references between `.agents/` documents use `[[path/to/file]]` syntax (no `.md` extension). Use `[[path/to/file|display text]]` when the filename isn't human-friendly.
7. **`temp/` is the scratch pad.** Working documents, agent handoffs, audit checklists, and any transient files go here — not in other directories. Before cleaning `temp/`, agents must verify nothing needs to be captured elsewhere (roadmap, memory, archive).
8. **Run cleanup between milestones** to enforce structure, extract roadmap items, and move completed specs.

### Lifecycle

| Trigger | Action |
|---------|--------|
| New initiative starts | Create spec in `specs/`. Add to `roadmap/INDEX.md` Active Initiatives. |
| Initiative merges to master | Move spec to `archive/specs/`. Remove from Active in roadmap. |
| Post-mortem completed | File to `archive/postmortems/`. Extract future items to `roadmap/INDEX.md`. |
| Idea captured | Add to `roadmap/INDEX.md` under Ideas. Detail file in `roadmap/` only if needed. |

## Core Architecture

The **harness** (`./harness/`) is the core orchestration engine — a persistent Node.js/TypeScript process that manages agent lifecycle, task state, context reconstruction, and the MCP tool surface. It dispatches Claude Code agents via the Agent SDK (`@anthropic-ai/claude-agent-sdk`).

**Interfaces are adapters.** They connect to the harness via the `CommunicationProvider` interface, managed by a `CommunicationRegistry` that handles broadcast, lifecycle, and provider discovery. No interface is primary. No interface owns the harness.

| Adapter | Description | How to use |
|---------|-------------|------------|
| Slack | DM the bot with a task | Requires `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` in `.env` |
| CLI | One-shot dispatch | `npm run cli -- --project <project> --role <role> "prompt"` |
| WebSocket | JSON-RPC 2.0 over WS | External processes connect to `ws://127.0.0.1:9800` |
| TUI | Terminal UI (.NET 10) | Separate repo: `github.com/MrBildo/collabot-tui` |

Source is in `./harness/src/`.

### Entity Model

**Bot** (WHO/WHY) → **Role** (WHAT) → **Skills** (HOW)

- **Bots** (`./bots/`) — persistent identities with soul prompts. `BotSessionManager` is the unified session system — all interactive work (TUI drafts, Slack DMs) routes through it.
- **Roles** (`./roles/`) — behavioral profiles with YAML frontmatter (id, version, name, model-hint, permissions). Tech-stack-focused, not project-specific.
- **Projects** (`.projects/<name>/project.toml`) — local-only manifests declaring name, description, paths, and roles. Gitignored.

Every interactive conversation is with a bot. Draft = borrowing a bot from lobby. CLI one-shot dispatch is botless.

**Bot identity model:** A bot having a Slack account does NOT make it a "Slack bot." A bot's soul + role dictates WHAT it does. The project determines WHERE it is. Provider accounts determine HOW it's reachable. Bot -> Role (WHAT) -> Project (WHERE) -> Provider account (HOW). Grand vision: bots will have limited agency — schedules, goals, ability to decide what to work on.

**Bot configuration:** Bot default project and role are configured in `[bots.*]` in `config.toml`, not in provider-specific sections like `[slack.bots.*]`. Provider config sections hold credentials only.

### Known Gaps

Three architectural gaps that guide development priorities:

1. **Tasks** — Data is captured but nothing is done with it yet. Future cron maintenance jobs will inspect closed tasks across projects, synthesize them into bot memory, then clean up. The data shape matters now; processing comes later.
2. **Roles/Bots** — Only scratched the surface. These are the two key factors in how Collabot operates. The goal is to "gamify" agents — personality + memory leads to emergent behavior.
3. **Session/Context Management** — Massive known gap. Minimal context management today. Will be addressed. When making assumptions, assume we will have an answer for this.

## Dev Directory

`dev/` contains all instance-local files for development (gitignored). This is the dev equivalent of `~/.collabot/` in production.

```
dev/
├── bots/           # Bot definitions (soul prompts)
├── roles/          # Role definitions
├── .projects/      # Project manifests + task data
├── prompts/        # Runtime system prompt
└── config.toml     # Instance config (from config.defaults.toml)
```

`COLLABOT_HOME` in `harness/.env` points to `dev/`. The harness resolves all instance paths from there.

## Running the Harness

```powershell
cd harness
npm run dev
```

Runs `tsx watch` piped through `pino-pretty`. Slack adapter starts if tokens are in `.env`.

**CRITICAL — Kill all node instances before any harness work or testing.**
On Windows, closing a terminal does NOT kill child processes. Instances accumulate silently. If Slack is enabled, Socket Mode routes messages to the oldest instance, so code changes appear to have no effect.

```powershell
Stop-Process -Name node -Force
```

**Tests:** `npm test` from `harness/`. Uses Node's built-in `node:test` runner via `tsx --test`. Do NOT use vitest, jest, or any other runner.

## Verification — Dead Code Detection

The harness uses **Knip** to detect orphan modules — files that exist but are never imported from any entry point. This is a CI gate. PRs will fail if orphan files are found.

**When to run:** After creating or modifying any source file. Run before committing and before moving any card to Review.

```powershell
cd harness
npm run lint:dead-code    # full report (files, exports, dependencies)
npx knip --include files  # quick check — orphan files only (same as CI)
```

**How to read the output:**
- `Unused files` — **CRITICAL.** A file exists but nothing imports it. This means you built a module but never wired it into the startup sequence or another production path. The code is dead. Fix: import it from `index.ts` or wherever it needs to be called.
- `Unused exports` — **WARNING.** A function or type is exported but never used outside its file. May be intentional (public API for consumers) or may indicate a function you wrote but forgot to call. Investigate before ignoring.
- `Unused dependencies` — **INFO.** A package in `package.json` that no source file imports. May indicate a removed feature or a dependency only used at runtime (like `pino-pretty`). These are excluded via `ignoreDependencies` in `knip.json`.

**How to respond to findings:**
1. **If Knip flags a file you just created:** You forgot to wire it in. Find the entry point (`index.ts`, `cli.ts`, or an existing module) that should import and call your new code. Do NOT delete the file or suppress the warning — fix the wiring.
2. **If Knip flags an export you just wrote:** Either import and use it from the caller, or remove the `export` keyword if it's only used internally.
3. **Never suppress Knip by removing the check.** If you believe a finding is a false positive, add it to `knip.json` configuration with a comment explaining why.

**The rule:** If Knip says a file is unused, the harness doesn't know it exists. Typecheck and tests cannot catch this — a module can compile, pass all tests, and still be dead code. Knip is the only tool that detects this failure class.

**Config:** `harness/knip.json`. Entry points are auto-discovered. Templates and test files are handled automatically.

## Definition of Done

**A feature is not done until it is observable in the running harness.** Typecheck passing and tests green are necessary but NOT sufficient. If you create a new module, it must be imported and called from a production path (`index.ts`, `cli.ts`, or another module that is). If you start the harness with `npm run dev` and see no evidence of your feature in the logs, the feature is dead code — regardless of how many tests pass.

Before moving any card to Review or declaring work complete:
1. `npm run typecheck` — must pass
2. `npm test` — must pass
3. `npx knip --include files` — must show zero unused files
4. `npm run dev` — your feature must appear in startup logs or be exercisable through an adapter

**Keepalive pings:** If you set up a `CronCreate` keepalive during a long session, run `npx knip --include files`, not `tsc --noEmit`. Typecheck proves code compiles; Knip proves code is connected. The latter catches real problems.

**Unsupervised multi-card work:** When implementing multiple cards without human oversight, run the full verification suite (steps 1-4 above) after every 2-3 cards. If Knip reports unused files or the harness fails to boot, **stop immediately** — do not continue building on unverified work. Leave a note on the card and in the session explaining what failed. Building 6 modules without verifying any of them compounds errors silently.

**Implementation journal:** When working on a card, add a comment to the card AS you work — not just when you're done. Include: files modified, entry point changes (or "none yet"), verification status. Example:

> **In progress — modified:** `cron-loader.ts` (new), `config.ts` (added [cron] schema). **Entry point changes:** none yet — needs `index.ts` wiring. **Verified:** typecheck ✓, tests ✓, Knip: 1 unused file (expected until wired).

The absence of "entry point changes" on a card that creates a new module is a visible red flag — to the agent, the human, and any future agent reading the card.

## Dispatching Work

### Harness Dispatch (Primary)

The harness handles role resolution, event capture, structured output, error loop detection, context reconstruction, and MCP tool injection.

### Fallback: CLI Dispatch

For one-offs when the harness isn't running:

```powershell
cd ..\<project-repo>
$env:CLAUDECODE = $null
claude -p "<task prompt>" --output-format text --dangerously-skip-permissions
```

### Dispatch Rules

- **Spec first:** Write specs to `.agents/specs/` before dispatching. No dispatch without a spec.
- Include ALL context the child needs — it has no memory of this session
- **Ask, don't guess:** Include: "If you get stuck or unsure, report back rather than guessing."
- Max 3 follow-up rounds per task before escalating to user
- Dispatch in parallel when independent, sequentially when dependent
- **When dispatching to .NET projects:** Build failure from locked DLLs (MSB3027) means compilation succeeded — running API holds the lock.
- **Preserve context during design sessions:** Delegate ALL non-discussion tasks to sub-agents. Reading large files, scraping web pages, or exploring code pollutes the main context. The discussion thread and design decisions need to stay in context.

### Sub-Agent Conventions

When dispatching coding or evaluation sub-agents via the Agent tool:

- **Model:** Always use `model: "opus"` (Opus High)
- **Skills:** Instruct sub-agents to use skills appropriate to the task — e.g., dotnet-dev for C# tasks, typescript-dev for TypeScript. A research agent doesn't need coding skills.
- **Report format:** Every sub-agent must return a standardized report. Include this template in the prompt:

```
Return your findings in this standardized format:

## Report: <card or task title>

### Summary
<1-2 sentence verdict>

### Deliverable Status
| Deliverable | Status | Notes |
|---|---|---|
| <item> | Done / Partial / Missing | <detail> |

### Verification
- Typecheck: <pass/fail/not run>
- Tests: <pass/fail/not run — include count>
- Knip: <pass/fail/not run — include findings>

### Files Touched
- <path> — <created/modified/read> — <what changed>

### Gaps & Issues
1. <issue description>

### Convention Violations
<list or "None">

### Recommendation
<next steps, move to Review, stays in Ready, etc.>
```

### Parallel Dispatch

**Partition by resource, not by task.** When dispatching parallel agents, group work by the files being touched — not by the card or task being worked on. Two cards that edit the same files must go to the same agent. Two cards that touch completely separate projects can go to separate agents. The rule: **if two agents could write to the same file, they must be the same agent.**

When multiple agents need the same repo simultaneously, use **git worktrees** for physically separate working directories.

```powershell
git worktree add ../<repo>-wt-<short-name> -b feature/<branch-name> <start-point>
cd ../<repo>-wt-<short-name>/harness && npm install
```

Each worktree needs its own `npm install`. The `.git` store is shared.

## Task System

Tasks are scoped to projects, tracked in `.projects/<project>/tasks/{task-slug}/`:
- `task.json` — manifest (slug, name, project, status, timestamps)
- `dispatches/{dispatchId}.json` — dispatch envelope + event stream

Lifecycle: `open` → `closed` → `synthesized`. Created via CLI, WS, or MCP tools.

**Task != session.** A task has many bots, each with their own context (approximating an SDK session). When a task closes, a memory manager will process the context into bot memories. `TASK.md` is a living shared context document per task, managed via MCP tools. `PROJECT.md` is the project-level CLAUDE.md equivalent, injected by the harness.

### Context Model

Tiered context architecture for managing agent memory:

- **Raw** — full transcript of all dispatches within a task
- **Immediate** — trimmed, curated context injected into the current dispatch
- **Archived** — filed context accessible via tools, not injected by default

Bot memory is cross-task and cross-project, formed from task work, human interactions, bot interactions, and self-learning. The `countTokens` API (`POST /v1/messages/count_tokens`) is free and authoritative — use it for per-component token tracking before assembling context.

## Agent SDK Integration

### Windows Environment

Two env vars in `buildChildEnv()` (`harness/src/dispatch.ts`):

1. **Strip `CLAUDECODE`** — cli.js exits with code 1 if it detects a nested session
2. **Set `CLAUDE_CODE_GIT_BASH_PATH`** — cli.js auto-detects bash incorrectly on Windows. Must use Windows backslashes.

Configured in `.env`. See `.env.example`.

### SDK Boundary Rule

The Agent SDK is a **tool runtime only**. Collabot uses it for tool execution (Read, Write, Edit, Bash, etc.) and MCP. Never depend on SDK session resume, JSONL storage, or auto-compaction for memory. Context is injected via `query()` with `AsyncIterable<SDKUserMessage>` — Collabot constructs the full message history and feeds it to the SDK. `persistSession: false` disables the JSONL file. Tool execution, MCP, and permissions all work unchanged.

**V2 Session API (`unstable_v2`) is NOT viable** — missing critical options (`systemPrompt`, `mcpServers`, `maxTurns`, etc.).

Any "quick win" that uses SDK configuration (betas, effort, model hints) is fine — those don't create memory dependency. Hybrid approaches (SDK manages within-session, Collabot manages cross-dispatch) are transitional stepping stones, not design targets.

### SDK Permissions Model

- `permissionMode` — controls whether permission prompts happen (e.g., `bypassPermissions` skips all prompts)
- `disallowedTools` — removes tools from model context entirely. Always enforced, cannot be overridden by user settings.
- `tools` — defines the base tool set (explicit list or `claude_code` preset)
- `allowedTools` — auto-approves tools without prompting (only relevant when prompting is enabled)
- `settingSources` — controls which settings files the subprocess loads (`['user']`, `['project']`, or both)

**Current usage:** `bypassPermissions` + `settingSources: ['project']` + no tool restrictions.

**Important nuance:** `disallowedTools`/`tools` are tool AVAILABILITY, not permission checks. The harness enforces restrictions that user `settings.json` cannot override.

### SDK Gotchas

- **Prompt caching affects token counts.** Real context = `input_tokens + cache_read + cache_creation`.
- **17+ message types.** The event system v2 now captures all 20 mapped event types (was 5).
- **Draft sessions use unlimited loop detection thresholds** (all zeros).

## Communication & Adapters

### Virtual Projects

Virtual projects are non-disk-based projects used for bot lifecycle management:

- **`lobby`** — idle state, harness-owned. Where bots go when not assigned to a project. Should have zero disk presence (no `.projects/lobby/project.toml`, no task folders). The current disk-based implementation (`ensureVirtualProject()`) is technical debt.
- **`slack-room`** — Slack surface, provider-injected via `getVirtualProjects()`. Where bots go when active on Slack. A bot in `slack-room` without a Slack account is parked (no-op); a bot WITH a Slack account shows as online.

**Safety rule:** Virtual projects must NEVER be valid dispatch targets for `collabDispatch()`. No cron jobs, no `handleTask`, no `draftAgent`, no MCP `draft_agent` can dispatch into a virtual project. Virtual projects exist solely for BotSessionManager sessions, which have their own SDK query loop. An `isVirtualProject(project)` guard in `collabDispatch()` must reject these immediately after project resolution.

### Provider Interface

Providers implement optional methods the harness calls during startup:
- `getVirtualProjects?()` — returns `VirtualProjectRequest[]` declaring virtual projects and their tool restrictions

**Startup sequence:** load providers -> validate -> foreach provider: call `getVirtualProjects()` -> harness validates -> harness resolves/creates.

Virtual projects carry tool restrictions via SDK `disallowedTools`/`tools`, passed to `query()` at draft time. Works even with `bypassPermissions`.

### Slack

**Bot presence limitation:** `always_active: true` is set on Slack apps, and the green dot is always on. `users.setPresence` calls are effectively overridden by `always_active`. The vision of "away when not in slack-room" can't work with current Slack APIs. Lowest priority — `setPresence()` code remains in place for future revisit.

**Hazel app scopes:** Current: `chat:write`, `im:history`, `im:read`, `reactions:read`, `reactions:write`, `app_mentions:read`, `users:write`, `users:read`. Needed for channel participation: `channels:history`, `groups:history`.

**Day-1 slack-etiquette:** Injected via `systemPrompt.append` when a bot is in `slack-room`. No discovery or activation mechanic — always-on for that project. Full skill pipeline is a separate initiative.

### Bot Presence

Bot presence is tied to project membership:
- Bot in `slack-room` = Slack presence online
- Bot NOT in `slack-room` = Slack presence away
- Harness shutdown = presence away (automatic)

### WS Protocol

`ChannelMessage` types union: `lifecycle | chat | question | result | warning | error | tool_use | thinking`.

`draft_status` notification fields: `SessionId`, `Role`, `Project`, `TurnCount`, `CostUsd`, `ContextPct`, `LastInputTokens`, `LastOutputTokens`, `LastActivity`. `LastOutputTokens` is per-turn (not cumulative). `LastInputTokens` is cumulative context size.

## Planning Workflow

See [[.agents/WORKFLOW]] for the full process (instance-local).

**Summary:** Task intake → impact analysis → feature spec (with test plan) → branch planning → sub-project handoff → testing → PR review

### Card Authoring — Entry Point Rule

When a card creates a new module (a new `.ts` file), the card description MUST include an **Entry point** line near the top — not buried in deliverables. This tells the implementing agent exactly where the new code gets called from.

```
**Entry point:** `index.ts` must import `loadCronJobs()` and call it after entity loading, before scheduler start.
```

If the card adds functionality that requires startup wiring, this must be explicit. A card without an entry point line implies the module is called from an existing module that already has a production path — if that's not the case, add the line. This prevents the failure mode where a module is built, tested, and committed but never wired into the running system.

## Skills

Use available skills proactively when the task matches — e.g., invoke dotnet-dev when writing C# or typescript-dev for TypeScript. Skills are declared in your session; no need to search directories.

### Skills System Architecture

**Standard:** Skills follow the [agentskills.io](https://agentskills.io) spec (Anthropic-maintained, 30+ adopters including Claude Code, Codex, Cursor, Windsurf). Format: `SKILL.md` with YAML frontmatter in a named directory. Required frontmatter: `name` (max 64 chars, lowercase+hyphens), `description` (max 1024 chars). Progressive disclosure: metadata (~100 tokens) at startup -> body (<5000 tokens) on activation -> resources on demand.

**Provider skills replace provider-assigned roles.** Slack etiquette and behavior instructions are skills, not role concerns. Providers offer skills injected when a bot is in that provider's project. Skills are a property of the virtual project. Composition at draft time: soul prompt + role + project skills.

**Discovery paths** are configurable in `[skills]` config. Harness project skills (`.projects/<name>/skills/`) are a fixed convention.

### Claude Code Integration

- **Discovery:** Scans `~/.claude/skills/` (personal), `.claude/skills/` (project), enterprise managed settings. At startup: reads only frontmatter. Skills only discovered when `settingSources` includes the relevant scope — `['project']` means no user skills.
- **Presentation:** Skills are NOT in the system prompt. Embedded in the Skill tool's description as `<available_skills>` XML block. Character budget: ~15K chars.
- **Activation:** Manual (user types `/skill-name`) or agent-driven (~20% reliability per community research).
- **CC-specific extensions:** `$ARGUMENTS` substitutions, dynamic context injection via `` !`command` ``, `context: fork` for subagent execution, `model:` field, hooks.

### Known Issues

**Progressive disclosure bug** (GitHub issue #14882): full SKILL.md body loads at startup, not just frontmatter. The intended behavior is two-phase but Claude Code hasn't achieved it yet. Multiple duplicates, no official fix.

### Implementation Strategy

Two fundamentally different skill mechanisms exist across the ecosystem:
1. **Claude Code approach:** Dedicated Skill tool with metadata in tool description. Body injected as hidden conversation message.
2. **Codex approach:** Skill metadata in system prompt. Model reads SKILL.md via filesystem tools. No special tool.

Three implementation scenarios for Collabot:
- **A: SDK built-in** — Layers 1+3 work if `settingSources` includes `'user'`. Harness project skills need a hack. Locked to CC conventions.
- **B: Own pipeline (preferred direction)** — Full control, all layers first-class, configurable paths. Codex approach (system prompt + file-read) is simpler. More work upfront.
- **C: Model adapters** — Architecturally correct, future-proof. Most work, premature without multi-model timeline.

### Prompt Assembly

Prompt assembly order: `system` -> `role` -> `[skills]` -> `soul`. Later content = higher LLM priority. `tools.md` was killed (MCP tools are injected programmatically via SDK `mcpServers`). `system.md` contains only what makes Collabot work — not generic agent instructions, not user-editable.

## CLI & Scaffolding

### Research Summary

Surveyed 13 Node.js tools (Astro, SvelteKit, Nuxt, Strapi, etc.). Three patterns: "configure up front" (interactive wizard), "start minimal" (bare minimum), "two-phase init" (CLI scaffolding + web/interactive config). CLI library: `@clack/prompts` (modern standard, used by SvelteKit, Payload, Nuxt).

### Two-Command Split

#### `collabot init` — Mechanical Scaffolding (non-interactive)

Creates the skeleton. Does NOT create any entities (no roles, no bots). The harness won't boot after just `init`.

| Step | Output |
|------|--------|
| Create instance root | `~/.collabot/` (or `$COLLABOT_HOME`) |
| Create directory structure | `roles/`, `bots/`, `skills/`, `.projects/`, `docs/`, `prompts/` |
| Copy config defaults | `config.toml` (from `templates/config.defaults.toml`) |
| Write .env template | `.env` with empty placeholders |
| Write system prompt | `prompts/system.md` |

Flags: `--yes` / `-y` for CI/scripted use. `skills/` and `docs/` dirs are NOT created by init — created later if needed.

#### `collabot setup` — Interactive Wizard

Uses `@clack/prompts`. Walks the user through configuring a bootable instance. Runs `init` first if needed.

Steps: API key -> platform checks (OS, prerequisites) -> role selection (from `templates/roles/`) -> bot selection (from `templates/bots/`) -> Slack config (optional) -> validation.

### Principles

- **No fake entities.** Bots and roles are curated — scaffolding doesn't stamp out templates pretending to be real entities.
- **Init is scriptable.** Always non-interactive, always the same output.
- **Setup is the bridge.** Until entity authoring lands, the wizard handles the hard parts.
- **Every interactive tool needs a `--non-interactive` mode** for CI/scripted use.

### Template Structure

All default/template content lives under `harness/templates/`:

```
harness/templates/
├── config.defaults.toml
├── env.template
├── prompts/
│   └── system.md
├── roles/
│   ├── assistant.md, researcher.md, dotnet-dev.md, ts-dev.md
└── bots/
    ├── agent.md, cheerful.md, methodical.md, concise.md, cautious.md
```

Template frontmatter contains everything EXCEPT `id`, `version`, `createdOn`, `createdBy` — the wizard stamps those at copy time.

### Config Defaults

| Setting | Decision |
|---------|----------|
| `models.default` | Accepts alias names, not just raw model IDs |
| `agent.maxTurns` | Default 0 (unlimited) |
| `agent.maxBudgetUsd` | Default 0 (unlimited) |
| `defaults.stallTimeoutSeconds` | 300s global default |
| `pool.maxConcurrent` | Default 0 (unlimited) |
| `mcp.streamTimeout` | Not in scaffolded config; Zod schema default 600000ms |

## Knowledge Bases

Before starting development work, coding agents MUST check `.agents/kb/` for relevant knowledge bases. Each KB has `META.md` (what/when) + `INDEX.md` (navigation) + topic files. Read the index first — they're designed to minimize context window usage.

## Reference Docs

| Document | Path | Purpose |
|----------|------|---------|
| Architecture | `./docs/architecture.md` | Platform architecture |
| Vision | `./docs/vision.md` | Origin story, design philosophy, growth model |
| Roadmap | `.agents/roadmap/INDEX.md` | Living backlog — what's next |

Project-specific docs live in their respective project repos, not here.

## Collaboard (Kanban)

See [[COLLABOARD]] for board conventions, lanes, labels, sizes, and workflow.

## Architectural Principles

- **Documentation is the product's memory.** Future agents inherit understanding from what's written. Docs evolve in the same commit as architecture.
- **The harness is the core.** Always running, always the center. Interfaces are adapters.
- **We are building a team, not a workflow tool.** The harness is home base for humans and agents.
- **Mechanical vs organic separation.** Model, maxTurns, budget, timeouts = harness mechanics (never in roles). Escalation, retry reasoning = organic.
- **Task is the unit of persistence.** A task spans multiple dispatches, roles, and bots.
- **Context reconstruction over session resume.** Worker bots load task context + bot memory + role, not resume sessions.
- **Tools over tokens.** Deterministic operations should be scripts/tools, not agent reasoning.
- **Curated context > large context.** Structured, well-curated context beats raw window size.
- **Project isolation via MCP.** Agents see only their own project's data. Cross-project dispatch available via `project` parameter on `draft_agent`.
- **Collabot owns all context and memory.** No reliance on any vendor's session management, compaction, or conversation storage. The SDK is a tool runtime only — used for tool execution and MCP, not for memory or session state. This enables future model adapters (GPT, Gemini, etc.) without context management lock-in.

## Agent Behavior Rules

- **Never delete untracked files** unless the user explicitly says to. Untracked files often represent in-progress work, local config, or instance-specific content that can't be recovered.
- **Never auto-fix lint errors.** Stop, summarize the errors, and wait for user instructions.
- **Optimize for safety over speed.** When in doubt, ask rather than guess.
- **During design discussions, delegate non-discussion tasks to sub-agents** to preserve working context. Handle directly: design doc editing, board management, conversation. Delegate: web scraping, file analysis, code exploration, research.

## Known Issues

- **Lobby disk presence is tech debt.** Lobby must have zero disk presence (no `.projects/lobby/project.toml`, no task folders). Current `ensureVirtualProject()` writing to disk is a shortcut. Removing lobby from disk requires refactoring code paths that assume uniform disk-based projects.
- **Cron task naming.** The cron bridge doesn't pass `taskSlug` to `collabDispatch`, so tasks get named from `prompt.slice(0, 80)` slugified (e.g., `you-running-as-cron-job` instead of `e2e-agent`). Impacts observability for recurring jobs.
- **Bot session CWD.** Bot session CWD is currently repo root. Should be project-specific or configurable. Affects which project-scoped skills the SDK discovers.

## Git Rules

- NEVER commit directly to `master` — all changes via feature branch + PR
- Branch naming: `feature/`, `bugfix/`, `hotfix/` (e.g., `feature/add-cron-support`)
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`
- Squash merge to master
- CI must pass before merge (typecheck, dead code check, build, test)
- Releases: GitHub Release with tag `vX.Y.Z` — publish workflow sets `package.json` version from tag

## Relationship to Other Projects

| Project | Path | Relationship |
|---------|------|-------------|
| **Collaboard** | `../collaboard` | Kanban board. Collabot connects via MCP SSE for board operations. |
| **Collabot TUI** | `../collabot-tui` | Terminal UI. Connects to harness via WebSocket. |
| **Ecosystem** | `../ecosystem` | Shared tooling. Collabot consumes ecosystem scripts and protocols. |
| **Research Lab** | `../lab` | Research workspace. Architecture decisions researched here. |
| **Knowledge Base** | `../kb` | Conventions and patterns. Agents consume KB content. |
| **Collabhost** | `../collabhost` | Self-hosted application platform. Will consume Collabot for service orchestration. |

## Path Conventions

- **Relative paths in docs and specs.** Never hardcode absolute paths in committed files.
- **Absolute paths in scripts only** when referencing the script's own location.
- Reference other collab projects as `../<name>` relative paths in CLAUDE.md and runtime configs.

## Context Window Management

- Do NOT read sub-project source code from this workspace — that's for sub-project sessions
- Keep exploration limited to documentation and API contracts
- Spec files should be self-contained so sub-project agents don't need this workspace's context

## Hero's Wall

See [[HEROES]].

## Milestones (Origin Story)

Collabot was born as an agent hub — an orchestration workspace for a single project. Through 8 milestones and 4 post-milestone initiatives, the harness evolved into a general-purpose platform.

| Milestone | Summary |
|-----------|---------|
| A | Foundation: harness core, Slack adapter, config, roles, basic dispatch |
| B | Workflow works: SDK dispatch, journals, structured output, error loop detection |
| C | Multi-project routing, task abstraction, ping-pong detection |
| D | Core decoupled from Slack, CommAdapter interface, CLI adapter, agent pool |
| E | Multi-agent handoff, context reconstruction, task-aware CLI, PM role |
| F | MCP tools — agent-callable harness (draft, await, kill, query) |
| G | WebSocket adapter — JSON-RPC 2.0 over WS, SDK event streaming |
| H | TUI client — .NET 10 Terminal.Gui v2, chat, slash commands, auto-reconnect |

| Initiative | Summary |
|------------|---------|
| #1 | Event system v2 — canonical event stream scoped to dispatches |
| #2 | Communication provider — adapter pattern, CommunicationRegistry |
| #3 | Slack revisited — bot session pattern, multi-bot Bolt Apps, BotSessionManager |
| #4 | Production cutover — TOML migration, unified sessions, bot mobility, context reconstruction |

Milestone specs and handoffs archived in `.agents/archive/`.

### Key Moments

**February 21, 2026, 2:45 PM EST** — First multi-agent orchestrated handoff. A human typed a question into the TUI. The harness routed to a Product Analyst agent, who dispatched two coding agents in parallel via MCP tools, awaited both results simultaneously, synthesized the answers, and reported back — all in 33 seconds. Three concurrent agents coordinated by a PM, through a TUI built the same day.
