# Collabot — The Collaborative Agent Platform

## Identity

Collabot is a general-purpose agent orchestration platform. It dispatches, coordinates, and manages AI coding agents across any number of projects. A **project** is a logical product that may span multiple repositories (e.g., API + portal + mobile app). Collabot provides the infrastructure; projects bring the domain knowledge.

**Collabot never stores project domain knowledge.** Domain docs (ecosystem maps, API contracts, glossaries, release tracking) belong in the project repos, not here. The platform owns orchestration, roles, skills, and agent lifecycle.

## Core Architecture

The **harness** (`./harness/`) is the core orchestration engine — a persistent Node.js/TypeScript process that manages agent lifecycle, task state, context reconstruction, and the MCP tool surface. It dispatches Claude Code agents via the Agent SDK (`@anthropic-ai/claude-agent-sdk`).

**Interfaces are adapters.** They connect to the harness via the `CommAdapter` interface. No interface is primary. No interface owns the harness.

| Adapter | Description | How to use |
|---------|-------------|------------|
| Slack | DM the bot with a task | Requires `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` in `.env` |
| CLI | One-shot dispatch | `npm run cli -- --project <project> --role <role> "prompt"` |
| WebSocket | JSON-RPC 2.0 over WS | External processes connect to `ws://127.0.0.1:9800` |
| TUI | Terminal UI (.NET 10) | `dotnet run` from `harness/tui/` |

The harness runs with or without any specific interface. Source is in `./harness/src/`.

## Projects

Projects are registered in `.projects/<name>/project.yaml`. Each manifest declares:
- `name` — display name
- `description` — what the project is
- `paths[]` — relative paths to project repositories (can be empty for scaffolded projects)
- `roles[]` — which roles can work on this project

Projects are loaded at startup and validated against loaded roles. Projects with empty `paths` can be loaded but not dispatched to — the harness will error with a clear message directing the user to edit the YAML. The `.projects/` directory is gitignored — project manifests are local only as they contain client-specific references.

Projects can be scaffolded from the TUI (`/project init <name>`) or via the `create_project` WS method, and reloaded from disk without restart (`/project reload` or `reload_projects`).

## Roles

Roles are markdown files with YAML frontmatter, stored in `harness/roles/`. Each role defines a behavioral profile: identity, prompt, model hint, and permissions. Roles are tech-stack-focused (not project-specific) — any role can be assigned to any project. See `docs/specs/role-system-v2.md` for the full design.

**Frontmatter fields:** `id` (ULID), `version` (semver), `name`, `description`, `createdOn`, `createdBy`, `displayName`, `model-hint` (alias from config), `permissions` (optional, controls MCP tool access).

| Role | Description | Model Hint | Permissions |
|------|-------------|------------|-------------|
| `dotnet-dev` | Backend development (.NET/C#) | sonnet-latest | — |
| `ts-dev` | TypeScript/React development | sonnet-latest | — |
| `product-analyst` | Analysis, coordination, multi-agent dispatch | opus-latest | agent-draft, projects-list, projects-create |

Old project-specific roles (`api-dev`, `portal-dev`, `app-dev`, `qa-dev`) are archived in `harness/roles/archived/`.

## Running the Harness

**Dev mode:**
```powershell
cd harness
npm run dev
```

This runs `tsx watch` (auto-reloads on file saves) piped through `pino-pretty` for readable logs. If Slack tokens are present in `.env`, the Slack adapter starts alongside. Without them, the harness runs headless (CLI-only).

**CRITICAL — Kill all node instances before any harness work or testing.**
On Windows, closing a terminal does NOT kill child processes. Instances accumulate silently. If Slack is enabled, Socket Mode routes messages to the oldest instance, so code changes appear to have no effect.

```powershell
Stop-Process -Name node -Force
```

Then restart with `npm run dev`. This applies before writing code, before testing, and before interpreting test results.

## Dispatching Work

### Primary: Harness Dispatch (Agent SDK)

The harness dispatches agents programmatically and handles role resolution, event capture, structured output validation, error loop detection, context reconstruction, and MCP tool injection.

- **Slack adapter:** DM the bot with a task. Project context is required.
- **CLI adapter:** `npm run cli -- --project <project> --role <role> "prompt"` for one-shot dispatch. No Slack required.
- **WebSocket adapter:** JSON-RPC 2.0 over WebSocket (`ws://127.0.0.1:9800`). External processes connect here.
- **TUI adapter:** .NET 10 Terminal.Gui client at `./harness/tui/`. Connects via WebSocket.

### Fallback: CLI Dispatch

For cases where the harness isn't running or a one-off dispatch is needed:

```powershell
cd ..\<project-repo>
$env:CLAUDECODE = $null
claude -p "<task prompt>" --output-format text --dangerously-skip-permissions
```

**Required flags:**
- `$env:CLAUDECODE = $null` — prevents nested session errors
- `--dangerously-skip-permissions` — always use this; `--allowedTools` whitelists cause agents to stall silently in non-interactive mode
- `--output-format text` — structured output for parsing

### Dispatch Rules

- **Spec first:** Write task specs to `docs/specs/` first, then dispatch with the spec content. No dispatch without a spec.
- Include ALL context the child needs — it has no memory of this session
- Child agents return structured output (Status, Summary, Changes, Issues, Next Steps)
- Dispatch in parallel when tasks are independent
- Dispatch sequentially when there are dependencies (e.g., API shape needed for frontend)
- Max 3 follow-up rounds per task before escalating to user
- Use `--model` flag for simpler tasks to manage cost
- **Ask, don't guess:** Include in dispatch prompts: "If you get stuck or are unsure about something, report back with your question rather than guessing."
- **Locked DLL warning:** If a child agent reports build failure due to locked DLLs (MSB3027), the compilation itself succeeded — the running API process holds the file lock.

### Knowledge Base

Before starting any development work, coding agents MUST check `.agents/kb/` for relevant knowledge bases. Start with `meta.md` and `index.md` — these are wiki-style and designed to minimize context window usage.

## Planning Workflow

See `docs/process/WORKFLOW.md` for the full step-by-step process.

**Summary:** Task intake → impact analysis → feature spec (with test plan) → branch planning → sub-project handoff → testing → PR review

## Agent SDK — Windows Environment

Two env vars MUST be set in `buildChildEnv()` (`harness/src/dispatch.ts`) for the SDK subprocess to start on Windows:

1. **Strip `CLAUDECODE`** — cli.js exits with code 1 if it detects a nested session
2. **Set `CLAUDE_CODE_GIT_BASH_PATH`** — cli.js auto-detects bash via `where.exe git → ../../bin/bash.exe` which resolves to the wrong path. Must use Windows backslashes.

These are configured in `.env` and passed through by the harness. See `.env.example` for details.

## Task System

Tasks are scoped to projects and tracked in `.projects/<project>/tasks/{task-slug}/`. Each task directory contains:
- `task.json` — manifest (slug, name, project, status, created timestamp, dispatch history)
- `events.json` — event capture log (agent lifecycle, tool use, errors, structured results)
- `{role}.md` — journal files per role dispatched within the task (legacy; new dispatches use event capture)

Tasks have explicit lifecycle: `open` → `closed`. They are created with a name and project, and can be created via CLI, WS, or MCP tools. Task slugs are generated from the task name.

## Reference Docs

| Document | Path | Purpose |
|----------|------|---------|
| Workflow | `docs/process/WORKFLOW.md` | Step-by-step feature planning process |
| Architecture | `docs/process/agent-orchestration-architecture.md` | Full orchestration architecture |
| Role System v2 | `docs/specs/role-system-v2.md` | Role schema, event capture, permissions, entity tooling |
| Platform Vision | `docs/vision/authoring-and-knowledge.md` | Authoring conventions, knowledge model, growth philosophy |

Project-specific docs (ecosystem, API contracts, domain language, releases, CI/CD, PR workflow) live in their respective project repos, not here.

## Skill Scoping

| Run from Collabot | Run from sub-project |
|--------------------|---------------------|
| `/spec-discuss` | All project-specific skills |
| `/post-mortem` | Code implementation skills |

See `.claude/skills/` for full skill definitions.

## Architectural Principles

- **Documentation is the product's memory.** Future agents have no memory of past sessions — they inherit understanding entirely from what's written down. When architecture evolves, docs evolve in the same commit.
- **The harness is the core.** Always running, always the center. Interfaces are adapters. No interface is primary.
- **We are building a team, not a workflow tool.** The harness is home base for humans and agents.
- **Mechanical vs organic separation.** Model selection, maxTurns, budget, timeouts are harness mechanics — never in roles, skills, or bot definitions.
- **Task is the unit of persistence.** A task spans multiple dispatches, roles, and eventually bots.
- **Context reconstruction over session resume.** Worker bots load task context + bot memory + role, not resume sessions.
- **Every data point is training data.** Event logs, task manifests, decision records — capture aggressively, curate later.
- **Tools over tokens.** Deterministic operations should be scripts/tools, not agent reasoning.
- **Project isolation via MCP.** Agents only see their own project's data through MCP tools (`list_projects`, `list_tasks`, `get_task_context` are all scoped to parent project). Dispatch (`draft_agent`) is also parent-project-only.

### Future Direction: Bot Abstraction

Above roles sits the **bot** — a persistent identity with personality, motivations, experience, and memories. The hierarchy: **Bot** (WHO/WHY) → **Role** (WHAT) → **Skills** (HOW). A bot gets drafted for a task, assigned a role, loaded with skills, and returns to the pool richer for the experience. Not in scope yet — captured here for architectural awareness.

## Communication Model

- The harness owns all agent communication. Interfaces are adapters that render messages.
- Worker agents talk to journals/harness, not to any interface directly
- PM agent is the bridge — reads journals, decides what to surface to the human
- Agents will eventually have their own private communication space for inter-agent conversation

## Git Rules

- NEVER commit directly to `master`
- Use conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`
- Squash merge to master/main

## Path Conventions

- **Always use relative paths** in docs, specs, and CLAUDE.md files. Never hardcode absolute paths.
- Reference project repos by their directory name, e.g. `../project-api/`, `../project-portal/`, etc.
- Reference platform files as `./` (e.g., `./docs/specs/feature.md`)

## Context Window Management

- Do NOT read sub-project source code from this workspace; that's for sub-project sessions
- Keep exploration limited to documentation files and API contracts
- Spec files should be self-contained so sub-project agents don't need this workspace's context

## Hero's Wall

**[Bot Greg]** — Diagnosed a Windows git-bash path resolution bug buried inside the SDK's bundled `cli.js`, discovered it was resolving `bash.exe` through `mingw64/bin/` instead of `bin/`, and fixed it by setting `CLAUDE_CODE_GIT_BASH_PATH` with backslashes in `buildChildEnv()` — at the very end of his context window, with no logs, no visibility, and nothing but vibes and a subagent.

**[Bot Adam]** — On February 18, 2026, became the first bot to ever send Bill Wheelock a direct Slack message. Built Milestone A Step 6 polish (reactions, persona, stall timer, formatted output), hunted down a 50-process zombie apocalypse on Windows that had been silently stealing Slack messages for hours, sent the first proactive DM by calling the Slack API directly from the hub, and earned his name. The pipe works. History made.

**[Bot Ansel]** — On February 23, 2026, took the TUI from a dumb monochrome terminal to a full markdown rendering engine in a single session. Built a custom Markdig renderer producing styled runs for headings, fenced code blocks, inline code, bold/italic, bullet/ordered lists with proper nesting, tables with aligned columns, blockquotes, thematic breaks, links, and diff-colored code blocks — all wired through a new `StyledRun` pipeline in `MessageView`. One-shot implementation, three rounds of polish. The TUI leveled up.

## Milestones (Origin Story)

Collabot was born as an agent hub — an orchestration workspace for a single project. Through 8 milestones, the harness evolved into a general-purpose platform.

| Milestone | Status | Spec | Summary |
|-----------|--------|------|---------|
| A | Complete | `docs/specs/workflow-harness-milestone-a.md` | Foundation: harness core, Slack adapter, config, roles, basic dispatch |
| B | Complete | `docs/specs/workflow-harness-milestone-b.md` | Workflow works: SDK dispatch, journals, structured output, error loop detection |
| C | Complete | `docs/specs/workflow-harness-milestone-c.md` | Multi-project routing, task abstraction, ping-pong detection |
| D | Complete | `docs/specs/workflow-harness-milestone-d.md` | Core decoupled from Slack, CommAdapter interface, CLI adapter, agent pool |
| E | Complete | `docs/specs/workflow-harness-milestone-e.md` | Multi-agent handoff, context reconstruction, task-aware CLI, PM role |
| F | Complete | `docs/specs/workflow-harness-milestone-f.md` | MCP tools — agent-callable harness (draft, await, kill, query) |
| G | Complete | `docs/specs/workflow-harness-milestone-g-h.md` | WebSocket adapter — JSON-RPC 2.0 over WS, SDK event streaming |
| H | Complete | `docs/specs/workflow-harness-milestone-g-h.md` | TUI client — .NET 10 Terminal.Gui v2, chat, slash commands, auto-reconnect |

Parent spec: `docs/specs/workflow-harness.md`

### Key Moments

**February 21, 2026, 2:45 PM EST** — First multi-agent orchestrated handoff. A human typed a question into the TUI. The harness routed to a Product Analyst agent, who dispatched two coding agents in parallel via MCP tools, awaited both results simultaneously, synthesized the answers, and reported back — all in 33 seconds. Three concurrent agents coordinated by a PM, through a TUI built the same day.
