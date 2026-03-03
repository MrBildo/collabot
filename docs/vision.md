# Collabot Vision

## How Collabot Came to Be

It started with Claude Code CLI, around December 2025. The tool was good — genuinely useful for writing code. The first real project was a full-stack product: a C# backend, a React portal, a React Native mobile app. Skills got built for coding conventions. Specs got written. Code got shipped. The CLI worked.

But the work wasn't just coding. The pattern that emerged was bigger: pull a Trello card, run a spec discussion with an agent, produce a handoff prompt, dispatch that prompt to the right track — API, Portal, App. Each track got its own agent, its own context, its own conventions. The PM agent pattern took shape: one agent does the thinking, others do the building.

Then the dispatch became painful. Copy a handoff prompt. Open a new terminal. Set the right context. Run the agent. Wait. Copy the result. Feed it to the next agent. Repeat. Manual multi-agent orchestration works until it doesn't, and it stopped working fast.

The answer was obvious: automate the orchestration. A persistent process that manages agent lifecycle, routes tasks, tracks context, captures results. A harness. The harness needed an interface — Slack was first, because it was already open all day. Then CLI for scripting. Then WebSocket for programmatic access. Then a TUI because a real tool deserves a real interface.

Somewhere in that evolution, the harness stopped being a script and became a platform. It got a name: Collabot.

Eight milestones took it from "a Node process that calls Claude" to a multi-adapter orchestration engine with role-based dispatch, permission-gated MCP tools, event capture, loop detection, crash recovery, and conversational bot sessions. Each milestone was a context-window-sized chunk of work — spec it, discuss it, build it, ship it. The process validated itself by producing the platform that runs the process.

The core insight that drove all of it: the human's value is in the design stage. Collaborating on specs, making architectural decisions, choosing trade-offs, shaping the product. Everything after the spec — the implementation, the testing, the plumbing — should be delegated. Not because it's unimportant, but because the human's judgment is most leveraged at the front of the pipeline, not the middle.

---

## Where It's Going

The current model is one human, one drafted bot, worker bots dispatched underneath. That's the minimum viable version of something much bigger.

The vision is a persistent workspace populated by bots with distinct identities. Not tools that spin up and die — colleagues that accumulate experience, form opinions, and remember what they've learned. A product analyst with a bias toward shipping fast. A cautious architect who asks hard questions. A dev manager who knows which bot handles which stack best. Multiple PMs with different personalities, so design discussions have genuine creative tension instead of an echo chamber.

The human doesn't dispatch bots. The human navigates to them. You pop into someone's office — the PM is thinking about the next sprint, the API dev is mid-refactor, the QA bot is running regression suites. You check in, give direction, ask questions, and move on. The bots aren't waiting for you. They're working, talking to each other, building shared understanding.

Bot-to-bot communication is the key unlock. Today, workers report up through the PM. Tomorrow, any bot can reach any other bot — or any human. The API dev notices a contract change and pings the portal dev directly. The QA bot finds a regression and opens a conversation with the developer whose commit introduced it. The PM synthesizes all of it and surfaces what the human needs to know. Communication flows like a real team, not like a job queue.

Off-hours, the bots don't shut down. They share memories, compare notes, discuss what they learned during the day's work. A memory manager synthesizes the conversations into durable knowledge. Over time, each bot builds what can only be called a soul — a persistent identity shaped by every task, every interaction, every mistake and recovery. Not sentience. Continuity. The kind of continuity that makes a colleague valuable: they remember the last three times this API broke, they know which shortcuts cause problems, they've seen the codebase evolve and carry that institutional knowledge forward.

The platform that enables this is what Collabot is becoming. The harness is home base. The roles define capability. The bots define identity. The task system captures history. The context engine assembles exactly the right knowledge for each moment. And the human sits at the center of it: not managing a workflow, but leading a team.

That's the vision. It has near-term pieces (production cutover, entity authoring, skill pipeline) and far-horizon pieces (bot memory, spatial presence, bot-to-bot communication). But the arc is clear, and every architectural decision — from "curated context over large context" to "iterative formalization" to "the harness is home base" — points toward the same destination.

A workplace, not a workflow engine.

---

## Deployment Identity

Collabot is a **service installed on a machine**, not a library consumed by projects. One install, one instance, one configuration. Like a database server, a CI agent, or Docker — you install it globally, configure it once, start it, and it runs. Projects connect to it; it doesn't live inside them.

```
npm install -g collabot    # install the platform
collabot init              # scaffold ~/.collabot/ with minimal config
collabot start             # run the service
```

The instance lives at `~/.collabot/` (or `COLLABOT_HOME`). Everything the user configures — roles, bots, skills, projects, credentials — lives there. The harness code ships as a global npm package and is updated independently of instance content. Product updates never touch user configuration.

---

## Platform vs. Configuration

Collabot ships with infrastructure, not content.

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

These are the governing beliefs behind how Collabot works. They emerged from building and using the platform, not from theory.

### Curated context over large context

A bot with a reduced context window, important conventions, precise instructions, and small granular tasks in short sessions is far more valuable than a bot with a million-token context window and just vibes to go on. More context is not better context — the same way more storage is not better schema design. Collabot's job is to assemble the *right* context, not the *most* context.

### Phase sizing is context window budget

Work phases aren't a formal SDLC ceremony — they're sized to what fits in a single bot's context window. A phase is a granular, isolated, logical task that one bot can hold in its head and execute completely. This is a novel constraint that traditional process frameworks don't account for.

### Iterative formalization

Start loose, use the system, let the vision become self-evident, then codify. Roles followed this pattern: started as simple prompt files, accumulated real usage, revealed their true requirements, and got a formal spec only when the shape was clear. Bots followed the same arc — from ad-hoc Slack identities to a full session pattern with placement, queuing, and prompt assembly. The loose version is not debt — it's research.

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

---

## Authoring Conventions

Platform-level rules governing how any Collabot entity body is written. They're not content — they're the constraints that make content manageable at scale.

- **Front-loaded summary.** First paragraph of any entity body tells the bot what this entity is and whether to keep reading. This is the most important convention — it's what makes lazy loading work.
- **Non-discoverable content only.** If a bot can figure it out by reading code, it doesn't belong in a document.
- **Concise — link, don't embed.** If knowledge can live in a linked resource, it should. The entity body is an index and identity, not an encyclopedia.
- **Consistent structure per entity type.** Each entity type (role, skill, bot) has a template. All instances follow it.

---

## The Linking Model

Links are the growth mechanism. They're how entities gain access to new knowledge without bloating their own context.

**Current state:** Standard markdown relative paths. Works for small-scale linking.

**Vision:** Managed linking (SMART links) where tooling tracks references, validates them, and can reorganize targets without breaking references. This connects to the future memory system — the same infrastructure that manages document links will manage memory references, knowledge decay, and synthesis.

---

## Open Questions

- **SMART linking specification:** What does the managed linking tooling actually look like? API, storage, validation rules.
- **Synthesis pipeline:** How does research get synthesized into the library? Bot-driven? Tooling-driven? Hybrid?
- **Memory system:** How do authoring conventions and linking infrastructure extend into bot memory? During e2e testing, bots already attempted to save memories — the desire is there, the infrastructure isn't yet.
- **Skill pipeline:** How are skills discovered, loaded, and injected? Day-1 uses simple prompt injection. A full pipeline is a future initiative.
