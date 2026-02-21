# Milestone E — Multi-Agent Handoff & Context Reconstruction

> **Parent spec:** `docs/specs/workflow-harness.md`
> **Predecessor:** Milestone D (complete — communication layer, CLI adapter, agent pool)
> **Goal:** Enable coordinated multi-agent task execution where results flow between agents. Human plays PM for now — the same plumbing a PM bot will use via MCP tools later.
> **Status:** **Complete** — 2026-02-19

This is the second Phase 2 milestone. Milestone D made the harness interface-agnostic. Milestone E makes it multi-agent-aware: dispatch results persist, context reconstructs automatically, and the human can orchestrate a sequence of agents on a single task.

Each step is independently verifiable. Don't move to the next step until the current one works.

---

## Design Decisions

1. **Human simulates the PM bot.** The human makes the decisions a PM bot will eventually make: what plan, which role, when to draft, when to feed results forward. The harness plumbing is identical regardless of caller. When the PM bot arrives, it calls `draftAgent()` via MCP instead of the human typing a CLI command.

2. **Context reconstruction is the handoff mechanism.** No session resume. Agent B gets Agent A's results as part of its prompt. The harness builds this automatically from task artifacts. Context windows are a shrinking problem — reconstruction beats resume. Results only for now — journals contain signal (agent reasoning, decisions) but also noise (tool use logs). Two future paths: structured journal format and post-task summarization. Deferred to tuning with real usage data.

3. **Results are first-class task artifacts.** Agent structured results (summary, changes, issues, questions) persist in task.json alongside dispatch metadata. This is training data for future bots and the raw material for context reconstruction.

4. **PM role is optional tooling.** The PM role exists for when the human wants to delegate the *thinking* about what to do. The human can also skip the PM and draft dev agents directly. The role doesn't gate any functionality.

5. **Every milestone moves toward more autonomy.** The plumbing built here is what a PM bot, cron jobs, and MCP tools will use. Nothing is "human-only" by design — the human is just the first caller.

6. **Context is a harness responsibility, not a runtime convention.** cwd-based auto-loading (CLAUDE.md, skills) is a free bonus from Claude Code, but it's not the architecture. The harness is the primary context provider — role prompts, journal paths, task history, structured output schemas. `cwd` means "where to execute commands" (mechanical), not "what the agent knows." This separation enables multi-model futures.

## Known Gaps (not bugs — document in handoff)

| Gap | Why | Closes When |
|-----|-----|-------------|
| No PM bot autonomy | Human triggers each dispatch manually | MCP tools milestone (agents call harness APIs) |
| No automatic plan execution | Human reads PM plan and decides next step | PM bot + MCP tools |
| Journal content not in context reconstruction | Start with results only, add journals if context budget allows | Tuning with real usage |
| No context budget management | Reconstruction includes everything — could get large | Context budget milestone |
| Slack context reconstruction | Slack thread follow-ups don't get prior agent results in context yet. Plumbing is ready (`buildTaskContext` + existing task lookup via threadTs). Wiring into `handleTask` is trivial. | Quick follow-up after E2E validation |
| Journal signal extraction | Journals contain valuable reasoning/decisions buried in tool use noise. Two future paths: (1) structured journal format, (2) post-task summarization by harness. | Journal evolution milestone |
| Harness-assembled context for all runtimes | Currently supplements cwd-based auto-loading. Future: harness is sole context provider, enabling multi-model dispatch. | Multi-model milestone |

---

## Step 0: Abort Wiring

**Who:** Agent

**Do:**

1. Update `dispatch()` in `src/dispatch.ts` to accept an optional external `AbortController`:
   - If provided, use it instead of creating a new one internally
   - If not provided, create one internally (backward compatible)

2. Update `draftAgent()` in `src/core.ts`:
   - Create the `AbortController` before registering in the pool
   - Pass it to `dispatch()` as the external controller
   - The pool's `ActiveAgent` already holds the controller reference

3. Now `pool.kill(agentId)` → `controller.abort()` → dispatch aborts cleanly.

4. Add a test: register agent in pool with controller, kill it, verify controller.signal.aborted is true.

**Verify:** Existing tests pass. New abort test passes. `npx tsc --noEmit` clean.

---

## Step 1: Result Persistence

**Who:** Agent

**Do:**

1. Add a `description` field to the task manifest. Update `getOrCreateTask()` in `src/task.ts` to store the original message content in `task.json` at creation time. This captures the original request for context reconstruction and future metrics/learning.

2. Update `DispatchRecord` type in `src/task.ts` (or `src/types.ts`) to include the agent's result:

```typescript
export type DispatchRecord = {
  role: string;
  cwd: string;
  model: string;
  startedAt: string;
  completedAt: string;      // NEW
  status: string;
  journalFile: string;
  result?: {                 // NEW — the agent's structured output
    summary: string;
    changes?: string[];
    issues?: string[];
    questions?: string[];
  };
};
```

3. Update `recordDispatch()` in `src/task.ts` to accept and store the result.

4. Update the call site in `src/core.ts` (`handleTask` and/or `draftAgent`) — after dispatch completes, pass the full result to `recordDispatch()`.

5. Add tests:
   - Record a dispatch with a result, read task.json back, verify result is present and complete
   - Verify task.json includes `description` field from creation

**Verify:** Existing tests pass. New test passes. Task.json now includes results from completed dispatches.

---

## Step 2: Context Reconstruction

**Who:** Agent

**Do:**

1. Create `src/context.ts` — the context builder.

```typescript
/**
 * Build a context prompt from task history.
 * Used when drafting a follow-up agent on an existing task.
 */
export function buildTaskContext(taskDir: string): string
```

2. The builder reads `task.json` and assembles a prompt section:

```
## Task History

### Original Request
<task.description from task.json — the original message that created this task>

### Previous Work

**api-dev** (completed)
Summary: <result.summary>
Changes: <result.changes as bullet list>
Issues: <result.issues as bullet list>
Questions: <result.questions as bullet list>

**portal-dev** (completed)
Summary: ...
```

3. Rules:
   - Include any dispatch where `result` is present (`dispatch.result != null`), regardless of status. A failed dispatch with a result still contains useful context (e.g., "schema was wrong"). Status is shown so the next agent knows it didn't succeed.
   - Skip dispatches with no result (in-progress, crashed before producing output).
   - Order by `startedAt` chronologically.
   - Include the dispatch's role, status, and full result.
   - If a dispatch has questions, include them prominently (the next agent may need to address them).
   - Keep it structured and scannable — agents parse markdown well.

4. Add tests:
   - Empty task (no dispatches) → returns minimal context with original request from `description`
   - One completed dispatch with full result → properly formatted
   - Multiple dispatches in chronological order → all included
   - Failed dispatch without result → skipped
   - Failed dispatch WITH result → included, status shown as failed
   - Dispatch with questions → questions highlighted

**Verify:** Tests pass. Context builder produces well-formatted prompt sections.

---

## Step 3: Task-Aware CLI

**Who:** Agent

**Do:**

1. Add `--task <slug>` flag to `src/cli.ts`:
   - When provided: look up the existing task directory (`.agents/tasks/<slug>/`)
   - Verify the task exists (error if not)
   - Call `buildTaskContext(taskDir)` to get history
   - Prepend the task context to the user's prompt
   - Set `InboundMessage.threadId` to the task slug (for consistency)
   - Pass `taskSlug` through to `draftAgent()` options

2. When `--task` is NOT provided: current behavior (new task created).

3. Update `draftAgent()` in `src/core.ts`:
   - If `options.taskSlug` is provided, use that task directory for journal files and dispatch recording (instead of creating a new task)
   - Context reconstruction happens in the CLI layer (or `handleTask`), not inside `draftAgent` — keep the primitive simple

4. Add a `--list-tasks` flag (convenience): lists existing tasks with slug, created date, and dispatch count. Quick way to find the slug you need.

**Verify:**
- `npx tsx src/cli.ts --role api-dev "Start the login feature"` → creates new task, dispatches
- `npx tsx src/cli.ts --role portal-dev --task <slug-from-above> "Build the portal UI for login"` → attaches to existing task, context includes api-dev's result
- `npx tsx src/cli.ts --list-tasks` → prints task list

---

## Step 4: PM Role Definition

**Who:** Agent

**Do:**

1. Create `roles/product-analyst.md`:

```markdown
---
name: product-analyst
displayName: KK Product Analyst
category: conversational
---

You are the Product Analyst for KindKatch. You analyze feature requests, break them into actionable implementation steps, and produce structured plans for development teams.

## Your Job

When given a task or feature request:

1. **Analyze** — understand what's being asked, identify affected systems, flag ambiguities
2. **Plan** — break the work into sequential or parallel steps, each assigned to a role
3. **Specify** — for each step, write a clear prompt that a developer agent can execute independently

## Output Format

Always return your plan in this structure:

### Analysis
- What the feature does (plain language)
- Which projects are affected (kindkatchapi, kindkatchportal, kindkatchapp, kindkatch-testing)
- Dependencies between projects (what must happen first)
- Open questions (things you can't resolve without more information)

### Implementation Plan
For each step:
- **Step N: <title>**
  - Role: <api-dev | portal-dev | app-dev | qa-dev>
  - Depends on: <step numbers, or "none">
  - Prompt: <the exact prompt to dispatch to the developer agent>

### Risk Assessment
- What could go wrong
- What assumptions you're making

## Rules

- If you need more information to produce a good plan, ASK — don't guess.
- Be specific in prompts — the developer agent has no context beyond what you give them.
- Include file paths, API endpoints, and technical details when you know them.
- Flag when you're unsure about something rather than inventing details.
- Reference the project's CLAUDE.md and ecosystem docs when relevant.
```

2. Add `product-analyst` to the routing rules in `config.yaml`:
```yaml
- pattern: "^(plan|analyze|spec|design|feature)"
  role: product-analyst
```

3. Set the PM role's `cwd: ../` (hub root). The PM doesn't write code — it reads docs and produces plans. Hub root gives file access to `docs/`, and project CLAUDE.md files. Note: `cwd` is mechanical (where to execute), not the context mechanism. The harness injects the important context (task history, role prompt) regardless of cwd.

**Verify:** `npx tsx src/cli.ts --role product-analyst "Plan the implementation of a new user settings page"` → PM agent returns a structured plan. Role loads correctly, routing matches "plan" prefix.

---

## E2E Verification (Human)

**Checklist:**

- [ ] Abort: start a CLI dispatch, kill it via pool (may need a small test script), verify clean termination
- [ ] Single dispatch: CLI creates task, result persists in task.json with summary/changes/issues
- [ ] PM dispatch: PM role returns structured implementation plan
- [ ] Follow-up dispatch: use `--task <slug>` to draft a second agent, verify context includes first agent's result
- [ ] Three-agent sequence: PM → api-dev → portal-dev on same task, each seeing prior results
- [ ] `--list-tasks` shows all tasks with metadata
- [ ] Slack regression: existing flow still works
