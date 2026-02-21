# Post-Mortem: Milestones G & H (WebSocket Adapter + TUI Client)

**Date:** 2026-02-21
**Feature:** WebSocket adapter (harness-side) + TUI client (.NET 10, Terminal.Gui v2)
**Branch:** `workflow-v2`

## Context

Milestones G and H delivered the WebSocket communication layer and the Terminal.Gui TUI client, completing the adapter trifecta (Slack, CLI, WebSocket/TUI). G was clean — 4 steps, 4 dispatches, no drama. H was a saga — 3 failed coding agent attempts before a full nuke-and-rebuild from a purpose-built knowledge base succeeded. The milestone culminated in the first multi-agent orchestrated handoff: user -> TUI -> harness -> PM agent -> 2 parallel coding agents -> synthesized result -> user. 33 seconds, $0.41.

## What Worked Well

### Lean dispatch prompts (when we used them)
G2/G3 proved that ~30-line prompts (goal + file pointers + constraints) outperform verbose prompts with pasted code. But this is interim guidance — the real fix is architectural. As the PM role gets codified with guardrails, bot memory develops, and context reconstruction matures, over-specification becomes structurally impossible. The harness solves the problem the hub-as-human couldn't.

### PM role unlock — one prompt change, full vision realized
The product-analyst role already had planning capability (Milestone E) and the MCP tools already existed (Milestone F). One paragraph in the role prompt ("you have draft_agent and await_agent") and the PM orchestrated two parallel coding agents, synthesized results, and reported back. 33 seconds, $0.41. Harness capabilities are ahead of role definitions — the highest-leverage work may be making existing capabilities discoverable, not building new ones. Feature review planned post-rebranding.

### KB-first as a force multiplier
Attempt 4 of the TUI (nuked directory + comprehensive KB + conventions doc) produced dramatically better results than attempts 1-3. The KB isn't just a learning aid — it's a quality gate, especially in domains where the human can't be the expert reviewer.

## What Didn't Work / Needs Refinement

### Agent anchoring to bad code
Three attempts to fix/rewrite the TUI failed because the agent anchored to existing patterns even when told to rewrite. Only deleting the directory entirely broke the cycle. Key insight: anchoring is *generally desirable* (it's how agents follow project conventions), but it's fatal when the existing code is wrong. When a rewrite is warranted, nuke first.

### Vibe-coding without KB
Attempt 1 had no library KB — just the spec. The agent produced code that worked but demonstrated poor understanding of Terminal.Gui v2 patterns. Models can code without KBs, but the quality ceiling is much lower.

### Convention adherence — agents silently ignored conventions doc
Dispatch prompts referenced a conventions doc, but: (1) path was wrong in early prompts and agents proceeded silently, (2) even with the correct path, existing non-conforming code was a stronger signal. Fix is systemic — three layers: deterministic tooling (dotnet format, linters via harness hooks), role-driven context injection, and prompt instructions as fallback. Roles signal to the harness what tooling to wire up. Depends on harness extraction and real role definitions.

## Bottom Line

Milestones G and H proved the architecture works end-to-end — from TUI to harness to multi-agent orchestration and back, in 33 seconds for $0.41. The waste in H wasn't systemic; it was tuition that produced three durable lessons: agents anchor to existing code (nuke when it's bad), KBs are force multipliers not luxuries, and the harness solves prompt discipline problems structurally. The platform is more capable than we're using it for. It's time to give it its own identity — **Collabot** — and start using it to build itself.

## Action Items

### Immediate
- **Plan the Collabot extraction** — next session. New repo, rebrand, KindKatch becomes a client config. Full planning scope TBD.

### Post-Rebranding
- **Feature review** — audit harness + TUI capabilities to close the gap between what the platform can do and what roles/users know it can do
- **Standardize adapter pre-filtering** — document the filter spec so any new adapter implements a consistent declaration
- **Figlet/ASCII art research** — Terminal.Gui figlet support for Collabot branding in the TUI

### Future (No Spec Needed Yet)
- **Post-dispatch hooks** — harness runs tooling (dotnet format, linters) after coding agents complete, driven by role signals
- **Role-driven context injection** — roles signal which conventions, KBs, and tools to wire up; harness assembles automatically
- **Bot memory** — bots return to pool richer after tasks. Eliminates prompt front-loading. Coming soon but not yet scoped.
- **KB library via researcher bots** — once harness is daily driver, use it to build its own knowledge infrastructure
