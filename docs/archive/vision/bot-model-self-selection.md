# Bot Model Self-Selection (Idea Capture)

**Date:** 2026-02-19
**Status:** Raw idea, not scoped

## The Concept

Bots with persistent memory (short-term + long-term) could control their own model at runtime.

### The Flow

1. Bot is in a low-stakes context — chatting with a user, another bot, doing routine coordination
2. It's running on a lightweight model (Haiku-tier) because the cognitive demand is low
3. The conversation shifts — a hard design question, a subtle bug, something requiring deeper reasoning
4. The bot recognizes this and **swaps itself to a higher model** (Sonnet, Opus)
5. Context is preserved through the bot's short-term memory, not through session continuity
6. When the hard thinking is done, the bot can drop back down

### Why This Could Work

- **Memory is the bridge.** If short-term memory carries a capable representation of the active context, the bot doesn't need session continuity — it needs context reconstruction. We're already building that (Milestone E's `buildTaskContext` is the primitive).
- **The harness already owns model selection.** Today it's a mechanical decision (config.yaml → role → model). Tomorrow the bot could signal "I need more horsepower" and the harness swaps the underlying session.
- **Aligns with "mechanical vs organic" principle.** The model is a mechanical lever. The bot's reasoning about *when* to pull it is organic. Clean separation.

### Open Questions

- What's the signal? Does the bot explicitly request an upgrade, or does the harness detect it (e.g., long tool chains, repeated failures, high-complexity keywords)?
- Cost governance — who controls the budget? Can a bot burn through Opus tokens unsupervised?
- Latency of the swap — is it a new session (seconds) or something lighter?
- Short-term memory fidelity — how much context loss is acceptable in a swap? What's "good enough"?
- Could the bot downgrade itself proactively? ("This is routine now, I don't need Opus for this.")

### Analogy

A person switches between autopilot and deep focus throughout their day. They don't become a different person — their memory and identity persist. The model is the cognitive gear, not the identity.

## Prerequisites

- Bot abstraction (persistent identity, memory system)
- Short-term memory that survives session boundaries
- Harness support for mid-task model switching
