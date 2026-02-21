# Milestone E Handoff — Multi-Agent Handoff & Context Reconstruction

**Date:** 2026-02-19
**Branch:** `workflow-v2`
**Commit:** `fc5d2fa`
**Tests:** 68 passing (was 50), tsc clean
**E2E:** All human tests passed (CLI dispatch, PM role, follow-up dispatch with context, --list-tasks, Slack regression)

---

## What Was Built

Milestone E makes the harness multi-agent-aware. Agents can now work in sequence on the same task, with each agent automatically receiving the results of all prior agents as part of its prompt.

### Step 0: Abort Wiring
- `dispatch()` now accepts an optional external `AbortController`
- `draftAgent()` creates the controller before pool registration and passes it to dispatch
- `pool.kill(agentId)` -> `controller.abort()` -> dispatch aborts cleanly
- Closes the known gap from Milestone D

### Step 1: Result Persistence
- `task.json` now includes a `description` field (the original request text)
- `DispatchRecord` gained `completedAt` and `result` fields
- `result` contains: `summary`, `changes[]`, `issues[]`, `questions[]`
- Structured agent output is mapped to the dispatch record after each dispatch

### Step 2: Context Reconstruction
- New `src/context.ts` with `buildTaskContext(taskDir)` function
- Reads task.json, assembles a markdown prompt section with:
  - Original request
  - All prior dispatch results (filtered: `result != null`, ordered chronologically)
  - Status shown per dispatch (so follow-up agents know what succeeded/failed)
  - Empty sections omitted (no blank "Changes:" when there are none)
- Failed dispatches WITH results are included (useful context like "schema was wrong")
- Failed dispatches WITHOUT results are skipped (crashed before producing output)

### Step 3: Task-Aware CLI
- `--task <slug>` flag: attaches to existing task, prepends context reconstruction to prompt
- `--list-tasks` flag: shows task inventory (slug, created date, description, dispatch count)
- `handleTask` supports existing task reuse via `metadata.taskSlug`
- Validation: helpful error messages when task doesn't exist, suggests `--list-tasks`

### Step 4: PM Role Definition
- `roles/product-analyst.md` with `category: conversational`, `cwd: ../`
- Routing rule: `^(plan|analyze|spec|design|feature)` -> `product-analyst`
- Role produces structured plans (Analysis, Implementation Plan, Risk Assessment)
- PM is optional tooling — human can skip it and draft dev agents directly

---

## Files Changed

### New Files
| File | Purpose |
|------|---------|
| `harness/src/context.ts` | Context reconstruction builder |
| `harness/src/context.test.ts` | 7 tests for context builder |
| `harness/src/task.test.ts` | 8 tests for task/dispatch persistence |
| `harness/roles/product-analyst.md` | PM role definition |
| `docs/specs/workflow-harness-milestone-e.md` | Milestone spec |
| `docs/specs/dispatch-prompts/milestone-e-full.md` | Dispatch prompt |

### Modified Files
| File | Change |
|------|--------|
| `harness/src/types.ts` | Added `abortController` to `DispatchOptions` |
| `harness/src/dispatch.ts` | Uses external `AbortController` when provided |
| `harness/src/core.ts` | Abort wiring, result persistence, existing task reuse |
| `harness/src/task.ts` | `description` on manifest, `completedAt`/`result` on dispatch record, exported `TaskManifest` |
| `harness/src/cli.ts` | `--task`, `--list-tasks` flags, context prepending |
| `harness/src/pool.test.ts` | +1 test (abort propagation) |
| `harness/src/roles.test.ts` | +1 test (product-analyst parsing) |
| `harness/src/router.test.ts` | +1 test (plan prefix routing) |
| `harness/config.yaml` | Added product-analyst routing rule |

---

## Design Decisions Made During Implementation

1. **Type naming:** Named the result type `DispatchRecordResult` (not `DispatchResult`) to avoid collision with the existing `DispatchResult` in `types.ts`.
2. **Context separator:** CLI prepends task context with a `\n---\n\n` separator between history and the new instruction for visual clarity.
3. **Task reuse via metadata:** `handleTask` detects existing tasks via `metadata.taskSlug` rather than adding a new parameter — keeps the `InboundMessage` interface stable and backwards compatible.
4. **Result mapping:** Only `summary`, `changes`, `issues`, `questions` are persisted to dispatch records. `pr_url` and `status` from `AgentResult` are excluded — they're agent-internal metadata, not useful for context reconstruction.
5. **Routing order:** Product-analyst routing rule placed first in config.yaml (before portal/api/etc.) so "feature" prefix isn't caught by other rules.

---

## Known Gaps (from spec — documented, not bugs)

| Gap | Why | Closes When |
|-----|-----|-------------|
| No PM bot autonomy | Human triggers each dispatch manually | MCP tools milestone |
| No automatic plan execution | Human reads PM plan and decides next step | PM bot + MCP tools |
| Journal content not in context reconstruction | Start with results only | Tuning with real usage |
| No context budget management | Reconstruction includes everything | Context budget milestone |
| Slack context reconstruction | Slack follow-ups don't get prior agent results yet. Plumbing ready. | Quick follow-up wiring |
| Journal signal extraction | Journals have reasoning buried in tool noise | Journal evolution milestone |

---

## Documentation Catch

**CLAUDE.md milestone table is stale.** Currently shows:
- Milestone C as "In Progress" (it's been complete since 2026-02-19)
- Milestones D and E are not listed at all

Should be updated to:

| Milestone | Status | Spec | Summary |
|-----------|--------|------|---------|
| A | Complete | `docs/specs/workflow-harness-milestone-a.md` | Foundation: Slack bot, config, roles, basic dispatch |
| B | Complete | `docs/specs/workflow-harness-milestone-b.md` | Workflow works: SDK dispatch, journals, structured output, error loop detection |
| C | Complete | `docs/specs/workflow-harness-milestone-c.md` | Multi-project routing, task abstraction, ping-pong detection, non-retryable errors, input debouncing |
| D | Complete | `docs/specs/workflow-harness-milestone-d.md` | Communication layer, CLI adapter, agent pool |
| E | Complete | `docs/specs/workflow-harness-milestone-e.md` | Multi-agent handoff, context reconstruction, task-aware CLI, PM role |

---

## Test Counts by File

| Test File | Tests | Coverage |
|-----------|-------|----------|
| `config.test.ts` | 11 | Config schema validation |
| `context.test.ts` | 7 | Context reconstruction formatting |
| `debounce.test.ts` | 5 | Input debouncing |
| `monitor.test.ts` | 17 | Error loop + non-retryable detection |
| `pool.test.ts` | 7 | Agent pool + abort propagation |
| `roles.test.ts` | 4 | Frontmatter parsing |
| `router.test.ts` | 9 | Routing resolution |
| `task.test.ts` | 8 | Task creation, result persistence, slug gen |
| **Total** | **68** | |

---

## What's Next

Phase 2 continues. The plumbing for multi-agent coordination is in place. Natural next steps:

1. **Slack context reconstruction wiring** — trivial follow-up. `buildTaskContext` exists, just need to wire it into `handleTask` for Slack thread follow-ups.
2. **MCP tools** — expose `draftAgent()`, `pool.list()`, `pool.kill()` as MCP tools so agents can call the harness programmatically.
3. **PM bot autonomy** — PM reads its own plan, calls `draftAgent()` for each step, feeds results forward. The plumbing is identical to what the human does via CLI today.
4. **Context budget management** — as task histories grow, reconstruction needs to be selective. Summarization, recency weighting, role relevance filtering.
5. **MEMORY.md update** — add Milestone E status, key decisions, and any new patterns discovered.
