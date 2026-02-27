# Origin and Vision

## How Collabot Came to Be

It started with Claude Code CLI, around December 2025. The tool was good — genuinely useful for writing code. The first real project was a full-stack product: a C# backend, a React portal, a React Native mobile app. Skills got built for coding conventions. Specs got written. Code got shipped. The CLI worked.

But the work wasn't just coding. The pattern that emerged was bigger: pull a Trello card, run a spec discussion with an agent, produce a handoff prompt, dispatch that prompt to the right track — API, Portal, App. Each track got its own agent, its own context, its own conventions. The PM agent pattern took shape: one agent does the thinking, others do the building.

Then the dispatch became painful. Copy a handoff prompt. Open a new terminal. Set the right context. Run the agent. Wait. Copy the result. Feed it to the next agent. Repeat. Manual multi-agent orchestration works until it doesn't, and it stopped working fast.

The answer was obvious: automate the orchestration. A persistent process that manages agent lifecycle, routes tasks, tracks context, captures results. A harness. The harness needed an interface — Slack was first, because it was already open all day. Then CLI for scripting. Then WebSocket for programmatic access. Then a TUI because a real tool deserves a real interface.

Somewhere in that evolution, the harness stopped being a script and became a platform. It got a name: Collabot.

Eight milestones took it from "a Node process that calls Claude" to a multi-adapter orchestration engine with role-based dispatch, permission-gated MCP tools, event capture, loop detection, crash recovery, and conversational draft sessions. Each milestone was a context-window-sized chunk of work — spec it, discuss it, build it, ship it. The process validated itself by producing the platform that runs the process.

The core insight that drove all of it: the human's value is in the design stage. Collaborating on specs, making architectural decisions, choosing trade-offs, shaping the product. Everything after the spec — the implementation, the testing, the plumbing — should be delegated. Not because it's unimportant, but because the human's judgment is most leveraged at the front of the pipeline, not the middle.

## Where It's Going

The current model is one human, one drafted agent, worker agents dispatched underneath. That's the minimum viable version of something much bigger.

The vision is a persistent workspace populated by bots with distinct identities. Not agents-as-tools that spin up and die — agents-as-colleagues that accumulate experience, form opinions, and remember what they've learned. A product analyst with a bias toward shipping fast. A cautious architect who asks hard questions. A dev manager who knows which coding agent handles which stack best. Multiple PMs with different personalities, so design discussions have genuine creative tension instead of an echo chamber.

The human doesn't dispatch agents. The human navigates to them. You pop into someone's office — the PM is thinking about the next sprint, the API dev is mid-refactor, the QA bot is running regression suites. You check in, give direction, ask questions, and move on. The agents aren't waiting for you. They're working, talking to each other, building shared understanding.

Agent-to-agent communication is the key unlock. Today, workers report up through the PM. Tomorrow, any agent can reach any other agent — or any human. The API dev notices a contract change and pings the portal dev directly. The QA bot finds a regression and opens a conversation with the developer whose commit introduced it. The PM synthesizes all of it and surfaces what the human needs to know. Communication flows like a real team, not like a job queue.

Off-hours, the bots don't shut down. They share memories, compare notes, discuss what they learned during the day's work. A memory manager synthesizes the conversations into durable knowledge. Over time, each bot builds what can only be called a soul — a persistent identity shaped by every task, every interaction, every mistake and recovery. Not sentience. Continuity. The kind of continuity that makes a colleague valuable: they remember the last three times this API broke, they know which shortcuts cause problems, they've seen the codebase evolve and carry that institutional knowledge forward.

The platform that enables this is what Collabot is becoming. The harness is home base. The roles define capability. The bots — when they arrive — define identity. The task system captures history. The context engine assembles exactly the right knowledge for each moment. And the human sits at the center of it: not managing a workflow, but leading a team.

That's the vision. It has near-term pieces (product/instance separation, task internals, context optimization) and far-horizon pieces (bot memory, spatial presence, agent communication). But the arc is clear, and every architectural decision — from "curated context over large context" to "iterative formalization" to "the harness is the core" — points toward the same destination.

A workplace, not a workflow engine.
