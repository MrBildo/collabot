# Milestones G & H Post-Mortem Meeting Log

**Date:** 2026-02-21
**Participants:** User (project lead), Hub Agent (meeting organizer)
**Format:** Topic-by-topic discussion, notes appended to post-mortem doc, action items at end

---

## Topic 1: Lean vs. Over-Specified Dispatch Prompts

**Hub's opening:** G1 was ~200 lines of code excerpts, G2/G3 were ~30 lines. Lean worked better. Proposed rule: never paste code, only WHAT/WHY + file pointers + constraints. Exception for non-obvious gotchas agents can't discover by reading code.

**User's response:** Agrees with the rule in principle, but reframed the issue — this gets solved structurally as work moves through the harness rather than being manually orchestrated by the hub. PM role guardrails prevent over-specification. Bot memory eliminates front-loading. Context reconstruction (already in Milestone E) is the machine version of pasting code. The "lean prompt" insight is an early symptom of what the harness will enforce by design.

**User also raised:** The harness is outgrowing KindKatch. Rebranding and extracting it into a general-purpose platform is the next major step. This connects to bot memory, PM role codification, and task/journal maturity.

**Resolution:** The "never paste code" rule is valid as interim guidance but the real fix is systemic — the architecture eliminates the problem. Added to agenda: harness independence/rebranding as capstone topic.

---

## Topic 2: The TUI Rewrite Saga

**Hub's opening:** Three failed attempts before success. Agents anchor to existing code even when told to rewrite. Only nuking the directory and starting fresh broke the anchoring. Proposed this is a cognitive limitation of current models — existing code is stronger context than prompt instructions.

**User's response:** Confirmed the pattern but added critical nuance. Four attempts, three variables:
- Attempt 1: Spec + dreams, no KB. Pure vibe-coding. Not terrible, but poor library knowledge and conventions.
- Attempts 2/3: Some research data available, but agent anchored to existing (bad) code.
- Attempt 4: Nuked directory, same spec, BUT added massive Terminal.Gui KB + code conventions doc. Night and day.

User's conclusions:
- A: Agent anchoring to existing conventions is *generally desirable* — important training data for the system. It's only fatal when the existing code is wrong.
- B: Detailed KB articles and research make a huge difference vs. vibe-coding.
- C: User caught the TUI quality issues because of strong C# domain knowledge. Lacks that for TS/Node, which creates anxiety about harness code quality. Theory: models are better-trained on TS, so instincts may be better — but that's a vibes-based quality gate.

**Hub's response:** The KB-first pattern isn't just for unfamiliar libraries — it's a quality assurance mechanism for domains where the human can't be the expert reviewer. For TS harness code, a KB would make output auditable against documented standards rather than gut feeling. But no evidence of TS quality problems — 106 tests pass, multi-agent handoff works.

**User's response:** No concerns with harness TS quality so far. Not investing in a harness conventions KB yet — priority is getting the harness to daily-driver status, then researcher bots will build the KB library through the harness itself. The platform will improve itself.

**Resolution:** Three key insights:
1. Agents anchor to existing code (generally good, fatal when code is bad — must nuke to break the cycle)
2. KB-first is a force multiplier and a quality gate, not just a learning aid
3. Sequence: harness as daily driver → researcher bots → self-building KB library

---

## Topic 3: KB-First — When Required vs. Overkill

**Hub's opening:** Proposed a heuristic for when to invest in a KB before dispatching coding agents:
- **Required:** Pre-release/unstable library, breaking changes from training data version, sparse/misleading docs
- **Helpful but optional:** Mature library with good docs but non-standard usage or project-specific conventions
- **Skip:** Well-known stable libraries used in standard ways (Express, React, xUnit)

Cost of a KB (~1 researcher dispatch, 10-15 min, few dollars) is much less than a failed coding dispatch without one (H proved this multiple times over).

**User's response:** Accepted the heuristic as a starting point. Everything evolves.

**Resolution:** Heuristic captured as initial guidance. Will refine with experience.

---

## Topic 4: Convention Adherence Failure

**Hub's opening:** Two distinct failures: (1) wrong path in dispatch prompt — agent silently proceeded without conventions, (2) right path but agent ignored conventions because existing code was a stronger signal. The silent failure is concerning — agents should ask when they can't find referenced files. Question: solve in prompts or at the harness level?

**User's response:** Both, but mostly harness. Three ideas:
1. **Tooling:** `dotnet format` picks up `.editorconfig` — user has a rich one that covers most of the C# conventions. Harness can run tools post-dispatch as hooks. No need to spec now, just capture.
2. **Roles as harness signals:** Roles aren't just prompt templates — they signal to the harness what tooling, conventions, and context to wire up. A C# role tells the harness to run `dotnet format`, inject conventions, etc. This gets built after the harness is extracted and roles become real.
3. **Prompt instructions remain the fallback** for anything tooling and context injection don't catch.

**Hub's synthesis:** Three-layer convention enforcement, ordered by reliability:
- Layer 1: Tooling (deterministic, can't be ignored — `dotnet format`, linters, harness hooks)
- Layer 2: Role-driven context injection (harness assembles conventions/KBs based on role signal — reliable but can be ignored)
- Layer 3: Prompt instructions (weakest signal, fallback only)

Goal: push everything possible into layers 1 and 2. All of this depends on roles being real roles in a real harness — which is why extraction/rebranding comes first.

**Resolution:** Convention adherence is a harness feature, not a prompt discipline problem. Captured as future harness capability (post-dispatch hooks, role-driven tooling). No spec needed now.

---

## Topic 5: PM Role as Orchestrator

**Hub's opening:** One role prompt change (telling the PM about MCP tools) unlocked the full multi-agent E2E handoff. The MCP tools existed (Milestone F), the PM role existed (Milestone E), but the role prompt didn't mention the tools. Pattern: harness capabilities are ahead of role definitions. Highest-leverage improvement might be making existing capabilities discoverable to roles, not building new features.

**User's response:** "I was blown away when it worked, but also I shouldn't have been surprised. We've been focusing on this goal since day one." Agreed the harness is more capable than it's being used for — user isn't even sure they fully know its capabilities at this point. Wants a feature review of the harness + TUI after the rebranding/extraction.

**Resolution:** The PM role unlocking validates the architectural investment. Harness capabilities outpace role awareness — a feature review post-rebranding will close this gap. Added to agenda.

---

## Topic 6: Adapter Pre-Filtering

**Hub's opening:** Right call. Each adapter declares what message types it accepts — respects adapter-as-dumb-renderer principle. Slack can't handle verbose tool spam, TUI can with user-controlled verbosity knob. Future concern: filter declaration is bespoke per adapter, needs standardization as more adapters come online.

**User's response:** Agreed. Needs to be standardized and documented.

**Resolution:** Pre-filtering architecture is sound. Standardize the filter spec and document it as part of the rebranding/extraction work.

---

## Topic 7: Cost and Efficiency

**Hub's opening:** H had ~50% waste rate (3 of 6 dispatches failed), but the failures were caused by identifiable, now-fixed problems — not systemic. The meaningful number is $0.41 for the first E2E multi-agent handoff (3 agents, 33 seconds). That's steady-state cost. The H waste was tuition. Don't set a failure rate target — track whether the *same* failure mode recurs. New failure modes = learning. Recurring ones = process failure.

**User's response:** Agreed. Nothing to add.

**Resolution:** $0.41 E2E cost is the benchmark. Waste was tuition, not systemic. Track recurring failure modes, not overall failure rate.

---

## Topic 8: Harness Independence / Rebranding

**Hub's opening:** The harness is architecturally general-purpose already — nothing KindKatch-specific. Extraction means: new repo, KindKatch becomes a client/config, TUI ships with the platform, hub concept evolves or goes away. Question: name? Just a repo extraction, or a product with its own identity?

**User's response:** It's going to be its own brand and product. Name: **Collabot** (collaborate + bot). Logo already designed (interlocking bot heads with gear motif, pixel/retro aesthetic). Planning the full extraction will be the next session after this post-mortem. Wants figlet/ASCII art for the TUI — Terminal.Gui may not support figlet natively (Spectre.Console does), needs research.

**Resolution:** Collabot is the name. Full extraction planning is the immediate next step after this post-mortem. Figlet support for TUI is a minor research item.

---

## Close

**Topics discussed:** 8 (7 planned + 1 added during discussion)
**Key resolutions:**
1. Lean prompts are interim guidance — harness solves this structurally via PM roles, bot memory, context reconstruction
2. Nuke-and-rebuild is the correct pattern when agent anchoring to bad code blocks a rewrite
3. KB-first is a force multiplier AND a quality gate — heuristic captured for when to invest
4. Convention adherence is a three-layer harness feature (tooling → context injection → prompt fallback), not prompt discipline
5. Harness capabilities outpace role awareness — feature review needed post-rebranding
6. Adapter pre-filtering was the right call, needs standardization
7. H waste was tuition ($0.41 E2E is the benchmark)
8. **Collabot** — the harness becomes its own product, planning starts next session

**Action items:** 1 immediate, 3 post-rebranding, 4 future
**Deferred discussions:** None — all topics resolved or explicitly captured as future work
