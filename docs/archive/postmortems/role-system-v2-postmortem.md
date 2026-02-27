# Post-Mortem: Role System v2 & Platform Maturation Push

**Date:** 2026-02-26
**Feature:** Role System v2 (entity schema, permissions, event capture, role content) + TUI polish + draft sessions
**Scope:** Milestones complete through H, Role System v2 spec → implementation, TUI markdown rendering, draft session UX, event capture pipeline
**Period:** 2026-02-19 through 2026-02-26

## Context

This push covered a wide arc of work. The headline was Role System v2 — a spec-first redesign of how roles are defined, loaded, and enforced across the harness. It introduced the universal entity schema (ULID + frontmatter), permission-based MCP gating (replacing category), and harness-owned event capture (replacing agent-driven journaling). Alongside this, the TUI got a full markdown rendering engine, message formatting overhaul, and external editor support. Draft sessions matured with context tracking and crash recovery. The vision doc codified the platform's authoring philosophy. All 8 original milestones are now complete.

## What Worked Well

### Spec-first process with decision documentation
The Role System v2 spec (26 design decisions, D1-D26) went through collaborative discussion, sign-off, and was implemented in a single commit. The decision documentation captures reasoning and trade-offs, not just outcomes — this is durable reference material for future agents and humans. The clean-cut migration (no backward compat) was the right call at current scale. Entity tooling was a deliberate scope cut; the goal was codifying structure, not building authoring tools. Process and scope were correct.

## What Didn't Work / Needs Refinement

### Product/instance identity collision — the real blocker
The repo conflates "Collabot the product" and "the user's Collabot instance." Roles, prompts, skills, and config are ambiguous — unclear if they're product defaults or user customizations. This prevents free iteration (editing a role might be a product change or a personal preference) and blocks using Collabot to develop external projects. The fix isn't CI/CD in the traditional sense — it's product/instance separation. Consumption model TBD. This is the core of the next major initiative.

### TUI convention drift and the bootstrapping problem
Code conventions were deliberately deferred during TUI development — the enforcement mechanism (harness hooks, role-driven tooling) didn't exist yet. Result: agent-written code drifts from desired conventions, KB isn't being used consistently, and no `.editorconfig` or `dotnet format` integration exists. The fix is a minimum viable convention loop (`.editorconfig` + `dotnet format` + conventions doc) to stop drift now, while the full vision (role-driven context injection, automatic hooks) is built. TUI extraction into its own project is planned as part of CI/CD.

### Context window baseline cost is real but premature to optimize
Fresh PA draft session burns ~20K tokens (10% context) before user input. MCP tool definitions are the biggest contributor at 6-8K. Current doc organization likely doesn't follow prior research recommendations. However, current state isn't representative — bloat from active harness development will reduce with CI/CD move. Research task planned post-CI/CD. Key principle codified: curated, structured, intentional context beats raw context window size.

### Event capture: right architecture, incomplete data model
Harness-owned event capture was the correct architectural move, but the flat event structure (no dispatch scoping, no parent-child relationships) makes multi-agent task history unusable for context reconstruction or debugging. Rated 7-8/10 severity — not production-ready without a redesign. The fix isn't a patch; it's the same treatment roles got: a holistic review of task internals (how, what, and why we track), followed by a spec and implementation. The loose version served its purpose and revealed the real requirements through actual usage.

## Bottom Line

The platform works. Eight milestones complete, Role System v2 shipped spec-to-merge in two days, the harness orchestrates multi-agent workflows end-to-end. The process — iterative, spec-first, context-window-sized phases — is validated and producing results. The single blocker to real-world use is not capability but identity: Collabot the product and the user's Collabot instance are tangled in one repo. Product/instance separation is the next initiative, and it's the only hard gate before pointing Collabot at KindKatch. Everything else — task internals, context optimization, bot memory — is either acceptable debt or sequenced behind that separation.

## Action Items

### Immediate (Do Now)
- **Update draft-sessions.md status** — change from "Draft" to implemented/complete
- **Draft recovery stale role validation** — validate role exists on session recovery, offer to close if stale
- **Codify "curated context > large context"** — add as a platform principle in `docs/vision/authoring-and-knowledge.md`
- **Capture genesis story** — write up the Collabot origin narrative (from Topic 4 discussion) in a permanent location (vision doc or standalone)

### Next Initiative: Product/Instance Separation
- **Spec discussion** — design the product/instance boundary, consumption model (npm, submodule, monorepo, installer — TBD), and instance scaffolding
- **Repo audit** — classify every folder/file as product or instance
- **TUI extraction** — break into its own project as part of separation
- **Prompt content review** — decide what's product template vs instance customization
- **Feature review** — audit harness + TUI capabilities during the classification pass
- **TUI convention setup** — `.editorconfig` + `dotnet format` + conventions doc for the new TUI project

### Post-Separation
- **Task internals redesign** — spec-discuss cycle. Event scoping, dispatch relationships, journaling holistic review. Same treatment roles got.
- **Context window research** — baseline cost analysis, MCP tool optimization, doc organization audit
- **Post-dispatch hooks** — role-signaled tooling (dotnet format, linters) executed by harness after coding agents complete
- **Role-driven context injection** — roles signal which conventions/KBs/tools to wire up, harness assembles
- **KB usage investigation** — diagnose why agents aren't using KBs during TUI dev

### Future (Parked)
- **Entity authoring tooling** — scaffolding, validation, link management. Blocked on entity model stabilization.
- **Agent-initiated communication** — any agent can reach any human or bot. Needs bot abstraction and communication model design.
- **Bot memory** — persistent identity, experience accumulation. Furthest horizon. Depends on bot abstraction, task internals, event scoping.
- **Agent file collision mitigation** — branch-per-agent, worktrees, etc. Not a problem at current development pace.
