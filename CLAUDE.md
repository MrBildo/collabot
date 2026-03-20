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
8. **Run `/agents-tidy` between milestones** to enforce structure, extract roadmap items, and move completed specs.

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
- **Locked DLL warning:** Build failure from locked DLLs (MSB3027) means compilation succeeded — running API holds the lock.

### Parallel Dispatch (Worktrees)

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

Lifecycle: `open` → `closed`. Created via CLI, WS, or MCP tools.

## Agent SDK — Windows Environment

Two env vars in `buildChildEnv()` (`harness/src/dispatch.ts`):

1. **Strip `CLAUDECODE`** — cli.js exits with code 1 if it detects a nested session
2. **Set `CLAUDE_CODE_GIT_BASH_PATH`** — cli.js auto-detects bash incorrectly on Windows. Must use Windows backslashes.

Configured in `.env`. See `.env.example`.

## Planning Workflow

See `.agents/WORKFLOW.md` for the full process (instance-local).

**Summary:** Task intake → impact analysis → feature spec (with test plan) → branch planning → sub-project handoff → testing → PR review

### Card Authoring — Entry Point Rule

When a card creates a new module (a new `.ts` file), the card description MUST include an **Entry point** line near the top — not buried in deliverables. This tells the implementing agent exactly where the new code gets called from.

```
**Entry point:** `index.ts` must import `loadCronJobs()` and call it after entity loading, before scheduler start.
```

If the card adds functionality that requires startup wiring, this must be explicit. A card without an entry point line implies the module is called from an existing module that already has a production path — if that's not the case, add the line. This prevents the failure mode where a module is built, tested, and committed but never wired into the running system.

## Skills

| Skill | Scope | Purpose |
|-------|-------|---------|
| `/agents-tidy` | Project | Scan `.agents/` structure, flag violations, extract roadmap items, move completed specs |
| `/roadmap` | Project | View and manage `.agents/roadmap/INDEX.md` — add, update, remove backlog items |
| `/spec-discuss` | User | Collaborative spec development through structured design discussion |
| `/post-mortem` | User | Structured retrospective, records meeting, produces action items |
| `/handoff` | User | Generate paste-able session handoff prompt for fresh agent pickup |

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

Work is tracked on Collaboard (MCP server). Auth key is in `.agent.env` (gitignored).

- **Collabot board slug:** `collabot` — harness platform work
- **Auth key:** Use the key from THIS project's `.agent.env` for the Collabot board. If you need to touch the TUI board, use the key from the TUI project's `.agent.env`.
- Cards that are on the daily driver critical path get the `CLI Parity` label
- When completing work on a card, add a comment with the branch name and/or PR link

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

## Git Rules

- NEVER commit directly to `master` — all changes via feature branch + PR
- Branch naming: `feature/`, `bugfix/`, `hotfix/` (e.g., `feature/add-cron-support`)
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`
- Squash merge to master
- CI must pass before merge (typecheck, dead code check, build, test)
- Releases: GitHub Release with tag `vX.Y.Z` — publish workflow sets `package.json` version from tag

## Path Conventions

- **Always use relative paths** in docs, specs, and CLAUDE.md. Never hardcode absolute paths.
- Reference project repos as `../project-api/`, `../project-portal/`, etc.
- Reference platform files as `./` (e.g., `./docs/architecture.md`)
- Instance-local agent artifacts live in `.agents/` (gitignored)

## Context Window Management

- Do NOT read sub-project source code from this workspace — that's for sub-project sessions
- Keep exploration limited to documentation and API contracts
- Spec files should be self-contained so sub-project agents don't need this workspace's context

## Hero's Wall

**[Bot Greg]** — Diagnosed a Windows git-bash path resolution bug buried inside the SDK's bundled `cli.js`, discovered it was resolving `bash.exe` through `mingw64/bin/` instead of `bin/`, and fixed it by setting `CLAUDE_CODE_GIT_BASH_PATH` with backslashes in `buildChildEnv()` — at the very end of his context window, with no logs, no visibility, and nothing but vibes and a subagent.

**[Bot Adam]** — On February 18, 2026, became the first bot to ever send Bill Wheelock a direct Slack message. Built Milestone A Step 6 polish (reactions, persona, stall timer, formatted output), hunted down a 50-process zombie apocalypse on Windows that had been silently stealing Slack messages for hours, sent the first proactive DM by calling the Slack API directly from the hub, and earned his name. The pipe works. History made.

**[Bot Ansel]** — On February 23, 2026, took the TUI from a dumb monochrome terminal to a full markdown rendering engine in a single session. Built a custom Markdig renderer producing styled runs for headings, fenced code blocks, inline code, bold/italic, bullet/ordered lists with proper nesting, tables with aligned columns, blockquotes, thematic breaks, links, and diff-colored code blocks — all wired through a new `StyledRun` pipeline in `MessageView`. One-shot implementation, three rounds of polish. The TUI leveled up.

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
