# Role System v2

## Summary

Redesign the Collabot role system to separate tech-stack expertise (roles) from project domain knowledge (skills). Roles become general-purpose — `ts-dev`, `dotnet-dev`, `react-dev` — and project-specific behavior is loaded via skills at dispatch time. This aligns with the core Collabot formula: **role + (bot) + skills = agent**.

Additionally, replace agent-driven journaling with harness-owned event capture. The harness records every SDK event per task into a structured event log. Journals become a derived view, not an agent responsibility.

## Scope

- Universal entity frontmatter schema (common fields + type-specific fields, Agent Skills aligned)
- Authoring conventions (platform-level rules for entity body content)
- Linking model (how entities reference shared knowledge, growth mechanism)
- Role file format and structure (frontmatter + body)
- Role knowledge base structure (index + linked docs)
- Agent-optimized document conventions for knowledge base files
- Entity tooling requirements (scaffolding, validation, link management)
- Harness system prompt (`harness/prompts/system.md`) — common rules extracted from roles
- Role definitions: `product-analyst`, `dotnet-dev`, `ts-dev`
- Layered prompt assembly in dispatch (system prompt + role prompt)
- Event capture pipeline — harness captures all SDK content events per task
- Event store — JSON-based, per-task, with abstraction layer for future storage backends
- Journal as derived view — rendered from event log, not written by agents
- Remove all journal prompt instructions from roles
- Migration path from current roles (`api-dev`, `portal-dev`, etc.)
- Project manifest updates (role references)

## Affected Components

- `harness/roles/` — role definition files (rewritten) + per-role knowledge base directories
- `harness/prompts/` — new directory for harness system prompt(s)
- `harness/src/roles.ts` — role loading, parsing, Zod schema
- `harness/src/dispatch.ts` — prompt assembly (layered), event capture, remove `{journal_path}` token
- `harness/src/draft.ts` — event capture for draft sessions
- `harness/src/journal.ts` — refactor: journal becomes a renderer over event log, not a direct writer
- `harness/src/types.ts` — event types, updated `RoleDefinition`
- `harness/config.yaml` — model-hint mapping, permission definitions (replaces category definitions)
- `.projects/*/project.yaml` — role references

## Research

Full research at `.agents/research/context-value/`. Synthesis at `.agents/research/context-value/SYNTHESIS.md`.

## Platform Vision

Companion document: [`docs/vision/authoring-and-knowledge.md`](../vision/authoring-and-knowledge.md) — captures the foundational philosophy behind Collabot's approach to knowledge, authoring, and entity growth. This spec implements the first slice of that vision.

## Status

**Signed off** — 2026-02-24

---

## Decisions

- **D1: Roles are tech-stack, not domain.** Roles define general tech expertise (`ts-dev`, `dotnet-dev`). Domain knowledge comes from project-level skills. Formula: role + (bot) + skills = agent.
- **D2: Layered prompt assembly.** The harness builds the agent prompt from layers: Claude Code preset → harness system prompt → role prompt. Skills add project context at dispatch time.
- **D3: One harness system prompt for now.** Single `harness/prompts/system.md` covers universal agent behavior (report if stuck, conventional commits, follow project CLAUDE.md). Category-scoped prompts are a future evolution.
- **D4: Role files become lean.** With common rules in the system prompt and journaling removed entirely, role files only contain tech-stack identity and practices.
- **D5: Harness-owned event capture.** The harness captures every SDK content event (text, thinking, tool_use with full input, tool_result with full content, system events) into a per-task structured event log. Agents don't know journals exist.
- **D6: Journal is a derived view.** The current journal format becomes one possible rendering of the event log. Other views (full transcript, tool-call-only, thinking-only) can be derived from the same data.
- **D7: Event store starts as JSON.** Per-task JSON file in the task directory. Abstraction layer (write interface) so the storage backend can evolve to a lightweight DB later without changing callers.
- **D8: This is the memory foundation.** The event log is the raw material for future short/long-term bot memory and context reconstruction.
- **D9: Role file = index into knowledge base.** The role file provides frontmatter + identity + a lightweight index of available knowledge. Detailed docs live in a per-role subdirectory (e.g., `harness/roles/dotnet-dev/`). Agent loads only the role file at draft time and navigates deeper docs on demand via Read.
- **D10: Knowledge base docs follow agent-optimized conventions.** One concept per file. Front-loaded summary (first paragraph). Heading depth cap of 3 (`#`, `##`, `###`). Consistent templates per doc type. Non-discoverable content only — if the agent can figure it out from code, don't include it.
- **D11: Minimal frontmatter for KB docs.** `title`, `type` (convention | gotcha | pattern | reference), `tags`, `status` (stable | draft | deprecated). No IDs, dates, or chunking hints.
- **D12: Path-first relative links.** Standard markdown links with relative paths. No wiki-links, no resolver infrastructure. The agent's Read tool navigates directly.
- **D13: Universal entity frontmatter.** All Collabot `.md` entities (roles, skills, bots, future types) share a common frontmatter header. Tooling-managed, not hand-edited. Aligns with the [Agent Skills standard](https://agentskills.io/specification) where fields overlap — Collabot fields extend the standard without conflict.
- **D14: Agent Skills standard alignment.** `name` follows the standard's constraints (lowercase `[a-z0-9-]`, 1-64 chars, no start/end/consecutive hyphens). `description` is required (1-1024 chars). `metadata` uses standard naming (no hyphen). Skills additionally support the standard's `license`, `compatibility`, and `allowed-tools` fields.
- **D15: model-hint replaces model.** Always required on roles. Alias enum (`opus-latest`, `sonnet-latest`, `haiku-latest`) resolved by harness config to actual model IDs — roles never contain model IDs directly. Default `sonnet-latest` when templating. Resolution chain: dispatch override > model-hint > config default.
- **D16: Permissions replace category.** Explicit permission array replaces the broad `category` string. Harness enforces permissions at MCP tool registration time. Grouped permissions — e.g., `agent-draft` implies draft/await/kill/list as a bundle. Full permission enum defined during implementation; initial values: `agent-draft`, `projects-list`, `projects-create`.
- **D17: Category removed.** The `category` field is removed from role frontmatter. Timeout and budget mechanics are deferred to a separate design — they may not belong in roles at all.
- **D18: Authoring conventions are platform-level.** Conventions govern how all entity bodies are written — not just roles. They're the foundation that enables entities to grow over time without becoming unmanageable. Conventions are stable; content evolves. See `docs/vision/authoring-and-knowledge.md` for the full philosophy.
- **D19: Universal conventions, type-specific templates.** All entities follow the same authoring conventions (front-loaded summary, non-discoverable content only, link don't embed, consistent structure). Each entity *type* (role, skill, bot) gets its own body template. The template is an output of the conventions, not the other way around.
- **D20: Linking is the growth mechanism.** Entities grow by linking to shared resources, not embedding knowledge. Knowledge lives in a shared library (user-configured, not platform-prescribed). Roles, skills, and other entities reference it via links. Context doesn't bloat — it extends. Today: standard markdown relative paths (D12). Future: managed/SMART linking with tooling that tracks, validates, and maintains references.
- **D21: Tooling is non-negotiable.** Entity authoring at scale requires tooling — scaffolding from templates, frontmatter management, link validation, convention enforcement. Without tooling, conventions can't be enforced and the system degrades to garbage-in garbage-out. Tooling is a deliverable of this spec, not a nice-to-have.
- **D22: Heading depth cap is a guideline, not a rule.** Research suggests capping at 3 levels (`#`, `##`, `###`). Good engineering sense — deep nesting signals a document that should be split. Noted as a guideline to consider, not yet a hard rule. Will adopt or reject based on practical experience with authored entities.
- **D23: Frontmatter is the contract, body is the value.** A role with valid frontmatter and an empty body is a valid, functioning role — it dispatches as a generic agent with the right permissions and model. The body is what makes a role *good*, not what makes it *work*. Body template sections are recommended guidance for well-authored roles, not validation requirements. This supports the growth model: roles start minimal and grow over time.
- **D24: Role body template — three recommended sections.** Identity (who you are, front-loaded), How You Work (workflow and decision-making), Practices (short role-specific rules, link out for detail). Second person voice ("You are..."). These are the minimum starting point — authoring tooling may suggest additional sections (KB index, library links, etc.) but the template itself stays lean.
- **D25: The template is a nudge, not a gate.** Tooling scaffolds these sections, nudges users toward conventions (e.g., "this practice is getting long, extract to a linked doc?"), and tracks links. But the user can always hand-write a role with valid frontmatter and skip the tooling entirely. Collabot still works.
- **D26: No migration — clean cut.** The harness isn't in active dev use yet (this spec is partly why). Current roles (`api-dev`, `portal-dev`, `app-dev`, `qa-dev`, `product-analyst`) are archived for reference during future role authoring. New roles start fresh with the new schema. No backward compatibility layer needed.

---

## Entity Frontmatter Schema

Collabot `.md` entities use a layered frontmatter schema: common entity fields shared by all entity types, plus type-specific fields. The common fields align with the [Agent Skills standard](https://agentskills.io/specification) where they overlap.

Frontmatter is primarily managed by tooling. The harness validates frontmatter at load time.

### Allowable Codes

```
A       # alpha
N       # numeric
H       # hyphen: -
S       # symbols: !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
P       # path-safe symbols: ._-
W       # white space
?       # indicates optional field
(X,Y)   # min/max size
[X..Y]  # cardinality
```

If any of the above violate YAML rules, YAML always wins.

### Common Entity Fields

All `.md` entities share these fields:

| Field | Required | Constraints | Notes |
|-------|----------|-------------|-------|
| `id` | yes | ULID | Tooling-generated. Stable across renames. |
| `version` | yes | Semver | Tooling-managed. |
| `name` | yes | `(1,64)[a-z0-9-]`, no start/end/consecutive hyphens | Aligns with Agent Skills standard. |
| `description` | yes | `(1,1024)[ANSW]` | Aligns with Agent Skills standard. |
| `createdOn` | yes | RFC 3339 (ISO 8601 profile) | Tooling-managed. YAML comment with human-readable date (`MM/DD/YYYY HH:MM:SS AM/PM`). |
| `createdBy` | yes | `(1,32)[ANSW]` | Free-form author string. |
| `updatedOn` | no | RFC 3339 | Set on updates. Tooling-managed. |
| `updatedBy` | no | `(0,32)[ANSW]` | Set on updates. |
| `displayName` | no | `(0,64)[ANSW]` | Human-friendly label. Falls back to `name`. |
| `metadata` | no | Key-value map (string → string) | Aligns with Agent Skills standard. |

### Role-Specific Fields

| Field | Required | Constraints | Notes |
|-------|----------|-------------|-------|
| `model-hint` | yes | Enum: `opus-latest`, `sonnet-latest`, `haiku-latest` | Harness maps to actual model IDs via config. Default `sonnet-latest` when templating. |
| `permissions` | no | Array of `permissions-enum` values `[0..*]` | Harness enforces at MCP tool registration. |

### Skill-Specific Fields (Agent Skills Standard)

| Field | Required | Notes |
|-------|----------|-------|
| `license` | no | License name or reference to bundled license file. |
| `compatibility` | no | `(1,500)` chars. Environment requirements. |
| `allowed-tools` | no | Space-delimited tool list (experimental per standard). |

### Enums

```
models-enum             # harness config maps these to actual model IDs
{
    opus-latest,
    sonnet-latest,
    haiku-latest,
    ### future models
}

permissions-enum        # harness strictly enforces; supersedes model permissions
{
    agent-draft,        # implies draft/await/kill/list agent bundle
    projects-list,
    projects-create,
    ### more permissions (TBD)
}
```

### Technical Notes

- **ULID generation:** Consider [ulid/javascript](https://github.com/ulid/javascript) for `id` field generation. If this library doesn't work with the harness (compatibility, maintenance status, etc.), STOP and ask about alternatives before substituting.
- **Versioning:** Entity authoring tooling manages `version` per [Semantic Versioning](https://semver.org/).
- **Timestamps:** Entity authoring tooling manages `createdOn`/`updatedOn` per [RFC 3339](https://datatracker.ietf.org/doc/html/rfc3339).

### Example: Role Entity

```yaml
---
id: 01HXYZ...
version: 1.0.0
name: product-analyst
description: Coordination, analysis, and multi-agent dispatch for feature work and research tasks.
createdOn: 2026-02-24T15:00:00Z  # 02/24/2026 03:00:00 PM
createdBy: Bill Wheelock
displayName: Product Analyst
model-hint: opus-latest
permissions: [agent-draft, projects-list, projects-create]
---
```

### Example: Skill Entity

```yaml
---
id: 01HABC...
version: 1.0.0
name: sql-formatting
description: Applies SQL formatting conventions for scripts and inline SQL. Use when writing or editing SQL in any capacity.
createdOn: 2026-02-24T15:00:00Z  # 02/24/2026 03:00:00 PM
createdBy: Bill Wheelock
license: Proprietary
compatibility: Requires sqlcmd
---
```

---

## Authoring Conventions

Platform-level rules governing how any Collabot entity body is written. These are stable foundations — content evolves on top of them. Full philosophy at [`docs/vision/authoring-and-knowledge.md`](../vision/authoring-and-knowledge.md).

### Confirmed Conventions

- **Front-loaded summary.** First paragraph of any entity body tells the agent what this entity is and whether to keep reading. This is the most important convention — it enables lazy loading and progressive disclosure.
- **Non-discoverable content only.** If an agent can figure it out by reading code, it doesn't belong in a document. Duplicating discoverable information is neutral at best, harmful at worst (ETH Zurich research: -2% success, +23% cost).
- **Link, don't embed.** If knowledge can live in a linked resource, it should. Entity bodies are an index and identity, not an encyclopedia. Linking is how entities grow without bloating context.
- **Consistent structure per entity type.** Each entity type (role, skill, bot) has a body template. All instances follow the template. Agents learn the shape and navigate faster.

### Guidelines Under Consideration

- **Heading depth cap of 3** (`#`, `##`, `###` max). Research-backed, not yet confirmed as a hard rule (D22).

### Why Conventions Matter

- **Enable growth.** Entities start minimal and grow over time by linking to new knowledge. Conventions prevent growth from becoming chaos.
- **Enable reorganization.** Because content follows predictable rules, tooling can restructure, re-link, split, merge, and compress documents without changing what they mean. Convention is the contract between author and tooling.
- **Enable agent authoring.** Future authoring is a combination of user intentions + agent composition + document tooling. Conventions make agent authoring possible — without them, agents produce inconsistent, bloated documents.
- **Enable scale.** Hand authoring is fine for 5 roles and 10 KB docs. It's untenable at 50 roles, 200 KB docs, and a living library. Conventions + tooling is the only path that scales.

---

## Role Body Template

The recommended starting structure for a well-authored role. These sections are guidance, not validation requirements (D23, D25). Authoring tooling scaffolds these and may suggest additional sections over time.

Second person voice throughout ("You are...", "You do...").

### Sections

**Identity** — First paragraph. Who you are, what your focus is. Front-loaded per authoring conventions — the agent reads this first to understand its role. 2-3 sentences.

**How You Work** — Your workflow and decision-making approach. This is where role types diverge: a coordinator describes its triage and dispatch flow; a coding role describes its build/test cycle. Can include sub-sections if the workflow has distinct modes (e.g., simple questions vs. feature work).

**Practices** — Short, direct rules specific to this role. Each practice should be 1-2 lines. If a practice needs more explanation, link to an external document rather than embedding the detail here (D20). Examples: "Get user approval before dispatching for feature work." "Run tests before reporting completion."

### Minimal Example

```markdown
You are a TypeScript developer. You build, test, and maintain TypeScript applications.

## How You Work

1. Read the task spec or prompt carefully
2. Check for relevant documentation in the project
3. Implement the changes
4. Run tests and verify your work
5. Report results with a summary of changes

## Practices

- Follow the project's existing code style and patterns
- If you get stuck or are unsure, report back rather than guessing
```

### Growth Example

The same role after several weeks of use, with linked knowledge:

```markdown
You are a TypeScript developer. You build, test, and maintain TypeScript applications across multiple projects.

## How You Work

1. Read the task spec or prompt carefully
2. Check for relevant documentation in the project
3. Review linked conventions and patterns before implementing
4. Implement the changes
5. Run tests and verify your work
6. Report results with a summary of changes

## Practices

- Follow the project's existing code style and patterns
- If you get stuck or are unsure, report back rather than guessing
- See [TypeScript conventions](../library/ts-conventions.md) for shared coding standards
- See [error handling patterns](../library/error-handling.md) for the standard approach
- When using Zod, see [Zod patterns](../library/zod-patterns.md) for validated conventions
```

---

## Linking Model

Links are how entities gain access to new knowledge without bloating their own context. The linking model is also the substrate for future memory management — same conventions, same tooling, same infrastructure.

### What the Platform Provides

- **Link management tooling** — creates, validates, and maintains references between entities and documents
- **Link-aware operations** — when documents move, split, or merge, links update automatically
- **Validation** — broken links detected and flagged (hooks, CI, or cron)

### What the Platform Does NOT Prescribe

- Where linked documents live (any path the user configures)
- How the user organizes their knowledge topology (library, KB, research lab — those are user concepts)
- Any fixed directory structure for shared resources beyond what the harness itself needs

### Current State (Minimal Viable)

Standard markdown relative paths (D12). Works for small-scale, within-project linking. The agent's Read tool navigates directly.

### Future State (SMART Linking)

Managed linking where tooling tracks references, validates them, and can reorganize targets without breaking references. Connects to future memory management: memories are documents, documents are linked, same infrastructure throughout.

### The "Library" Concept

Collabot does not ship with or prescribe a library. A library is a user-configured organizational pattern — shared documents (conventions, research, patterns) that multiple entities link to. It could live anywhere: in the harness project, in a separate project repo, in a dedicated knowledge project. The platform provides the infrastructure to manage links into it; the user decides the topology.

---

## Needs Investigation

*(All resolved. NI1-NI2 via research → D9-D12. NI3 via discussion → D23-D25. NI4-NI5 moved to Implementation Notes — they're code changes, not design questions.)*

---

## Implementation Notes

Change inventory for implementing this spec. Not design decisions — these are mechanical changes derived from the decisions above.

### Harness Code Changes

**`harness/src/roles.ts`** — Zod schema rework
- Current: `name`, `displayName`, `category`, `model?`
- New: full entity frontmatter (id, version, name, description, createdOn/By, etc.) + role-specific fields (model-hint, permissions)
- Remove `category` from schema
- Replace `model` with `model-hint` (required, enum validation)
- Add `permissions` (optional array, enum validation)
- Parsing: `parseFrontmatter()` stays, schema changes

**`harness/src/types.ts`** — `RoleDefinition` type
- Current: `{ name, displayName, category, model?, prompt }`
- New: match updated Zod schema output. Drop `category`, add `modelHint`, `permissions`, `description`, `id`, `version`, audit fields

**`harness/src/dispatch.ts`** — prompt assembly + model resolution
- Model resolution: `options.model > role.modelHint > config.models.default` (rename from `role.model`)
- Add model-hint → model ID resolution via config mapping
- Remove `{journal_path}` token replacement (D5 — event capture replaces journaling)
- Remove category-driven stall timeout lookup (`config.categories[role.category]`) — timeout strategy deferred (D17)
- Journal creation/append calls throughout — to be replaced by event capture pipeline

**`harness/src/draft.ts`** — same changes as dispatch
- Model resolution: `role.model` → model-hint resolution (line 252)
- Category-driven stall timeout (lines 227-228) — same removal as dispatch
- Prompt injection: `role.prompt` stays (line 279), but system prompt layering (D2) may add a harness system prompt layer

**`harness/src/core.ts`** — MCP access control
- Current: `config.mcp.fullAccessCategories.includes(role.category)` (line 227)
- New: check `role.permissions` for `agent-draft` (or relevant permission) instead of category membership

**`harness/src/ws-methods.ts`** — MCP access control (draft path)
- Same pattern as core.ts: `fullAccessCategories.includes(draftRole.category)` → permission check (line 134)

**`harness/src/config.ts`** — config schema
- Add `models.aliases` section (maps `opus-latest` → `claude-opus-4-6`, etc.)
- `mcp.fullAccessCategories` → replaced by permission-based access (may remove entirely or keep as fallback during migration)
- `categories` block: evaluate whether to keep (for timeout defaults during migration) or remove

**`harness/config.yaml`** — config file
- Add model alias mapping
- Evolve or remove `categories` block
- Evolve or remove `mcp.fullAccessCategories`

**`harness/src/index.ts`** — startup validation
- Current: validates role categories against config categories (lines 59-62)
- New: validate permissions against known enum, validate model-hint against known aliases

### Test Changes

- `harness/src/roles.test.ts` — update frontmatter fixtures (`category` → `permissions`, `model` → `model-hint`)
- `harness/src/core.test.ts` — update mock roles, config fixtures
- `harness/src/integration.test.ts` — update MCP access control tests (category → permissions)
- `harness/src/config.test.ts` — update MCP config tests
- `harness/src/ws-methods.test.ts` — update mock role fixtures
- `harness/src/ws-integration.test.ts` — update mock role fixtures
- `harness/src/mcp-smoke.test.ts` — update if MCP server creation changes

### Entity Tooling (New)

- Scaffolding: generate new entity files from templates with ULID, timestamps, defaults
- Validation: CLI or harness command to validate entity frontmatter against schema
- Authoring support: tooling that nudges toward conventions (extract long practices to linked docs, suggest sections)
- Link management: basic link validation (detect broken relative paths). SMART linking is future.

### Journal → Event Capture Migration

- Replace `journal.ts` calls in `dispatch.ts` with event capture writes
- `createJournal()`, `appendJournal()`, `updateJournalStatus()` → event store writes
- Journal becomes a derived view rendered from event log (D6)
- `{journal_path}` token in role prompts removed — agents no longer know journals exist (D5)

---

## Out of Scope

- **Timeout and budget mechanics** — with `category` removed (D17), timeout/budget behavior needs a new home. May not belong in role frontmatter at all. Separate design.
- **Agent-writable memory tool** — MCP tool for agents to intentionally record decisions, rationale, blockers. Distinct from automatic harness capture. Foundation for bot short/long-term memory. Not needed until the bot abstraction layer lands.
- **Pre-compaction memory flush** — OpenClaw pattern: silent agentic turn to externalize state before SDK compaction. Worth a spike once event capture is in place. Not this spec.
- **Attention recitation** — Manus todo.md pattern: re-injecting task context into recent attention for long-running agents. Near-term evolution, not this spec.
- **Hybrid search / temporal decay** — scaling knowledge base retrieval beyond Read-tool navigation. Future, when knowledge bases grow large enough to need it.

---

## Discussion Agenda

Topics 1-6 and topic 7 frontmatter complete. Agenda restructured to reflect dependency chain discovered during topic 7 discussion.

### Completed

1. ~~Current state: how the harness uses roles~~ ✓
2. ~~Boilerplate extraction~~ ✓ → D2, D3, D4
3. ~~Tooling opportunities~~ ✓ → D5, D6, D7, D8
4. ~~Role file format~~ ✓ → frontmatter locked, body = identity + index
5. ~~Role knowledge base structure~~ ✓ → D9, D10, D11, D12 (resolved via research)
6. ~~Future state vision~~ ✓ — bot layer slots above roles, doesn't change them. Bots will be a plugin (optional). Current design (lean roles, KB directories, event capture) holds when bots arrive.
7a. ~~Entity frontmatter schema~~ ✓ → D13, D14, D15, D16, D17
7b-1. ~~Authoring conventions~~ ✓ → D18, D19, D20, D21, D22. Vision doc created at `docs/vision/authoring-and-knowledge.md`.
7b-2. ~~Role body template~~ ✓ → D23, D24, D25. Three recommended sections (Identity, How You Work, Practices). Second person voice. Minimal + growth examples in spec.

8. ~~Migration path~~ ✓ → D26. No migration needed — harness not in active dev use. Current roles archived, clean cut.
9. Role content — `product-analyst`, `dotnet-dev`, `ts-dev` (deferred until infra is built and tested against a minimal role)

*7c (harness injection) and 7d (entity tooling) collapsed into "Implementation Notes" section — they're code change inventories, not design topics.*

---

## Session Handoff Notes

### Session 3 (2026-02-24) — Frontmatter Schema + Gap Analysis

**What happened:**

Started at topic 7 (PA role review) with intent to discuss PA frontmatter (should it default to Opus?). User redirected to a broader frontmatter discussion — not just "should PA get Opus?" but "what is our frontmatter schema, period?" This was the right call: frontmatter requires code/tool changes and is slow to iterate, unlike prompt body text which can evolve freely.

**Key conversation arc:**

1. Started with model question → user proposed full frontmatter redesign with field specs, allowable codes, enums
2. Discussed `model` → became `model-hint` (advisory, alias enum, harness resolves to actual model IDs). Always required, default `sonnet-latest`. Cost-savings safety net — don't burn Opus tokens on mundane work.
3. Discussed `category` → became `permissions` array. Category was too blunt (3 values driving timeouts, MCP access, and implicit behavior). Permissions are explicit, grouped (e.g., `agent-draft` implies draft/await/kill/list bundle), harness-enforced at MCP tool registration.
4. User proposed `id` (ULID), `version` (semver), audit fields (`createdOn/By`, `updatedOn/By`). Agent pushed back on timing — user clarified this is the universal entity frontmatter, not just roles. Reaching a stage gate to lock down concepts. Tooling makes these fields trivial.
5. Agent raised concern about audit fields duplicating git history. User countered: entities must be portable (not locked to git history), Collabot will be handed off to other teams, authorship has value. All frontmatter is tooling-managed, not hand-edited.
6. User flagged Agent Skills standard (agentskills.io) — our frontmatter must not conflict. Agent fetched the spec. Found 3 alignment issues: `name` constraints (we adopted lowercase), `metadata` naming (dropped the hyphen), `description` (made required). Our fields are a clean superset.
7. About to jump into PA role body content when user identified the dependency chain problem: we have no role body template (the HOW). Writing PA content (the WHAT) without it means we'd rewrite later. Also identified two other gaps: harness injection is stale, entity tooling doesn't exist yet.

**Decisions recorded:** D13 (universal entity frontmatter), D14 (Agent Skills alignment), D15 (model-hint), D16 (permissions), D17 (category removed).

**Gaps identified:** NI3 (role body template), NI4 (harness injection rework), NI5 (entity tooling).

**Agenda restructured:** Original topics 7-10 broken into dependency chain (7b template → 7c injection → 7d tooling → 8-10 role content → 11 migration).

**Session 3 continued — Authoring Conventions + Vision Doc**

After the gap analysis, the conversation evolved further. User identified that 7b (role body template) was actually two things: the HOW (authoring conventions and structural framework) and the WHAT (individual role content). The HOW had never been formalized despite being discussed extensively during research.

Key insights from this part of the conversation:

1. **Authoring conventions are platform-level, not role-level.** They govern how ALL entity bodies are written, not just roles. The template is an output of conventions, not the starting point.

2. **Linking is the growth mechanism.** Entities start minimal and grow by linking to shared resources. A TS dev role starts as 20 lines, then links to a shared TS convention doc, then gains access to research findings via more links. The role file itself barely changes while the agent's accessible knowledge grows 10x.

3. **Conventions enable reorganization without modifying intent.** This is load-bearing for future memory management. If content follows predictable rules, tooling can restructure it without changing what it means.

4. **Tooling is non-negotiable.** Without tooling to enforce conventions, manage links, scaffold entities, and validate structure, the system degrades. This isn't future — it's a deliverable of this spec.

5. **Platform vs. configuration distinction.** Collabot ships with infrastructure (conventions, templates, linking tooling, management). It does NOT ship with content, topology, or organizational patterns. The "library" is a user concept, not a platform feature. Collabot provides the tools to manage a library; the user decides where it lives and how it's organized.

6. **The OS-for-bots analogy.** Collabot is an operating system for agents. Filesystem = entity documents. File format = frontmatter + conventions. Memory management = context window + event capture + future memory system. Compression = progressive disclosure + lazy loading + linking. Defragmentation = tooling that reorganizes knowledge.

7. **Heading depth cap of 3 downgraded from rule to guideline.** Research-backed but user isn't convinced it's a day-1 rule. Noted for consideration, not enforcement.

**Decisions recorded:** D18 (conventions are platform-level), D19 (universal conventions, type-specific templates), D20 (linking is growth mechanism), D21 (tooling non-negotiable), D22 (heading depth cap is guideline).

**Vision document created:** `docs/vision/authoring-and-knowledge.md` — captures the full philosophy (platform vs. config, OS-for-bots analogy, growth model, authoring conventions, linking model). Referenced from the spec. Designed to outlive this spec and inform future specs.

**Session 3 continued — Role Body Template + Implementation Notes**

Role body template designed (D23-D25): three recommended sections (Identity, How You Work, Practices), second person voice, minimal + growth examples. Key insight from user: frontmatter is the contract, body is the value (D23). A role with valid frontmatter and empty body is a valid role — it just dispatches as a generic agent. Template is a nudge, not a gate (D25). Authoring tooling can suggest additional sections (KB index, library links) beyond the template.

7c (harness injection audit) and 7d (entity tooling) reframed as implementation planning, not design discussion. Collapsed into an "Implementation Notes" section with full code change inventory across all affected files. User's approach: build the infra first, test against a minimal role, then write real role content.

Role content (PA, dotnet-dev, ts-dev) deferred until infra is built and validated.

**Decisions recorded:** D23 (frontmatter is contract, body is value), D24 (three recommended sections), D25 (template is a nudge).

### Resuming At

**Topic 8: Migration path.** Design discussion — sequencing, backward compatibility, rollout strategy. The Implementation Notes section provides the full change inventory; this topic is about the order of operations and how to get from current state to new state without breaking the running harness.

**PA-specific notes (for when role content is written):**

What moves to `harness/prompts/system.md`:
- MCP tool documentation ("Your Tools" section) — universal for roles with `agent-draft` permission, not PA-specific
- Common rules: "ask don't guess", "reference project CLAUDE.md"
- Dispatch guidelines: "self-contained prompts", "parallel vs sequential"

What stays in the PA role file:
- Identity: needs to be richer — capturing intent, breaking down ambiguity, judgment calls about scope/priority
- Two-track workflow (simple questions vs feature work) — good structure, keep it
- Feature work flow should reference specs (per CLAUDE.md workflow)
- PA-specific rule: "get user approval before dispatching for feature work"

What needs updating:
- Hardcoded role list (`api-dev`, `portal-dev`, `app-dev`, `qa-dev`) is stale — needs to reflect new role names or be dynamic (use MCP tools to discover available roles)

### Session 2 (2026-02-24) — Topics 6-7a

Completed topic 6 (future state vision) and started topic 7. Initial PA role assessment done — identified what moves to system prompt vs stays in role file. User redirected frontmatter discussion to broader schema design (became session 3 content).

### Session 1 (prior) — Topics 1-5 + Research

Topics 1-5 completed (D1-D12). Extensive research conducted at `.agents/research/context-value/` covering academic papers (ICSE, ETH Zurich), production systems (Manus, OpenClaw, OpenHands), and document optimization. Research resolved NI1 and NI2.

### Key Files

| File | Purpose |
|------|---------|
| `docs/specs/role-system-v2.md` | This spec |
| `docs/vision/authoring-and-knowledge.md` | Platform vision — authoring philosophy, growth model, OS-for-bots, linking model |
| `.agents/research/context-value/SYNTHESIS.md` | Research synthesis — context value, doc conventions, production system patterns |
| `harness/roles/product-analyst.md` | Current PA role (to be rewritten) |
| `harness/roles/*.md` | All current roles (api-dev, portal-dev, app-dev, qa-dev, product-analyst) |
| `harness/src/roles.ts` | Role loading, Zod schema, frontmatter parsing (needs rework per NI4) |
| `harness/src/dispatch.ts` | Prompt assembly, model resolution, MCP registration (needs rework per NI4) |
| `harness/src/types.ts` | `RoleDefinition` type (needs update) |
| `harness/config.yaml` | Current: categories, model default. Future: model-hint mapping, permissions |
