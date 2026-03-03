# Authoring and Knowledge — Platform Vision

## What This Document Is

This captures the foundational philosophy behind how Collabot manages knowledge, documents, and entity authoring. It's the mental model that informs concrete specs and will outlive any single one. Future specs should reference this document rather than re-deriving these principles.

**Origin:** Emerged from the Role System v2 spec-discuss sessions (Feb 2026), where the frontmatter schema discussion evolved into a broader conversation about what Collabot actually is as a platform, and how it should think about knowledge.

---

## The Core Distinction: Platform vs. Configuration

Collabot is a collaborative agent platform. It ships with infrastructure, not content.

**The platform provides:**
- Entity frontmatter schema (validated by harness at load time)
- Authoring conventions (rules for how entities are written)
- Entity type templates (role, skill, bot body structure)
- Linking infrastructure (tooling that manages references between entities and documents)
- Management infrastructure (hooks, crons, synthesis agents)
- Dispatch, coordination, event capture, context reconstruction

**The platform does NOT prescribe:**
- Where your documents live (disk, network, any project repo)
- How you organize your knowledge (library, KB, research lab — those are user concepts)
- What projects, roles, skills, or content you configure
- Directory topology beyond what the harness itself needs to function

A fresh Collabot installation is essentially empty. Maybe a default role, maybe a starter project. Everything else — the bots, the roles, the knowledge bases, the conventions — is built up by the team using it. Collabot is home base. The team makes it their own.

---

## Platform Principles

These are the governing beliefs behind how Collabot works. They emerged from building and using the platform, not from theory. Concrete specs and design decisions should trace back to these.

### Curated context over large context

A bot with a reduced context window, important conventions, precise instructions, and small granular tasks in short sessions is far more valuable than a bot with a million-token context window and just vibes to go on. More context is not better context — the same way more storage is not better schema design. Collabot's job is to assemble the *right* context, not the *most* context.

### Phase sizing is context window budget

Work phases aren't a formal SDLC ceremony — they're sized to what fits in a single bot's context window. A phase is a granular, isolated, logical task that one bot can hold in its head and execute completely. This is a novel constraint that traditional process frameworks don't account for. Metrics and memory will refine the sizing over time, but the constraint is structural, not arbitrary.

### Iterative formalization

Start loose, use the system, let the vision become self-evident, then codify. Roles followed this pattern: started as simple prompt files, accumulated real usage, revealed their true requirements, and got a formal spec (Role System v2) only when the shape was clear. Bots followed the same arc — from ad-hoc Slack identities to a full session pattern with placement, queuing, and prompt assembly. Designing too early means guessing; designing after usage means knowing. The loose version is not debt — it's research.

---

## The Home Analogy

Collabot is home base for a team of bots. Each bot has a name, a role, projects they work on, and a personality. They come and go — dispatched for tasks, returning with results — but the harness is always there, keeping state, capturing events, and routing communication.

The platform provides the infrastructure for this home:

| Concept | What Collabot Provides |
|---------|----------------------|
| Team roster | Bot definitions — identity, personality, role assignment |
| Job descriptions | Roles — behavioral profiles, model preferences, permissions |
| Skillsets | Skills — injected capabilities, conventions, domain knowledge |
| Communication | Adapters — Slack, CLI, WebSocket, TUI |
| Memory | Event capture, context reconstruction, future persistent memory |
| Projects | Task scoping, dispatch routing, knowledge boundaries |

The key insight: Collabot doesn't tell you who to hire or how to organize your team. It gives you the infrastructure to build and manage one.

---

## The Growth Model

Entities start minimal and grow over time. This is not a bug or a "we'll fill it in later" — it's the design.

**Example: A TypeScript coding role's lifecycle**

1. **Day 1:** Basic identity. "You are a TypeScript developer." A few guidelines. Maybe 20 lines.
2. **Week 2:** The team adopts a TS coding convention doc. The role links to it (doesn't embed it). The convention lives in a shared library, usable by other roles too.
3. **Month 1:** A bot researches a specialized TS library for a project. The research gets synthesized and added to the library. The role gains access via a link. Zero changes to the role file itself.
4. **Month 3:** Multiple gotcha docs, pattern docs, and convention docs have accumulated. The tooling reorganizes them, updates links, compresses outdated content. The role's knowledge has grown 10x, but the role file is still 30 lines.

**What makes this work:**
- **Linking, not embedding.** Knowledge lives in shared resources. Roles point to it. Context doesn't bloat.
- **Conventions.** Every document follows the same authoring rules, so tooling can operate on them uniformly.
- **Tooling.** Manages links, validates structure, synthesizes research, reorganizes content. Without tooling, this falls apart at scale.
- **Separation of intent from structure.** Conventions allow reorganization without modifying the intent of the content. You can restructure, re-link, compress, and split documents, and the knowledge they contain remains intact.

---

## Authoring Conventions

These are platform-level rules that govern how any Collabot entity body is written. They're not content — they're the constraints that make content manageable at scale.

### Confirmed Conventions
- **Front-loaded summary.** First paragraph of any entity body tells the bot what this entity is and whether to keep reading. This is the most important convention — it's what makes lazy loading work.
- **Non-discoverable content only.** If a bot can figure it out by reading code, it doesn't belong in a document. Context that duplicates what bots can discover from code is waste — neutral at best, harmful at worst (ETH Zurich research: -2% success, +23% cost for LLM-generated context).
- **Concise — link, don't embed.** If knowledge can live in a linked resource, it should. The entity body is an index and identity, not an encyclopedia.
- **Consistent structure per entity type.** Each entity type (role, skill, bot) has a template. All instances of that type follow the template. Bots learn the shape and navigate faster.

### What Conventions Enable
- **Reorganization without modifying intent.** Because content follows predictable rules, tooling can restructure, re-link, split, merge, and compress documents without changing what they mean. The convention is the contract between the author (human or bot) and the tooling.
- **Bot authoring.** Eventually, actual authoring will be a combination of user intentions + bot composition (with skills) + document tooling (linking, structuring, subdividing, organizing). Conventions make bot authoring possible — without them, bots produce inconsistent, bloated documents.
- **Scale.** Hand authoring is fine for 5 roles and 10 KB docs. It's untenable at 50 roles, 200 KB docs, and a living library. Conventions + tooling is the only path that scales.

---

## The Linking Model

Links are the growth mechanism. They're how entities gain access to new knowledge without bloating their own context.

### What the Platform Provides
- **Link management tooling** — creates, validates, and maintains references between entities and documents
- **Link-aware operations** — when documents move, split, or merge, links update automatically
- **Validation** — broken links are detected and flagged (hooks, CI, or cron)

### What the Platform Does NOT Prescribe
- Where linked documents live (any path the user configures)
- How the user organizes their knowledge topology
- Any fixed directory structure for shared resources

### Current State
Standard markdown relative paths. This works for small-scale, within-project linking.

### Vision
Managed linking — SMART links — where tooling tracks references, validates them, and can reorganize targets without breaking references. This connects to the future memory system: the same infrastructure that manages document links will manage memory references, knowledge decay, and synthesis.

### Connection to Memory
The linking model is the substrate for bot memory. Memories are documents. Documents are linked. The same conventions, the same tooling, the same infrastructure. When we build memory management, we're not building a separate system — we're extending the authoring and linking infrastructure. This is why getting the foundations right matters: they're load-bearing for everything that comes after.

---

## What This Means for Specs

When writing specs that touch knowledge, authoring, or entity design:

1. **Reference this document** for philosophical grounding
2. **Follow authoring conventions** in the spec's concrete outputs
3. **Design for growth** — entities start minimal, grow through linking
4. **Design for tooling** — if it can't be tooling-managed, it won't scale
5. **Separate platform from configuration** — the platform provides infrastructure, users provide content and topology

---

## Open Questions

- **SMART linking specification:** What does the managed linking tooling actually look like? API, storage, validation rules. Not yet designed.
- **Synthesis pipeline:** How does research get synthesized into the library? Bot-driven? Tooling-driven? Hybrid? Connects to the "Librarian bot" concept.
- **Memory system:** How do authoring conventions and linking infrastructure extend into short-term and long-term bot memory? During e2e testing, bots already attempted to save memories — the desire is there, the infrastructure isn't yet.
- **Skill pipeline:** How are skills discovered, loaded, and injected? Day-1 uses simple prompt injection. A full pipeline (discovery paths, layered resolution, model-agnostic) is a future initiative.
