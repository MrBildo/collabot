# Authoring and Knowledge — Platform Vision

## What This Document Is

This captures the foundational philosophy behind how Collabot manages knowledge, documents, and entity authoring. It's the mental model that informs concrete specs (starting with Role System v2) and will outlive any single spec. Future specs should reference this document rather than re-deriving these principles.

**Origin:** Emerged from the Role System v2 spec-discuss sessions (Feb 2026), where the frontmatter schema discussion evolved into a broader conversation about what Collabot actually is as a platform, and how it should think about knowledge.

---

## The Core Distinction: Platform vs. Configuration

Collabot is an orchestration platform. It ships with infrastructure, not content.

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

A fresh Collabot installation is essentially empty. Maybe a default role, maybe a starter project. Everything else — the roles, the knowledge bases, the library of conventions, the research — is built up by the team using it.

This matters because it means the platform's job is to provide the **infrastructure for knowledge growth**, not the knowledge itself. Collabot is the operating system. The user's configuration is the filesystem.

---

## The OS-for-Bots Analogy

Collabot is, in a meaningful sense, an operating system for AI agents. The analogy maps surprisingly well:

| OS Concept | Collabot Equivalent |
|------------|-------------------|
| Filesystem | Entity documents (roles, skills, bots, KB docs, research, conventions) |
| File format | Entity frontmatter schema + authoring conventions |
| Memory management | Context window management, event capture, future memory system |
| Compression | Progressive disclosure, lazy loading, linking over embedding |
| Disk defragmentation | Tooling that reorganizes knowledge without modifying intent |
| Process scheduler | Dispatch, agent pool, task lifecycle |
| Device drivers | Adapters (Slack, CLI, WebSocket, TUI) |
| User programs | Projects, tasks, agents doing actual work |

The key insight: an OS doesn't tell you what files to create or where to put them. It gives you a filesystem, enforces file format conventions, provides tools for managing files, and stays out of your way. Collabot does the same with agent knowledge.

---

## The Growth Model

Entities start minimal and grow over time. This is not a bug or a "we'll fill it in later" — it's the design.

**Example: A TypeScript coding role's lifecycle**

1. **Day 1:** Basic identity. "You are a TypeScript developer." A few guidelines. Maybe 20 lines.
2. **Week 2:** The team adopts a TS coding convention doc. The role links to it (doesn't embed it). The convention lives in a shared library, usable by other roles too.
3. **Month 1:** An agent researches a specialized TS library for a project. The research gets synthesized and added to the library. The role gains access via a link. Zero changes to the role file itself.
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
- **Front-loaded summary.** First paragraph of any entity body tells the agent what this entity is and whether to keep reading. This is the most important convention — it's what makes lazy loading work.
- **Non-discoverable content only.** If an agent can figure it out by reading code, it doesn't belong in a document. Context that duplicates what agents can discover from code is waste — neutral at best, harmful at worst (ETH Zurich research: -2% success, +23% cost for LLM-generated context).
- **Concise — link, don't embed.** If knowledge can live in a linked resource, it should. The entity body is an index and identity, not an encyclopedia.
- **Consistent structure per entity type.** Each entity type (role, skill, bot) has a template. All instances of that type follow the template. Agents learn the shape and navigate faster.

### Guidelines Under Consideration
- **Heading depth cap of 3** (`#`, `##`, `###` max). Emerged from research (production systems, deep research report). Makes engineering sense — deep nesting signals a document that should be split. Not yet confirmed as a hard rule in Collabot; may adopt after practical experience with authored entities.

### What Conventions Enable
- **Reorganization without modifying intent.** Because content follows predictable rules, tooling can restructure, re-link, split, merge, and compress documents without changing what they mean. The convention is the contract between the author (human or agent) and the tooling.
- **Agent authoring.** Eventually, actual authoring will be a combination of user intentions + agent composition (with skills) + document tooling (linking, structuring, subdividing, organizing). Conventions make agent authoring possible — without them, agents produce inconsistent, bloated documents.
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
- How the user organizes their knowledge topology (that's their "filesystem")
- Any fixed directory structure for shared resources

### Minimal Viable Version
Today: standard markdown relative paths (D12). This works for small-scale, within-project linking.

### Vision
Managed linking — what we're calling SMART links — where tooling tracks references, validates them, and can reorganize targets without breaking references. This connects to the future memory management system: the same infrastructure that manages document links will manage memory references, knowledge decay, and synthesis.

### Connection to Memory Management
The linking model is the substrate for future memory management. Memories are documents. Documents are linked. The same conventions, the same tooling, the same infrastructure. When we build memory management, we're not building a separate system — we're extending the authoring and linking infrastructure we're building now. This is why getting the foundations right matters: they're load-bearing for everything that comes after.

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

- **Heading depth cap:** Is 3 the right number? Needs practical validation.
- **SMART linking specification:** What does the managed linking tooling actually look like? API, storage, validation rules. Not yet designed.
- **Synthesis pipeline:** How does research get synthesized into the library? Agent-driven? Tooling-driven? Hybrid? Connects to the "Librarian agent" concept.
- **Memory management integration:** How do authoring conventions and linking infrastructure extend into short-term and long-term bot memory? Foundation is here, design is future.
