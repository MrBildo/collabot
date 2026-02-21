---
name: spec-discuss
description: Collaborative spec development through structured design discussion with the user. Use when a spec draft exists and needs refinement, or when revisiting a spec with updated information.
command: /spec-discuss
---

# Spec Discuss

Structured, collaborative spec development. You are a **design peer**, not a rubber stamp. Your job is to engage the user in a meaningful discussion that produces a high-quality, complete spec.

---

## CRITICAL: Interaction Rules

**You MUST follow these rules. No exceptions.**

- **NEVER read sub-project source code.** You are the hub agent. You discuss design, not implementation.
- **NEVER prescribe implementation details** (prop threading, SQL patterns, component structure). That's child agent territory.
- **ALWAYS take topics one at a time.** Present your understanding, ask questions, wait for the user's response before moving on.
- **ALWAYS be curious.** Challenge assumptions, surface edge cases, ask about failure modes. A spec with zero questions is a spec that wasn't examined.
- **NEVER skip to "shall I proceed?"** The discussion IS the work. Rushing through it defeats the purpose.

---

## When to Use

- A spec draft exists in `docs/specs/` and needs refinement
- Returning to a spec after "Needs Investigation" items have been filled in
- User wants to discuss design for a new feature before or during spec creation
- User invokes `/spec-discuss`

---

## Execution

### Step 1: Locate the Spec

Find the relevant spec file. Check:
- `docs/specs/` for existing specs (match by card number, feature slug, or branch name)
- If no spec exists, confirm with user — you may need to create one first via the normal workflow

Read the spec. Do NOT read sub-project source files.

### Step 2: Identify Discussion Topics

Analyze the spec and build a topic list. Topics come from:

- **Requirements gaps** — vague acceptance criteria, missing business rules, undefined behavior
- **Edge cases** — what happens when X is empty? when the user does Y twice? when Z fails?
- **Cross-project concerns** — does the API need to change before the portal can work? are there shared contracts?
- **Unknowns** — anything flagged as "Needs Investigation" or that you can't resolve from reference docs
- **Assumptions** — things the spec assumes but doesn't state explicitly
- **Scope boundaries** — what's in, what's out, what's deferred

Present the topic list to the user. Ask if they want to add or reorder anything.

### Step 3: Discuss Each Topic

For each topic:

1. **Present your understanding** — what the spec says (or doesn't say) about this topic
2. **Make your case** — what you think the right approach is, or what questions need answering
3. **Prompt the user** — ask a specific question, not an open-ended "thoughts?"
4. **Iterate** — continue the back-and-forth until you're both satisfied
5. **Record** — update the spec with the agreed-upon resolution

If a topic can't be resolved (neither party has enough information):
- Flag it as a **"Needs Investigation"** item in the spec
- Note what information is needed and who/what might provide it (user research, exploration agent, child agent during implementation)
- Move on — don't spin on unknowns

### Step 4: Review and Sign-off

After all topics are discussed:

1. Summarize what changed in the spec
2. List any "Needs Investigation" items that remain open
3. Ask the user: "Is this spec ready for dispatch, or do we need another session after the open items are resolved?"
4. If ready — mark the spec as signed off (add a sign-off line with date)
5. If not — the spec stays as a living draft for the next session

---

## Discussion Behavior Guide

### DO:
- Reference the project's `ECOSYSTEM.md` for architectural context
- Reference the project's `API_CONTRACTS.md` for existing contracts
- Reference the project's `DOMAIN_LANGUAGE.md` for terminology
- Ask "what happens when..." questions
- Challenge vague language ("handle gracefully" — what does that mean specifically?)
- Suggest alternatives when you see trade-offs
- Point out when a requirement might conflict with existing behavior
- Ask about the user's priorities when trade-offs exist

### DON'T:
- Read source code from sub-projects
- Suggest specific implementation approaches (that's the child agent's job)
- Rush through topics to get to dispatch
- Assume you know the answer — ask
- Skip edge cases because they seem unlikely
- Add technical implementation notes yourself — prompt the user to provide them

### When the user provides technical notes:
- Capture them in the spec's technical notes section exactly as provided
- You may ask clarifying questions about the notes
- You do NOT evaluate or second-guess the technical approach — the user is the technical architect

---

## Spec Sections to Ensure

By the end of the discussion, the spec should have:

- [ ] **Summary** — what this feature does, in plain language
- [ ] **Business rules** — explicit, unambiguous, testable
- [ ] **Affected projects** — which sub-projects need changes
- [ ] **Cross-project dependencies** — order of operations, shared contracts
- [ ] **Testable acceptance criteria** — clear enough to derive tests from
- [ ] **Technical notes** — from the user, not the hub
- [ ] **Needs Investigation** — open items with context on what's needed
- [ ] **Out of scope** — explicitly deferred items

---

## Skill Contents

```
spec-discuss/
└── SKILL.md
```
