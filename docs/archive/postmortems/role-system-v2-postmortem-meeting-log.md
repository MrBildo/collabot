# Role System v2 Post-Mortem Meeting Log

**Date:** 2026-02-26
**Participants:** User (project lead), Hub Agent (meeting organizer)
**Format:** Topic-by-topic discussion, notes appended to post-mortem doc, action items at end

---

## Topic 1: Role System v2 Execution

**Hub's case:** Textbook spec-first delivery. 26 design decisions documented, 5 clean phases, single commit. Decision documentation (D1-D26) is a standout — captures reasoning, not just outcomes. Clean-cut migration (no backward compat) was the right call at current scale. Probed: Phase 4 (entity tooling) incomplete — was this deliberate or did it fall off?

**User's response:**
- Decision documentation is key and reflects Collabot's core purpose — collaborative planning with bots, agents, humans. More of this coming.
- Phase structure is pragmatic, not formal. Sized to coding agent context windows: "what granular, isolated, logical tasks can we fit into a single context window?" Not exact science yet — metrics and memory will refine.
- Entity tooling was a **deliberate scope cut** made during spec discussions. Goal was defining and codifying role structure, not authoring assistance. Harness works without it. Right focus.
- User acknowledges adding TUI tweaks at the end (from manual testing annoyance) — should have been follow-ups. Process and scope were otherwise correct.

**Hub's follow-up:** Phase sizing as "context window budget" is a genuinely novel constraint traditional SDLC doesn't account for. The pattern of manual-testing-annoyance → scope expansion is minor here but worth watching.

**Resolution:** Spec-first process validated. Phase granularity is pragmatic and appropriate — will formalize as metrics improve. Entity tooling deferred deliberately. Minor scope creep from manual testing noted as a pattern to watch.

## Topic 2: Event Capture Replacing Journaling

**Hub's case:** Harness-owned event capture replacing agent journaling is architecturally sound. But the flat structure (all events as siblings in a single array) is a known gap. No parent-child relationship for multi-agent dispatches. Impacts context reconstruction and debugging/observability. Two concerns: (1) gets harder to fix the longer you wait, (2) already documented as deferred.

**User's response:**
- Rates this 7-8 out of 10 severity. No point using harness in production without these changes.
- Collabot is not yet in production. User will decide when to make that move. Not worried about big sweeping changes right now — 30+ years of instinct about points-of-no-return.
- Scope is bigger than just events.json. Needs a holistic review of how, what, and why we track task data — the task's "guts."
- Draws direct analogy to roles: started loose, implemented, used the system, and the vision became self-evident. "That IS agile. That IS iterative."

**Hub's follow-up:** Roles analogy is exactly right — journaling is at the same inflection point roles were before v2. Loose version served its purpose; vision is now clear from real usage. Not a "should have done this sooner" issue — designing earlier would have been guessing. 7-8 severity puts it in pre-production hardening, aligning with CI/CD push.

**Resolution:** Task internals redesign identified as a substantial future work item. Same treatment as roles: define, codify, then build tooling. Not just a `dispatchId` field — a holistic review of task persistence, event scoping, and observability. To be spec'd and discussed in its own session.

## Topic 3: TUI Velocity & Sustainability

**Hub's case:** TUI velocity was impressive (markdown renderer, message formatting, editor support in few commits). KB-first lesson from Milestone H enabled this. Concern: TUI is growing substantial in a separate tech stack (.NET). Is this sustainable? Is there a point where maintaining a separate stack becomes friction?

**User's response — Why .NET:**
- C#/.NET is a capable cross-platform toolset, better for performance-oriented tasks like TUIs than Electron/React-based alternatives
- User has 20+ years .NET expertise — can review agent-written code from a position of strength
- Considered rewriting harness in .NET for performance, but TS velocity is desirable. Sticking with TS for harness.

**User's response — State of TUI:**
- Planning to break TUI into its own project as part of CI/CD initiative. Collabot core = harness. TUI = one adapter among many.
- Code conventions abandoned early. Working within Claude Code CLI limitations (skills, claude.md, haphazard docs). No complete coding convention doc. Early KindKatch conventions lost when project scope changed.
- Agents not using KB during TUI dev — either not being told to look, or signal-to-noise ratio causes it to be ignored
- Stuck in chicken-and-egg: wants Collabot to enforce conventions on Collabot, but Collabot isn't ready yet
- Vision: fully realized dotnet-coder role + properly formatted KB + .editorconfig + dotnet format hooks → tech debt/refactor pass over entire TUI
- TUI not critical to Collabot's success, works well for current needs. Most future dev focused on harness.

**Hub's response — .NET opinions:**
- TUI in .NET: strong yes, long-term. Terminal.Gui is best-in-class. User's expertise advantage is real.
- Harness in .NET: pushback. Harness is I/O-bound (coordination, not computation). TS is native ecosystem for Agent SDK — staying in it reduces friction on SDK updates. .NET Aspire solves different problem shape.
- Reframed "deliberate failings" as "deliberate deferrals" — discipline, not failure. Convention enforcement before the delivery mechanism existed would have been wasted effort.
- Proposed minimum viable convention loop to stop drift now: .editorconfig + dotnet format (even manual) + conventions doc in dotnet-dev role
- Named TUI as testing surface: it's how user observes agent behavior and validates features. More important than "just a window" until CI/CD and observability exist.

**Potential action items noted (to finalize at end):**
- TUI extraction into own project (part of CI/CD push)
- Minimum viable convention loop: .editorconfig + dotnet format + conventions doc
- KB usage investigation: why aren't agents using it during TUI dev?

**Resolution:** .NET for TUI is the right long-term call. TS for harness is the right call. The bootstrapping problem (Collabot enforcing conventions on itself) needs a minimum viable loop to stop drift while the real mechanism is built. TUI extraction planned as part of CI/CD initiative.

## Topic 4: Draft Sessions as the Primary UX

**Hub's case:** Draft sessions changed the interaction model from fire-and-forget to conversational. Made the platform usable for its builder. Two concerns: (1) context window baseline cost (~20K tokens / 10% before any user input, MCP tool defs = 6-8K), (2) draft spec still marked "Draft" status despite full implementation.

**User's response — Genesis story and grand vision:**
User provided the full origin arc of Collabot:
- Started with Claude Code CLI (~Dec 2025), built skills for KindKatch (C# conventions)
- Moved to PM agent pattern: Trello card → spec discussion → handoff prompts for API/Portal/App tracks
- Manual multi-agent dispatch became painful → automated orchestration → harness → Collabot
- Core insight: user's value is in the design stage. Everything after spec should be delegated.

**Grand vision articulated:**
- Multiple PMs with different personalities/biases for richer design discussions
- PM delegates to dev manager bot, who dispatches coding agents
- Any agent can reach any human or bot (not just up-the-chain)
- Always-running service where human "pops into someone's office" to interact with any bot
- Off-hours bot chat rooms for sharing memories, building "bot soul," informing memory manager
- Vision has near-term and far-future elements, but the unifying driving vision is essential

**On context window:**
- Serious problem, called out last dev cycle
- Suspects current context files aren't following research recommendations
- MCP tooling is expensive — need ways beyond doc organization to reduce
- Context windows will scale (Anthropic already offers experimental 1M) — not panicking
- **Key principle stated:** "An agent with a reduced context window due to important conventions, guidelines, and precise instructions, focusing on small, granular tasks in short sessions is far more valuable than an agent with a 1M context window but just vibes to go on."
- Lots of bloat and unorganized docs from harness dev — improves with CI/CD move
- Wants research task AFTER CI/CD move — current state not representative of final intent

**On draft status:** Hub clarified this was just doc hygiene — spec file header says "Draft" but feature is implemented. Trivial fix.

**On conversational model:**
- Current model: 1 draft at a time, one role interacted with, that role may dispatch others
- Limited visibility into dispatched agents — mostly by design (delegate and trust)
- Gap identified: no way for a coding agent to reach the human directly without going through PM
- "Fire-and-forget" undersells the vision — it's an always-running platform with persistent bot presence
- Human navigates to agents ("pop into their office"), not the other way around
- Bots share experiences and build "bot soul" through interaction and memory

**Hub's response:**
- Genesis story should live somewhere permanent — it's the WHY behind every architectural decision
- The context window principle is the Collabot thesis in one sentence. Worth codifying as a platform principle. More context ≠ better, same as more storage ≠ better schema design.
- MCP tool cost: investigate lazy tool registration, description compression, tiered tool sets (after CI/CD)
- "Pop into someone's office" = spatial presence model, fundamentally different from agent-as-worker-in-queue. Closer to a workplace than a workflow engine.
- Named foundational capability for future design: **agent-initiated communication with arbitrary targets** — the missing piece between "dispatch and wait" and "pop into their office"
- Vision sharpens immediate priorities: CI/CD (build things outside Collabot), task internals (persistence for persistent bots), context optimization (curated context is the product), agent comms (next frontier)

**Potential action items noted:**
- Capture genesis story / platform vision narrative in a permanent doc
- Codify "curated context > large context" as a platform principle
- Update draft-sessions.md status from "Draft" to implemented
- Context window research task (AFTER CI/CD)
- Agent-initiated communication — future design session topic

**Resolution:** Draft sessions validated as the right paradigm for the design-stage interaction where user value lives. Current limitations (single draft, no worker-to-human comms) are known and acceptable for now. Grand vision articulated: persistent bot presence, spatial navigation, bidirectional communication. Context window is a real concern but research deferred until after CI/CD when the system is more representative.

## Topic 5: The Collision Problem

**Hub's case:** Assumed collisions were git/file-level — agents stepping on each other's changes in the same working directory. Proposed branch-per-agent + automated build/test as the fix.

**User's correction — the real collision is identity, not files:**
- File-level collisions haven't actually occurred yet. Development pace is deliberately slow (~5 hours per iteration, ~30-45 min actual coding). Each coding task fits a single context window. Git collisions are a future concern, not a current one.
- The real collision: **product vs instance identity.** It's impossible to tell whether something belongs to "Collabot the product" (shipped platform) or "my Collabot" (personal installation).
- Example: `ts-dev` role — is it a product default or a user's custom role? Answer: it's the user's role, not a shipped default. But it lives in the product repo.
- Self-reference makes it hard to iterate on roles, tasks, prompts, docs — unclear if changes are "product improvements" or "instance configuration."
- User wants clear separation: Collabot the product is developed externally. User's Collabot is a stable production instance. Product updates flow in like any other dependency.

**Hub's analysis:**
- Mapped the entire repo to product vs instance ownership. Key ambiguities: roles, prompts, skills, config. Projects and tasks already gitignored (good).
- This is classic platform-vs-instance separation (WordPress core vs WordPress site, NuGet package vs consuming project).
- The collision means: editing a role is ambiguous — is it a product change or a personal preference? Can't iterate freely because everything is tangled.
- Reframes the CI/CD initiative entirely: not "add a build pipeline" but "separate the product from the instance."

**User confirmed:** This is the core of the CI/CD initiative. Consumption model (npm package, git submodule, monorepo, CLI installer) is TBD — will be a major part of the design/scoping discussion.

**Hub's follow-up:** Consumption model deserves its own spec discussion with real trade-offs analysis. Each option has implications for instance upgrades, breaking changes, and future user onboarding.

**Potential action items noted:**
- Product/instance separation spec discussion (core of next initiative)
- Audit all repo contents to classify product vs instance
- Design consumption model (npm, submodule, monorepo, installer — TBD)
- Capture file-level agent collisions as a future concern (not current)

**Resolution:** The collision problem is identity, not files. Fix is product/instance separation, not branch strategies. This reframes the entire CI/CD initiative. Consumption model is a design decision for its own session.

## Topic 6: Dogfooding Readiness

**Hub's case:** Even after product/instance separation, Collabot needs to be reliable enough to point at KindKatch. Assessed: architecturally ready (roles v2, permissions, loop detection), operationally not (separation blocker). Asked: anything beyond separation as a hard prerequisite?

**User's response:**
- No other hard prerequisites. Event capture/journaling will change, but at worst task artifacts won't be in the right format. No real consumer of that data yet, so incompatible artifacts are acceptable debt.
- Even deploying to "production" on local machine, not concerned about production-readiness. Still actively in development with no plan yet for team release or OSS.
- Pragmatic stance: ship it, learn from real usage against KindKatch, let that inform future redesigns.

**Resolution:** Product/instance separation is the **only hard prerequisite** for dogfooding. Everything else is acceptable debt for a single-user active-development installation. Collapses into Topic 5 — same initiative, same gate.

## Topic 7: Deferred Items Triage

**Hub's case:** 18 deferred items accumulated across this push and prior work. Proposed clustering by initiative timing rather than going one-by-one. User agreed with condition that every item is touched.

**All 18 items triaged into 4 clusters:**

### Cluster A: Product/Instance Separation Initiative
| # | Item | Rationale |
|---|------|-----------|
| 12 | Product/instance separation | The initiative itself |
| 11 | TUI extraction into own project | TUI is a separate product — falls out of separation |
| 4 | Prompt content review (system.md, tools.md) | Audit what's product vs instance; prompts reviewed naturally |
| 17 | Feature review (capabilities vs role awareness) | Same audit — inventory what exists as you classify product vs instance |
| 9 | TUI convention loop (.editorconfig + dotnet format + conventions doc) | Once TUI is its own project, it gets its own conventions |

### Cluster B: Post-Separation, Pre-KindKatch
| # | Item | Rationale |
|---|------|-----------|
| 1 | Task internals redesign | 7-8 severity, not needed for dogfooding but wanted soon after. Own spec-discuss cycle. |
| 3 | Context window research | User said after CI/CD — separation is that gate |
| 14 | Post-dispatch hooks (dotnet format, linters) | Needs separated project structure; role signals which tools, harness executes |
| 15 | Role-driven context injection | Roles need to be instance-side; injection needs product/instance boundary |
| 10 | KB usage investigation | Easier to diagnose once KB location (product vs instance) is clear |

### Cluster C: Do Now / Trivial
| # | Item | Effort |
|---|------|--------|
| 6 | Update draft-sessions.md status | 30 seconds — change header field |
| 5 | Draft recovery stale role validation | Small fix — validate role on recovery, offer to close if stale |
| 8 | Codify "curated context > large context" as platform principle | A paragraph in vision doc |
| 7 | Capture genesis story / platform vision narrative | Write-up from Topic 4 discussion, in vision doc or standalone |

### Cluster D: Future / Long-Horizon
| # | Item | Dependency |
|---|------|------------|
| 2 | Entity authoring tooling | Entity model must stabilize post-separation |
| 13 | Agent-initiated communication with arbitrary targets | Needs bot abstraction and communication model design |
| 16 | Bot memory | Needs bot abstraction, task internals, event scoping — furthest horizon |
| 18 | Agent file collision mitigation | Not a problem at current pace; relevant when concurrent agents on same project |

**User approved all groupings as-is. No items moved between clusters.**

**Resolution:** All 18 items categorized. Cluster A is the next initiative. Cluster B follows. Cluster C can be done anytime. Cluster D is parked until prerequisites exist.

---

## Bottom Line

The platform works. Eight milestones complete, Role System v2 shipped spec-to-merge in two days, the process is validated. The single blocker to real-world use is identity: product and instance are tangled. Product/instance separation is the only hard gate before KindKatch dogfooding. Everything else is acceptable debt or sequenced behind separation.

## Action Items

Written to post-mortem doc. 4 immediate, 6 in next initiative, 5 post-separation, 4 parked future.

## Meeting Close

- **7 topics discussed** (Role v2 execution, event capture, TUI velocity, draft sessions/vision, collision problem, dogfooding readiness, deferred items triage)
- **Key resolutions:** spec-first process validated, event capture needs roles-style redesign, TUI stays .NET, draft sessions are the right paradigm, collision is identity not files, product/instance separation is the single gate
- **19 action items** across 4 time horizons
- **Deferred discussions:** product/instance separation spec-discuss (next initiative), task internals spec-discuss (post-separation), agent communication model design (future)
