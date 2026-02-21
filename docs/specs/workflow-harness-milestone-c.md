# Milestone C — Smarter, Multi-Project, Hardened

> **Parent spec:** `docs/specs/workflow-harness.md`
> **Milestone B handoff:** `docs/archive/milestones/harness-milestone-b-handoff.md`
> **Research:** `.agents/research/clawdbot/FINDINGS.md`
> **Goal:** Unlock all sub-projects from Slack, harden error handling, introduce the task abstraction.

Each step is independently verifiable. Don't move to the next step until the current one works.

---

## Design Decisions (from planning meeting 2026-02-19)

These decisions were made during the Milestone C spec-discuss session. Coding agents should treat them as constraints, not suggestions.

1. **Stream-edit dropped.** Slack is passive — ack, result, questions. The stream-edit pattern (live-updating messages) is an OpenClaw pattern for active chatbot UX. Our Slack model is different: mostly quiet, PM bot surfaces what matters. Verbose activity goes to journals/task logs. "Slack drives our MVP, not our architecture."

2. **Hybrid `cwd` model.** Roles have an optional `cwd` (default project). Routing rules have an optional `cwd` (override). Resolution: `rule.cwd → role.cwd → error("no cwd")`. This makes roles reusable skill profiles while keeping per-project routing simple. Generic-ready from day one — separate role files for now, but the plumbing supports any project.

3. **Task is the unit of persistence.** A Slack thread maps to a task. First message in a thread creates the task (generates slug, creates `task.json`). Follow-up messages in the same thread are continuations. Journals group by task: `{task-slug}/{role}.md`, sequenced as `{role}-{n}.md` if same role dispatched twice. This is the seed for bot drafting — when bots arrive, they move into the task abstraction.

4. **Mechanical config stays in the harness.** Model selection, maxTurns, maxBudgetUsd, inactivity timeouts — these are harness mechanics, not agent identity. Category drives them. Roles, skills, and bot definitions never specify these. The harness decides, informed by data eventually.

5. **Ping-pong thresholds: warn at 6, kill at 8.** Longer leash than genericRepeat (warn 3, kill 5) because alternating patterns are more ambiguous — legit read-edit-read-edit cycles exist. Warning gives the agent a chance to break the pattern.

6. **Non-retryable errors need new event loop plumbing.** Today the dispatch event loop only inspects `assistant` messages (tool_use blocks). Tool *results* (including errors) arrive on `user` messages, which we currently skip. Step 5 requires adding `user` message handling to capture error results.

7. **Debounce: first message is the anchor.** React with 👀 on the first message only. Follow-ups within the debounce window get no reaction. Thread anchors on the first message. Dispatch ack and result post in that thread.

8. **Every data point is training data.** Journals, task manifests, decision records, spec discussions — they're not documentation overhead. They're the raw material bots learn from. More is better. Capture aggressively, curate later.

## Known Gaps (not bugs — document in handoff)

| Gap | Why | Closes When |
|-----|-----|-------------|
| Agent questions posted but loop not closed | No session resume — agent is terminated | Context reconstruction milestone (bots + task memory) |
| No cascading config defaults | Flat config works with 4 roles | Config refactor sprint (~10+ roles) |
| No session resume | Context reconstruction via task.json + journals + bot memory is the path | Bot/team milestone |
| `task.json` is minimal | Seed only — just created/thread_ts/dispatches | Grows as task abstraction matures |
| No PM bot | Human reads Slack directly for now | PM bot milestone |

---

## Step 0: Config Expansion

**Who:** Agent

**Do:**

1. **Add `routing` section to `config.yaml`:**
   ```yaml
   routing:
     default: api-dev
     rules:
       - pattern: "^(portal|frontend|ui)"
         role: portal-dev
       - pattern: "^(test|e2e|playwright)"
         role: qa-dev
       - pattern: "^(api|backend|endpoint)"
         role: api-dev
       - pattern: "^(app|mobile|react.native)"
         role: app-dev
   ```
   Routing rules may optionally include a `cwd` override:
   ```yaml
       - pattern: "^(portal|frontend|ui)"
         role: coding-agent
         cwd: ../kindkatchportal   # override role's default cwd
   ```

2. **Add `slack` section to `config.yaml`:**
   ```yaml
   slack:
     debounceMs: 2000
     reactions:
       received: eyes
       working: hammer
       success: white_check_mark
       failure: x
   ```

3. **Update config Zod schema** in `src/config.ts` to validate both new sections:
   ```typescript
   const RoutingRuleSchema = z.object({
     pattern: z.string(),
     role: z.string(),
     cwd: z.string().optional(),  // override role's default cwd
   });

   const ConfigSchema = z.object({
     models: z.object({
       default: z.string(),
     }),
     categories: z.record(z.object({
       inactivityTimeout: z.number().positive(),
     })),
     routing: z.object({
       default: z.string(),
       rules: z.array(RoutingRuleSchema).default([]),
     }),
     slack: z.object({
       debounceMs: z.number().positive().default(2000),
       reactions: z.object({
         received: z.string(),
         working: z.string(),
         success: z.string(),
         failure: z.string(),
       }),
     }),
   });
   ```

4. **Update startup banner** — show routing rules count, default role, and reaction config.

**Verify:**
- `npm run dev` → config loads with new sections, banner shows routing info
- Invalid routing config → startup fails with clear error
- Missing `slack` section → startup fails with clear error
- `tsc --noEmit` passes
- All existing tests pass

---

## Step 1: Role Definitions for New Projects

**Who:** Agent

**Do:**

1. **Add `cwd` to role frontmatter schema** (optional field):
   ```typescript
   const RoleFrontmatterSchema = z.object({
     name: z.string(),
     displayName: z.string(),
     category: z.string(),
     model: z.string().optional(),
     cwd: z.string().optional(),     // default project directory (relative to hub root)
   });
   ```

2. **Update `RoleDefinition` type** in `src/types.ts` to include optional `cwd`.

3. **Create `harness/roles/portal-dev.md`:**
   ```markdown
   ---
   name: portal-dev
   displayName: KK Portal Dev
   category: coding
   cwd: ../kindkatchportal
   ---

   You are the Portal Dev agent for KindKatch. You work in the `kindkatchportal` project (React, JavaScript, legacy but active).

   ## Journal

   You MUST write progress entries to the journal file at `{journal_path}`.

   Write an entry when you:
   - Start a new section of work
   - Complete a section
   - Hit a blocker or make a significant decision
   - Are about to do something that will take a while (build, test run)

   Format each entry as a new line appended to the `## Log` section:
   ```
   - HH:MM — [agent] <what you did or decided>
   ```

   ## Rules

   - If you get stuck or are unsure about something, report back with your question rather than guessing.
   - Do NOT modify shared components (files imported by multiple features — Flyout.js, Modal, Layout, utilities, context providers) without explicit user approval.
   - Follow the project's CLAUDE.md and existing patterns.
   - Use conventional commits: feat:, fix:, chore:, docs:, refactor:
   ```

4. **Create `harness/roles/qa-dev.md`** — for `kindkatch-testing` project (Playwright, TypeScript). `cwd: ../kindkatch-testing`.

5. **Create `harness/roles/app-dev.md`** — for `kindkatchapp` project (React Native). `cwd: ../kindkatchapp`.

6. **Update `harness/roles/api-dev.md`** — add `cwd: ../kindkatchapi` to frontmatter.

7. **Update `dispatch()`** — resolve `cwd` with the hybrid chain: `DispatchOptions.cwd → role.cwd → error`. Remove `cwd` as a required field in `DispatchOptions`, make it optional.

**Verify:**
- `npm run dev` → banner shows all 4 roles with their cwd paths
- Role frontmatter validates for all roles
- Role without `cwd` + no dispatch override → clear error message
- `tsc --noEmit` passes
- Existing tests pass

---

## Step 2: Dynamic Role Routing + Task Abstraction

**Who:** Agent

**Do:**

### Routing

1. **Create `src/router.ts`:**
   - `resolveRole(message: string, config: Config): string` — tests message against routing rules in order, returns first matching role name or `config.routing.default`
   - Rules are applied in config order (first match wins)
   - Pattern matching uses `RegExp` with case-insensitive flag (`new RegExp(pattern, 'i')`)

2. **Unit tests** in `src/router.test.ts`:
   - Message matches first rule → correct role
   - Message matches no rule → default role
   - Case insensitive matching
   - First-match-wins when multiple rules could match
   - Empty message → default role

### Task Abstraction

3. **Create `src/task.ts`:**
   - `getOrCreateTask(threadTs: string, firstMessage: string): TaskContext` — if a task exists for this thread, return it. Otherwise, create a new task directory and `task.json`.
   - `generateSlug(message: string): string` — extract first meaningful words, slugify (lowercase, hyphens, max 40 chars), append short timestamp suffix: `portal-fix-flyout-0219-1430`
   - `recordDispatch(taskSlug: string, dispatch: DispatchRecord): void` — append a dispatch entry to `task.json`

4. **`task.json` manifest format:**
   ```json
   {
     "slug": "portal-fix-flyout-0219-1430",
     "created": "2026-02-19T14:30:00Z",
     "threadTs": "1708012345.678900",
     "dispatches": [
       {
         "role": "portal-dev",
         "cwd": "../kindkatchportal",
         "model": "claude-sonnet-4-6",
         "startedAt": "2026-02-19T14:30:05Z",
         "status": "completed",
         "journalFile": "portal-dev.md"
       }
     ]
   }
   ```

5. **Task directory location:** `.agents/tasks/{task-slug}/` — separate from journals. Journal files move into the task directory: `.agents/tasks/{task-slug}/{role}.md`. This replaces `.agents/journals/{slug}/{role}.md`.

6. **Ensure `.agents/tasks/` is gitignored.**

### Wiring

7. **Update `slack.ts`:**
   - Replace hardcoded `role: 'api-dev'` with `resolveRole(text, config)`
   - Replace hardcoded `cwd` with resolution from routing rule or role definition
   - Replace hardcoded `featureSlug` with task slug from `getOrCreateTask()`
   - Dispatch notification includes resolved role and project: `"Dispatching to *KK Portal Dev* (kindkatchportal)..."`

8. **Resolve `cwd` with hybrid chain:**
   - Check routing rule for `cwd` override (if the matched rule has one)
   - Fall back to `role.cwd`
   - Error if neither provides a `cwd`

**Verify:**
- DM "portal fix the flyout" → dispatches to portal-dev in `../kindkatchportal`
- DM "api add endpoint" → dispatches to api-dev in `../kindkatchapi`
- DM "something random" → dispatches to default role (api-dev)
- Slack notification shows which role/project was selected
- `task.json` created in `.agents/tasks/{slug}/`
- Second dispatch in same thread → same task slug, dispatch appended to `task.json`
- Journal files land in the task directory
- `tsc --noEmit` passes
- All tests pass (router + existing)

---

## Step 3: Configurable Reactions + Cleanup

**Who:** Agent

**Do:**

1. **Read reactions from config** in `slack.ts`:
   - Replace all hardcoded emoji names (`eyes`, `hammer`, `white_check_mark`, `x`) with `config.slack.reactions.*`
   - Type-safe access via the updated Zod schema from Step 0

2. **Remove intermediate reactions on completion:**
   - Before adding the final reaction (success or failure), call `reactions.remove` for `received` and `working` reactions
   - Use try/catch — removal failure is non-fatal (reaction may already be removed, or message may not have that reaction)
   - Order: remove `working` → remove `received` → add `success`/`failure`

3. **Reaction lifecycle:**
   ```
   Message received  →  +received
   Dispatch starts   →  +working, -received
   Dispatch succeeds →  +success, -working
   Dispatch fails    →  +failure, -working
   ```
   Only the final reaction (success or failure) remains on the message.

**Verify:**
- DM the bot → 👀 appears → 🔨 appears, 👀 removed → ✅ appears, 🔨 removed
- Only the final reaction remains on the message
- Change reactions in `config.yaml` → restart → new emojis used
- Reaction removal failure doesn't crash the harness
- `tsc --noEmit` passes

---

## Step 4: Ping-Pong Loop Detection

**Who:** Agent

**Do:**

1. **Add `pingPong` pattern to `detectErrorLoop()` in `src/monitor.ts`:**
   - Check if the last N tool calls alternate between exactly 2 `tool::target` pairs
   - Pattern: `[A, B, A, B, A, B]` where A ≠ B
   - Warning at 3 alternations (6 calls), kill at 4 alternations (8 calls)
   - Return `{ type: 'pingPong', pattern: 'Read::foo.ts ↔ Edit::foo.ts', count, severity }`

2. **Update `LoopDetection` type** — add `type: 'genericRepeat' | 'pingPong'` field:
   ```typescript
   export type LoopDetection = {
     type: 'genericRepeat' | 'pingPong';
     pattern: string;
     count: number;
     severity: 'warning' | 'kill';
   };
   ```

3. **Detection priority:** Check `genericRepeat` first (existing), then `pingPong`. Return the first detection found (a window can only match one pattern at a time for simplicity).

4. **Unit tests** added to `src/monitor.test.ts`:
   - A→B→A→B→A→B (6 calls) → warning with type `pingPong`
   - A→B→A→B→A→B→A→B (8 calls) → kill with type `pingPong`
   - A→B→A→C (broken alternation) → null
   - A→A→A (not ping-pong, caught by `genericRepeat`)
   - Mixed: non-alternating calls interspersed → null (pattern broken)

**Verify:**
- All existing tests still pass (genericRepeat unchanged)
- New ping-pong tests pass
- `tsc --noEmit` passes

---

## Step 5: Non-Retryable Error Classification

**Who:** Agent

**Do:**

### New Event Loop Plumbing

1. **Add `user` message handling** to the dispatch event loop in `dispatch.ts`:
   - Currently only `msg.type === "assistant"` and `msg.type === "system"` are handled
   - Add `msg.type === "user"` branch
   - Iterate `msg.message.content` looking for `tool_result` blocks
   - Identify error results (check for `is_error: true` or error-like content — inspect SDK types for the exact shape)
   - For each error result, record an `ErrorTriplet`

2. **Note for coding agent:** The SDK's `user` message type and `tool_result` block structure may need investigation. Check `@anthropic-ai/claude-agent-sdk` types for the exact shape of user messages and tool result blocks. If `user` messages are not emitted by the SDK event stream, document this as a gap and use an alternative approach (e.g., inferring errors from assistant messages that reference previous failures).

### Detection

3. **Add types to `src/types.ts`:**
   ```typescript
   export type ErrorTriplet = {
     tool: string;
     target: string;
     errorSnippet: string;  // first 200 chars, whitespace-normalized
     timestamp: number;
   };

   export type NonRetryableDetection = {
     tool: string;
     target: string;
     errorSnippet: string;
     count: number;
   };
   ```

4. **Add `detectNonRetryable()` to `src/monitor.ts`:**
   - `detectNonRetryable(recentErrors: ErrorTriplet[]): NonRetryableDetection | null`
   - If the same `(tool, target, errorSnippet)` appears 2+ times → return detection
   - Comparison uses exact match on all three fields (errorSnippet already truncated/normalized)

5. **Integrate into dispatch:**
   - Maintain a separate error sliding window (max 20 entries)
   - Call `detectNonRetryable()` after each error triplet is pushed
   - On detection: set `abortReason = 'non_retryable_error'`, abort, post to Slack with explanation, update journal

6. **Unit tests** in `src/monitor.test.ts`:
   - Same triplet once → null
   - Same triplet twice → detection
   - Different errors for same tool+target → null
   - Same error, different tools → null
   - Same error, different targets → null

**Verify:**
- Unit tests pass
- `tsc --noEmit` passes
- Existing tests pass
- If SDK doesn't emit user messages, the gap is documented and an alternative is implemented

---

## Step 6: Input Debouncing

**Who:** Agent

**Do:**

1. **Add debounce logic to `slack.ts` message handler:**
   - When a DM arrives, start a timer (`config.slack.debounceMs`, default 2000ms)
   - If another message arrives for the same thread (or same DM conversation) within the window, reset timer and concatenate the new message
   - After the timer expires (no new messages), dispatch the combined text
   - Add `received` reaction on the **first** message only (immediate — before debounce timer)
   - Follow-up messages within the debounce window get no reaction

2. **Debounce state management:**
   - Map of `threadTs → { messages: string[], timer: NodeJS.Timeout, firstMessageTs: string }`
   - On new message: check map. If entry exists, clear timer, append message, restart timer. If not, create entry, add reaction, start timer.
   - On timer expiry: join messages with `\n`, dispatch, remove entry from map.

3. **Thread key determination:**
   - If message is in a thread: use `thread_ts` as key
   - If message is a top-level DM: use `ts` as key (it becomes its own thread anchor)

4. **Edge cases:**
   - Single message (no follow-up) → dispatches after debounce delay (acceptable)
   - Three rapid messages → concatenated with `\n`, single dispatch
   - Messages from different threads → independent debounce timers
   - Very long combined message → no truncation (Slack already limits input)

**Verify:**
- Send one message → dispatches after ~2s delay
- Send 3 messages in rapid succession → combined into one dispatch, single reaction on first message
- Messages in different threads debounce independently
- `tsc --noEmit` passes

---

## Step 7: End-to-End Verification

**Who:** Human

**Test scenarios:**

### Multi-project routing
- [ ] DM "portal list the components" → dispatches to portal-dev / kindkatchportal
- [ ] DM "api read the CLAUDE.md" → dispatches to api-dev / kindkatchapi
- [ ] DM "test check the config" → dispatches to qa-dev / kindkatch-testing
- [ ] DM "do something" → dispatches to default role (api-dev)
- [ ] Dispatch notification shows resolved role name and project

### Task abstraction
- [ ] First DM creates `.agents/tasks/{slug}/task.json` with correct metadata
- [ ] Journal files land in the task directory (not `.agents/journals/`)
- [ ] Second dispatch in same thread → same task slug, new dispatch appended to `task.json`
- [ ] New top-level DM → new task slug, new directory
- [ ] Slug is readable and unique (e.g., `portal-fix-flyout-0219-1430`)

### Reactions
- [ ] 👀 on receive → 🔨 on dispatch (👀 removed) → ✅ on success (🔨 removed)
- [ ] Only final reaction remains on the message
- [ ] Reactions match `config.yaml` values
- [ ] Changed reactions in config → restart → new emojis used

### Input debouncing
- [ ] Single message dispatches after ~2s delay
- [ ] Three rapid messages combine into one dispatch
- [ ] Only first message gets 👀 reaction
- [ ] Different threads debounce independently

### Error handling
- [ ] Ping-pong loop (A→B→A→B→A→B) → warning at 6 calls
- [ ] Ping-pong continues (8 calls) → kill
- [ ] Non-retryable error (same tool+target+error twice) → kill
- [ ] Both produce clear Slack messages explaining what happened
- [ ] Journal status updated on error kills

### Regression
- [ ] All unit tests pass (existing + new router, ping-pong, non-retryable)
- [ ] Config validation catches bad routing/reactions/slack config
- [ ] Startup banner shows: routing rules count, default role, all roles (4), reaction config
- [ ] Structured output still parsed and formatted correctly
- [ ] GenericRepeat loop detection still works at existing thresholds
- [ ] Stall timer still uses category timeout from config
- [ ] Budget and maxTurns limits still enforced

---

## What's NOT in Milestone C

Deferred — don't scope-creep:

- Session resume / context reconstruction (bot + task memory milestone)
- Cascading config defaults (config refactor sprint, ~10+ roles)
- Bot definitions / persistent personalities (bot/team milestone)
- PM bot (future milestone)
- Stream-edit Slack pattern (may return for PM bot conversations)
- Skill graphing / dynamic skill loading (research sprint first)
- OpenTelemetry observability (future)
- Per-channel routing config (dynamic routing covers 80% case)
- Block Kit interactive elements (future)
- Multi-user support (single user for now)
- Hot-reload config (restart is fine)
- Parallel concurrent dispatches (sequential for now)
- `#agent-ops` channel logging

---

## Vision Context (for future agents)

This section captures strategic context from the Milestone C planning session. It is NOT scope for this milestone — it informs design decisions so we don't paint ourselves into corners.

**We are building a team, not a workflow tool.** The harness is home base for humans and agents. KindKatch feature requests are one workflow, not THE workflow. The harness will eventually support research, learning, collaboration, and conversation.

**The bot abstraction is coming.** Above roles sits the bot — a persistent identity with personality, motivations, experience, and memories. The hierarchy: Bot (WHO/WHY) → Role (WHAT) → Skills (HOW). A bot gets drafted for a task, assigned a role, loaded with skills, and returns to the pool richer for the experience. This is how we solve the fundamental problem of agents lacking taste, soul, and diversity of thought.

**Mechanical vs organic separation.** Model selection, maxTurns, budget, timeouts — these are mechanical, harness-controlled, data-driven eventually. They never live in role, skill, or bot definitions. The harness decides. Roles, skills, and bots define identity and capability, not infrastructure.

**Context reconstruction over session resume.** Worker bots don't need to resume SDK sessions. They need to understand what happened and continue. Task manifests + journals + bot memory = rich context reconstruction. Context windows are a shrinking problem (Moore's Law for compute). Design for external context management.

**Every data point is training data.** Journals, task manifests, decision records, spec discussions, research — they're the mana of our bots. Capture aggressively, curate later. Document bloat is acceptable; lost context is not.

---

## Environment Notes for Coding Agents

Same as Milestone B — see that spec's environment section. Additionally:

1. **New roles must specify `cwd`** — the project directory relative to hub root (optional in schema, but required for dispatch)
2. **Portal safety rule** — portal-dev role prompt MUST include the shared component warning (see role file)
3. **Routing patterns are case-insensitive** — compiled with `RegExp(pattern, 'i')`
4. **Slack API methods used:** `reactions.add`, `reactions.remove`, `chat.postMessage`, `chat.update`
5. **Task directories at `.agents/tasks/`** — gitignored, created on first dispatch
6. **Journal files move from `.agents/journals/` to `.agents/tasks/{slug}/`** — update journal.ts paths accordingly
7. **If you get stuck or are unsure about something, report back with your question rather than guessing.**

---

**Spec sign-off:** 2026-02-19 — Approved via /spec-discuss session.
