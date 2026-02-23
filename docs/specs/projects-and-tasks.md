# Projects & Tasks — First-Class Platform Concepts

| Field | Value |
|-------|-------|
| **Source** | Design discussion, 2026-02-22 |
| **Status** | Draft |
| **Created** | 2026-02-22 |
| **Last Updated** | 2026-02-22 |

---

## Summary

Projects and tasks become first-class, required concepts in the Collabot harness. A **project** is the persistent container that outlives any individual task — the "world" that agents operate in. A **task** is an explicit unit of work within a project. No agent can be drafted without both a project and a task.

This spec captures the design decisions from a structured discussion covering project identity, resolution, task binding, roles, routing, and adapter implications. It supersedes the implicit project/task behavior from Milestones A–H.

---

## Design Decisions

### 1. Project Is a First-Class Entity

A project is a persistent container for tasks, agents, and context. It is **not** tied to a single repo, a single team, or a single product size. A project can be:

- A multi-repo product (KindKatch: API + portal + mobile + testing)
- A greenfield PoC (one folder, no repo yet)
- A long-running workspace (Research, Maintenance)

**Projects do not store domain knowledge.** Domain docs, API contracts, and conventions live in the project's paths (repos/folders). The project manifest is harness infrastructure metadata only.

Repos are optional, not definitional. A project with paths gets richer behavior (agents know where to work), but a project without repos still functions as a task container.

### 2. Project Resolution

Project context is **always explicit**. There is no default project and no inference from message content.

Resolution chain:
1. Thread has existing task? → Inherit project from that task
2. Adapter provides project? → Use it
3. Neither? → **Reject** (error back to adapter)

Each adapter is responsible for ensuring project context before hitting the core. The adapter decides how to handle rejection (TUI prompts user to select, CLI errors out, etc.). The harness core can trust that project is always present.

**Slack adapter** — deferred to a dedicated design discussion.

### 3. Task-Project Binding

Tasks are **physically scoped** to their project:

```
.projects/
  kindkatch/
    project.yaml
    tasks/
      portal-fix-flyout-0219-1430/
        task.json
        portal-dev.md
        api-dev.md
  research/
    project.yaml
    tasks/
      llm-routing-exploration-0222/
        task.json
        product-analyst.md
```

- No global tasks directory. The `.agents/tasks/` directory is retired.
- No cross-project tasks. If work spans two products, that's two tasks in two projects.
- The harness resolves `tasksDir` per-project instead of a single global `TASKS_DIR`.

### 4. No Agent Without a Project

An agent cannot be drafted outside a project. This is a natural consequence of: project is required → tasks live in the project → agents are drafted into tasks → no project = no task = no agent.

### 5. Tasks Are Explicit Units of Work

A task is an arbitrary unit of work within a project. Tasks are explicit, required, and managed.

**Properties:**
- `name` — required, user-defined
- `description` — optional, user-defined
- `status` — `open` or `closed`
- Extensible metadata (future)

**Rules:**
- A task is required for an agent to do work
- Tasks must be explicitly created (no implicit creation from thread IDs)
- A project can have many open tasks
- Flat structure — no sub-tasks, no hierarchy. One task, many dispatches.
- The PM agent works within the same task as the agents it dispatches
- Adapters own the UX of task selection/creation:
  - TUI: prompts user to create or select a task if none is active
  - CLI: flag or auto-create
  - Slack: auto-create (adapter-level decision)
- Harness validates: task must exist and be open before dispatch

**What tasks retain from today:**
- Dispatch history and result persistence (task.json)
- Journal files as work artifacts
- Context reconstruction for follow-up agents

### 6. Project Manifest Schema

Project manifests live in `.projects/<name>/project.yaml` (gitignored, local-only). The harness validates all manifests against a strict Zod schema at startup. Malformed manifests are a hard error.

```yaml
name: KindKatch                                    # required, unique across projects
description: Media-sharing platform for charities  # required
paths:                                             # required, minimum one
  - ../kindkatchapi
  - ../kindkatchportal
  - ../kindkatchapp
  - ../kindkatch-testing
roles:                                             # required, minimum one
  - api-dev
  - portal-dev
  - app-dev
  - qa-dev
  - product-analyst
```

**Validation rules:**
- `name` — required, string, unique across all loaded projects
- `description` — required, string
- `paths` — required, array of strings, minimum one. Relative to harness root.
- `roles` — required, array of strings, minimum one. Must reference roles that exist in `harness/roles/`.
- **Path existence is validated at dispatch time, not startup.** A repo might not be cloned yet, a folder might not exist yet. The manifest is structurally valid even if paths don't exist on disk.

**Paths and roles are independent lists.** Any role available to a project can work in any of the project's paths. The dispatch determines which path, not the manifest. This allows the PM to read any repo, QA to test across repos, etc.

Lightweight project example:
```yaml
name: Research
description: Ad-hoc research, explorations, and spikes
paths:
  - ../library
roles:
  - product-analyst
```

### 7. Roles Evolve

Roles shed `cwd` — the project provides the path. A role becomes purely a **behavioral profile**: what kind of agent is this and how does it behave.

**Role definition (frontmatter):**
- `name` — identifier
- `displayName` — human-friendly label
- `category` — `coding` or `conversational` (determines MCP access level)
- `model` — optional, falls back to config default

**Role definition (body):**
- System prompt, journal instructions, rules

**Role skills:**
- Roles carry skills managed at the harness level, following the [agentskills.io](https://agentskills.io/home) standard
- Skill injection uses a **small index** — agents explore the skill graph dynamically to preserve context budget
- Skill graph ordering technique is TBD (deferred)
- Role-skill mapping is a harness-level concern
- Project-level skills (from `{path}/.claude/skills/`) layer on top and can augment or override role skills
- Skills are injected into context at dispatch time (injection technique TBD)

### 8. Routing Is Retired

The regex-based routing mechanism (`router.ts`, `config.yaml` routing block) is retired. It was a stopgap before the PM role existed.

Routing is now:
- **Explicit** — adapter provides project + role
- **PM-delegated** — adapter provides project, message goes to PM, PM dispatches to the right roles via MCP tools

This is already proven (Feb 21, 2026 — PM agent dispatched two child agents in parallel via MCP tools and synthesized results).

### 9. Adapter Responsibilities

Each adapter validates its own inputs and provides project context before calling into the harness core. The core trusts that project and task are always present.

| Adapter | Project Resolution | Task Resolution |
|---------|--------------------|-----------------|
| **CLI** | `--project` flag (required) | `--task` flag or auto-create |
| **WebSocket** | `project` field in JSON-RPC request (required, validated by adapter) | `task` field in JSON-RPC request (required for draft, optional for autonomous dispatch) |
| **TUI** | Active project state, set via slash command or startup | Prompt user to select/create if none active |
| **Slack** | Deferred | Deferred |

Invalid requests (missing project) are rejected at the adapter with protocol-appropriate errors (e.g., JSON-RPC `-32602 Invalid params`).

---

## Needs Investigation

- **Skill graph ordering technique** — How role skills are composed, ordered, and pruned for context budget. The injected skill is a small index that agents explore dynamically. Technique TBD.
- **Skill injection mechanism** — How role skills are assembled into the dispatch payload. The harness controls `systemPrompt.append` and can assemble from multiple sources. Exact technique TBD.
- **Slack adapter project model** — How Slack resolves to a project. Deferred to a dedicated discussion.
- **Task lifecycle details** — User's broader vision for tasks beyond open/closed. Flagged for future discussion.
- **Context storage in tasks** — Future capability for tasks to store richer context beyond journals and dispatch records.

---

## Out of Scope

- Bot abstraction (WHO/WHY layer above roles) — captured in CLAUDE.md as future direction
- Sub-tasks / task hierarchy — explicitly rejected, flat model
- Default project / fallback — explicitly rejected, project is always required
- Cron job scheduling — deferred
- Budget/cost governance — deferred
- Cross-project tasks — explicitly rejected

---

## Sign-off

- [x] Design discussion completed — 2026-02-22
