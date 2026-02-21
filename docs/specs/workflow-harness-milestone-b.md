# Milestone B — The Workflow Works

> **Parent spec:** `docs/specs/workflow-harness.md`
> **Tech notes:** `docs/specs/workflow-harness-tech-notes.md`
> **Milestone A handoff:** `docs/archive/milestones/harness-milestone-a-handoff.md`
> **Goal:** The hub dispatches real sub-project work and reports back.

Each step is independently verifiable. Don't move to the next step until the current one works.

## Design Decisions (from planning meeting 2026-02-18)

These decisions were made during the Milestone B planning session. Coding agents should treat them as constraints, not suggestions.

1. **Session resume / conversational agents deferred** — not in this milestone
2. **Hardcoded test dispatch** — no command routing or message parsing. DM triggers a canned dispatch.
3. **Hardcoded feature slug** — `"milestone-b-test"` for all test dispatches
4. **Journal watcher is internal plumbing** — monitors for health, logs changes. Does NOT post to Slack. The PM agent (future milestone) is the bridge between journals and Slack.
5. **Role prompts use `{journal_path}` placeholder** — harness fills it in at dispatch time. Agent never sees the placeholder. Tools over tokens.
6. **Harness creates journal before spawning agent** — path is guaranteed valid when agent starts.
7. **Two journal channels:** Tool use events from SDK stream = harness ground truth (guaranteed). Agent journal entries = best-effort narrative for PM/humans (not validated).
8. **Structured output with graceful fallback** — Zod validates, but malformed output = plain text fallback, not a crash.
9. **Error loop: warn at 3, kill at 5** — build the `humanRespondedSinceWarning` check even though it's always false until session resume exists.
10. **Project paths relative to hub root** for now. Flagged as future abstraction point when harness becomes project-agnostic.
11. **Slack output is minimal** — dispatch notification, completion summary, agent questions. Nothing else. Worker agents don't chat in Slack.
12. **`HARNESS_VERBOSE` env var** — gates heartbeat logging and future verbose features. Easier than CLI flags with `tsx watch`.

## Known Gaps (not bugs — document in handoff)

These are intentional scope boundaries. Each one is tracked for a future milestone.

| Gap | Why | Closes When |
|-----|-----|-------------|
| Agent questions posted but loop not closed | No session resume — agent is terminated when questions surface | Session resume milestone |
| Hardcoded test dispatch | No routing/command system | Command routing milestone |
| Project path resolution is hub-relative | Works for KK; not portable to other projects | Harness generalization milestone |
| Agent journal writes are best-effort | Can't force agent compliance; harness entries are ground truth | Operational — tune role prompts with data |
| Journal watcher is internal only | PM agent is the intended Slack-facing consumer | PM agent / session resume milestone |

---

## Step 0: Harness QoL

**Who:** Agent

**Input:** Current `src/index.ts`, `package.json`.

**Do:**

1. **Startup banner** — print before the first pino log line. Include:
   - Small ASCII art (agent's creative choice — keep it compact, nothing obnoxious)
   - Harness version (read from `package.json`)
   - Node.js version (`process.version`)
   - Platform (`process.platform`)
   - Environment: `HARNESS_VERBOSE` status, Slack connection status (after connect)
   - Later steps will add to this: config file status, roles loaded count + names

2. **Heartbeat logger** — `setInterval` at 60 seconds:
   - Logs a single structured pino line at `debug` level: `{ uptime_s, agents_active, agents_total }`
   - Gated behind `HARNESS_VERBOSE=true` env var (read from `.env`)
   - Cleared on graceful shutdown (add to the existing `shutdown()` function)
   - Zero API calls, zero cost — purely local

3. **Update `.env.example`** — document `HARNESS_VERBOSE` with description

**Verify:**
- `npm run dev` → banner prints first, then pino logs
- With `HARNESS_VERBOSE=true` → heartbeat appears every 60s in logs
- Without `HARNESS_VERBOSE` → no heartbeat
- Banner shows correct version, node version, platform

---

## Step 1: Config System

**Who:** Agent

**Input:** Spec section: Agent Categories. Tech notes: Configuration.

**Do:**

1. Create `harness/config.yaml`:
   ```yaml
   models:
     default: claude-sonnet-4-6

   categories:
     coding:
       inactivityTimeout: 300
     conversational:
       inactivityTimeout: 180
     research:
       inactivityTimeout: 420
   ```

2. Create `src/config.ts`:
   - Load `config.yaml` from the harness root (`path.resolve` relative to `import.meta.url` or a known anchor)
   - Parse with `js-yaml`
   - Validate with Zod schema
   - Export typed config object
   - Fail fast at startup if file is missing or invalid — clear error message

3. Install `js-yaml` (runtime) and `@types/js-yaml` (dev) — pin exact versions

4. Wire into `src/index.ts` — load config at startup, before Slack connection. Log config summary.

5. Update startup banner — show config file path and validation status

**Config Zod schema:**
```typescript
const ConfigSchema = z.object({
  models: z.object({
    default: z.string(),
  }),
  categories: z.record(z.object({
    inactivityTimeout: z.number().positive(),
  })),
});
```

**Verify:**
- `npm run dev` → config loads, banner shows "config: OK" or similar
- Delete `config.yaml` → startup fails with clear error
- Put invalid YAML → startup fails with validation error
- `tsc --noEmit` passes

---

## Step 2: Role Definitions

**Who:** Agent

**Input:** Spec section: Agent Roles. Tech notes: n/a (new component).

**Do:**

1. Create `harness/roles/api-dev.md`:
   ```markdown
   ---
   name: api-dev
   displayName: KK API Dev
   category: coding
   model: claude-sonnet-4-6
   ---

   You are the API Dev agent for KindKatch. You work in the `kindkatchapi` project (.NET 8, C#, CQRS/DDD, EF Core).

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
   - Do NOT modify shared components without explicit approval.
   - Follow the project's CLAUDE.md and existing patterns.
   - Use conventional commits: feat:, fix:, chore:, docs:, refactor:
   ```

2. Create `src/roles.ts`:
   - `loadRoles(rolesDir: string): Map<string, RoleDefinition>` — reads all `.md` files from the directory
   - Split YAML frontmatter from markdown body (parse `---` delimiters)
   - Validate frontmatter with Zod
   - Return `Map<string, RoleDefinition>` keyed by `name` field
   - Fail fast if any role file has invalid frontmatter

3. Add `RoleDefinition` type to `src/types.ts`:
   ```typescript
   export type RoleDefinition = {
     name: string;
     displayName: string;
     category: string;
     model?: string;
     prompt: string; // markdown body (after frontmatter)
   };
   ```

4. Wire into `src/index.ts` — load roles at startup after config. Log role count and names.

5. Update startup banner — show roles loaded (count + names)

**Frontmatter Zod schema:**
```typescript
const RoleFrontmatterSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  category: z.string(),
  model: z.string().optional(),
});
```

**Verify:**
- `npm run dev` → roles load, banner shows "roles: 1 (api-dev)" or similar
- Delete the role file → startup fails with clear error
- Put invalid frontmatter → startup fails with validation error
- `tsc --noEmit` passes

---

## Step 3: Dispatch Upgrade

**Who:** Agent

**Input:** Current `src/dispatch.ts`, spec sections: Agent Dispatch, Model Selection. Tech notes: Agent SDK Integration. Milestone A handoff: Dispatch API.

**Do:**

1. **Expand `DispatchOptions`** in `src/types.ts`:
   ```typescript
   export type DispatchOptions = {
     cwd: string;           // REQUIRED for coding dispatches — target project dir
     role: string;          // role name to look up from loaded roles
     featureSlug: string;   // for journal path construction
     maxTurns?: number;
     maxBudgetUsd?: number;
     model?: string;        // per-dispatch override (highest priority)
   };
   ```

2. **Upgrade `dispatch()` in `src/dispatch.ts`:**
   - Accept loaded roles map and config as params (or import from a module-level singleton — agent's design choice, but keep it testable)
   - Look up `RoleDefinition` by `options.role`
   - Resolve model: `options.model` > `role.model` > `config.models.default`
   - Resolve inactivity timeout: `config.categories[role.category].inactivityTimeout` (replace hardcoded `STALL_TIMEOUT_MS`)
   - Process role prompt: replace `{journal_path}` with the concrete path (`.agents/journals/<featureSlug>/<role-name>.md` relative to `options.cwd`)
   - Pass to SDK:
     ```typescript
     systemPrompt: {
       type: "preset",
       preset: "claude_code",
       append: processedRolePrompt,
     },
     settingSources: ["project"],
     model: resolvedModel,
     ```

3. **Resolve project paths** relative to the hub root:
   - Hub root = `path.resolve(import.meta.url, '../../..')` or equivalent (harness lives at `<hub>/harness/`)
   - `options.cwd` is relative to hub root (e.g., `../kindkatchapi`)
   - Resolve to absolute path before passing to SDK

4. **Update `slack.ts`** — hardcoded test dispatch:
   ```typescript
   const result = await dispatch(text ?? '', {
     role: 'api-dev',
     cwd: '../kindkatchapi',
     featureSlug: 'milestone-b-test',
   });
   ```
   The human's DM text becomes the prompt. Role, project, and feature slug are hardcoded.

5. **Update startup banner** — show default model from config

**Verify:**
- DM the bot "Read the CLAUDE.md and list the available skills" → agent dispatches to `../kindkatchapi`
- Logs show: correct model, correct cwd, role name, session ID
- Agent picks up kindkatchapi's CLAUDE.md (visible in its output — it references API-specific patterns)
- Stall timer uses category timeout (300s for coding) not hardcoded 5 min (also 300s, but sourced from config — verify via log)
- `tsc --noEmit` passes

**This is the critical step.** If this works, real dispatch is proven.

---

## Step 4: Journal System

**Who:** Agent

**Input:** Spec section: Journal System. Tech notes: Windows Considerations (line endings).

**Do:**

1. Create `src/journal.ts` with:
   - `createJournal(options: JournalOptions): string` — creates the directory + file, writes header, returns the absolute path
   - `appendJournal(journalPath: string, entry: string): void` — appends a timestamped line
   - Both write `\n` explicitly (not `os.EOL` — per tech notes)

2. Add `JournalOptions` type to `src/types.ts`:
   ```typescript
   export type JournalOptions = {
     featureSlug: string;
     roleName: string;
     project: string;
     branch?: string;
     specPath?: string;
   };
   ```

3. **Journal file header format:**
   ```markdown
   # Journal: <featureSlug>
   Spec: <specPath or "N/A">
   Project: <project>
   Branch: <branch or "N/A">
   Started: <YYYY-MM-DD HH:MM>
   Status: in-progress

   ## Log

   - HH:MM — [harness] Agent dispatched (<roleName>, <model>)
   ```

4. **Wire into dispatch flow:**
   - Before calling `query()`, call `createJournal()` to create the file
   - After each `SDKAssistantMessage` with tool use blocks, call `appendJournal()` with `[harness]` entries:
     ```
     - HH:MM — [harness] tool_use: <toolName> <target>
     ```
   - Extract target from tool input: file path for Edit/Read/Write/Glob, command for Bash, pattern for Grep (best-effort extraction from `block.input`)
   - On completion: update `Status:` line in header to `completed` or `failed`
   - On abort/crash: update `Status:` line to `stalled` or `failed`

5. **Ensure journal directory is gitignored** — verify `.agents/journals/` is in `.gitignore` (it should be from the hub's existing gitignore, but confirm)

6. **Role prompt `{journal_path}` replacement** — if not already done in Step 3, the concrete journal path (returned by `createJournal()`) is substituted into the role prompt before passing to the SDK. The agent sees a real path, never the placeholder.

**Verify:**
- DM the bot → journal file appears at `.agents/journals/milestone-b-test/api-dev.md`
- Header is populated correctly (feature slug, project, timestamp, status)
- `[harness]` entries appear as agent uses tools
- `[agent]` entries appear if agent follows the role prompt instruction (best-effort — don't block on this)
- On completion: `Status:` line updated
- File uses `\n` line endings (check with a hex editor or `file` command if unsure)
- `tsc --noEmit` passes

---

## Step 5: Journal Watcher (Internal Monitoring)

**Who:** Agent

**Input:** Spec section: Journal System (watcher). Tech notes: Windows Considerations (chokidar).

**Do:**

1. Install `chokidar` (runtime) — pin exact version

2. Add to `src/journal.ts`:
   - `watchJournals(journalsDir: string, onChange: JournalChangeHandler): FSWatcher`
   - Uses chokidar with:
     ```typescript
     {
       awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
       ignoreInitial: true,
     }
     ```
   - On file change: read new lines since last known position (track byte offset per file)
   - Call `onChange` callback with the new entries and the journal file path

3. **`JournalChangeHandler` type:**
   ```typescript
   export type JournalChangeHandler = (journalPath: string, newEntries: string[]) => void;
   ```

4. **Wire into harness startup** in `src/index.ts`:
   - Start watcher on `.agents/journals/`
   - `onChange` handler: log new entries at `debug` level via pino
   - Store the watcher reference for graceful shutdown cleanup

5. **Expose query function:**
   - `getJournalStatus(journalPath: string): JournalStatus` — reads the file, extracts `Status:` from header, returns last N entries and last activity timestamp
   - This is plumbing for the future PM agent — not called by anything in Milestone B, but built and tested now

6. **Fallback plan for Windows:** If native `fs.watch` is unreliable during testing, add `usePolling: true` to chokidar options. Gate behind a config flag or `HARNESS_POLL_JOURNALS=true` env var. Log which mode is active at startup.

**Verify:**
- Harness starts → watcher logs "watching .agents/journals/" or similar
- Manually create/edit a file in the journals dir → change detected and logged
- During a real dispatch (from Step 4): journal writes trigger watcher → entries appear in harness logs
- No Slack messages posted from journal changes (confirm nothing goes to Slack)
- Watcher cleans up on graceful shutdown (no orphaned handles)
- `tsc --noEmit` passes

---

## Step 6: Structured Output

**Who:** Agent

**Input:** Spec section: Agent Result Schema. Tech notes: Agent SDK Integration.

**Do:**

1. **Add `AgentResultSchema`** to `src/types.ts`:
   ```typescript
   import { z } from 'zod';

   export const AgentResultSchema = z.object({
     status: z.enum(['success', 'partial', 'failed', 'blocked']),
     summary: z.string(),
     changes: z.array(z.string()).optional(),
     issues: z.array(z.string()).optional(),
     questions: z.array(z.string()).optional(),
     pr_url: z.string().optional(),
   });

   export type AgentResult = z.infer<typeof AgentResultSchema>;
   ```

2. Install `zod` (runtime) — pin exact version

3. **Pass `outputFormat` to `query()`** in `dispatch.ts`:
   ```typescript
   outputFormat: {
     type: "json_schema",
     schema: {
       // Convert Zod schema to JSON Schema for the SDK
       // Use zod-to-json-schema or manually define the JSON schema
     },
   },
   ```
   > **Note to agent:** Check the SDK docs/types for the exact `outputFormat` shape. The SDK may accept a JSON Schema object directly. If `zod-to-json-schema` is needed, install it. If the SDK has a simpler mechanism, use that.

4. **Validate the result** in `dispatch.ts`:
   - When `resultMsg` is received, parse `resultMsg.result` as JSON
   - Validate against `AgentResultSchema` with Zod
   - On success: return the typed `AgentResult`
   - On failure (malformed JSON, schema mismatch): log the raw result, return it as plain text in `DispatchResult.result` — graceful degradation

5. **Update `DispatchResult`** in `types.ts`:
   ```typescript
   export type DispatchResult = {
     status: 'completed' | 'aborted' | 'crashed';
     result?: string;           // raw text (fallback)
     structuredResult?: AgentResult;  // validated structured output
     cost?: number;
     error?: string;
     duration_ms?: number;
   };
   ```

6. **Update `formatResult()` in `slack.ts`:**
   - If `structuredResult` is present, format a clean summary:
     ```
     *Status:* success ✅
     *Summary:* <summary text>
     *Changes:*
     • <change 1>
     • <change 2>
     ```
   - If `structuredResult.questions` is non-empty, post them prominently:
     ```
     ⚠️ *Agent has questions:*
     1. <question 1>
     2. <question 2>
     ```
   - If no `structuredResult`, fall back to existing plain text behavior

7. **Add gap comment** where questions are posted:
   ```typescript
   // MILESTONE B GAP: Questions are surfaced to Slack but the agent session
   // is already terminated. Closing the loop (human replies → agent resumes)
   // requires session resume, scoped for a later milestone.
   ```

**Verify:**
- DM the bot with a task → agent returns structured JSON → formatted summary in Slack
- Structured result has status, summary, and at least one of changes/issues
- Deliberately break the schema (e.g., temporarily remove a required field) → graceful fallback to plain text, no crash
- If agent returns questions, they appear in Slack with the gap comment visible in source
- `tsc --noEmit` passes

---

## Step 7: Error Loop Detection

**Who:** Agent

**Input:** Spec sections: Error Loop Detection, Stalling Detection. Tech notes: Stalling Detection Implementation.

**Do:**

1. Create `src/monitor.ts`:
   - **Pure function:** `detectErrorLoop(recentCalls: ToolCall[]): LoopDetection | null`
   - Counts occurrences of each `tool::target` pair in the sliding window
   - Returns `{ pattern: string, count: number, severity: 'warning' | 'kill' }` or null
   - Warning at 3+ repetitions, kill at 5+

2. Add types to `src/types.ts`:
   ```typescript
   export type ToolCall = {
     tool: string;
     target: string;  // file path, command, pattern — extracted from input
     timestamp: number;
   };

   export type LoopDetection = {
     pattern: string;   // e.g., "Bash::dotnet build"
     count: number;
     severity: 'warning' | 'kill';
   };
   ```

3. **Integrate into dispatch event loop** in `dispatch.ts`:
   - Maintain a sliding window of last 10 `ToolCall` entries (array on a local variable, not a class)
   - After extracting tool use blocks from `SDKAssistantMessage`, push to window (shift if >10)
   - Call `detectErrorLoop(window)` after each push
   - On warning: post to Slack thread ("Agent appears stuck in a loop: [pattern]. Still running."), set `loopWarningPosted = true`
   - On kill: set `abortReason = 'error_loop'`, call `controller.abort()`, update journal status
   - Track `humanRespondedSinceWarning` flag (always false in Milestone B — no session resume). Human reply resets the flag and clears warning state. Build the check even though it's inert.

4. **Target extraction helper** — `extractTarget(toolName: string, input: unknown): string`:
   - `Edit` / `Read` / `Write` / `Glob` → extract `file_path` or `path`
   - `Bash` → extract `command`
   - `Grep` → extract `pattern`
   - Default → `"unknown"`
   - Best-effort, not exhaustive — the input is `unknown` from the SDK

5. **Unit tests** in `src/monitor.test.ts`:
   - No loop → returns null
   - 2 repetitions → returns null (below threshold)
   - 3 repetitions → returns warning
   - 5 repetitions → returns kill
   - Mixed tools with one looping → detects the loop, ignores the non-looping tools
   - Alternating loop pattern (Edit/Bash/Edit/Bash) → detected

**Verify:**
- Unit tests pass: `npx tsx --test src/monitor.test.ts`
- During a real dispatch: tool calls are tracked (visible in debug logs)
- Artificially trigger a loop (e.g., set threshold to 2 temporarily) → warning appears in Slack, then kill fires
- Journal status updated to `failed` on error loop kill
- `tsc --noEmit` passes

---

## Step 8: End-to-End Verification

**Who:** Human

**Test scenario:** Dispatch API Dev to `../kindkatchapi` with a small, safe, real task. Suggested: "Read the CLAUDE.md and list the available skills, then summarize the project structure."

**Checklist:**

### Startup
- [ ] Banner prints with ASCII art, version, node version, platform
- [ ] Config loads and validates (`config: OK` in banner)
- [ ] Roles load (`roles: 1 (api-dev)` in banner)
- [ ] Slack connects
- [ ] Journal watcher starts
- [ ] Heartbeat appears every 60s (with `HARNESS_VERBOSE=true`)

### Dispatch
- [ ] DM the bot → agent dispatches to `../kindkatchapi` with API Dev role
- [ ] Slack shows dispatch notification (minimal — one message)
- [ ] Agent picks up kindkatchapi's CLAUDE.md and skills (`settingSources: ["project"]`)
- [ ] Logs show: model from role/config, cwd resolved to kindkatchapi, session ID

### Journal
- [ ] Journal file created at `.agents/journals/milestone-b-test/api-dev.md` before agent starts
- [ ] Header populated (feature slug, project, timestamp, status: in-progress)
- [ ] `[harness]` tool use entries appear as agent works
- [ ] `[agent]` commentary entries appear (best-effort)
- [ ] Journal watcher detects changes, logs them internally (not to Slack)

### Completion
- [ ] Agent returns structured JSON matching `AgentResultSchema`
- [ ] Harness validates and posts formatted summary to Slack
- [ ] Status, summary, changes visible in Slack message
- [ ] Journal `Status:` line updated to `completed`
- [ ] Cost, duration, model captured in logs

### Error Handling
- [ ] Agent crash: journal status → `failed`, error posted to Slack
- [ ] Stall timer uses category timeout from config (300s for coding)
- [ ] Error loop detection fires when triggered (test with low threshold)
- [ ] Warn at 3, kill at 5 (test with fabricated scenario or low threshold)

### Resilience
- [ ] On validation failure (bad structured output): graceful fallback to plain text
- [ ] Reactions update correctly (👀 → 🔨 → ✅ or ❌)
- [ ] `tsx watch` restarts cleanly on code change
- [ ] Graceful shutdown cleans up: journal watcher, heartbeat timer, Slack connection

### Known Gaps (verify these are documented, not fixed)
- [ ] Agent questions posted to Slack but loop not closed (gap comment in source)
- [ ] Dispatch is hardcoded (no routing — role, project, slug all fixed)
- [ ] `humanRespondedSinceWarning` is always false (no session resume)
- [ ] Journal watcher is internal only (no Slack posting)

**Milestone B is complete when all boxes are checked and the handoff doc is written.**

---

## What's NOT in Milestone B

These are deferred — don't scope-creep:

- Session resume / conversational agents (Analyst, Coordinator roles)
- Command routing / message parsing
- Multi-agent (multiple named bot identities)
- Proactive messaging (harness initiates Slack messages)
- Git branch creation (agent creates branches — future tooling)
- PR creation or Bitbucket integration
- `#agent-ops` channel logging
- Multiple concurrent dispatches
- Slack Block Kit for rich formatting (plain text is fine)
- Hot-reload config (restart is fine)

---

## Environment Notes for Coding Agents

**IMPORTANT — read before building:**

1. **Kill all node instances** before starting work: `Stop-Process -Name node -Force` (Windows)
2. **Run with:** `npm run dev` from `harness/` (tsx watch + pino-pretty)
3. **Windows env vars** in `.env`: `CLAUDE_CODE_GIT_BASH_PATH`, `CLAUDE_EXECUTABLE_PATH` — see `.env.example`
4. **`HARNESS_VERBOSE=true`** in `.env` enables heartbeat and future verbose logging
5. **Line endings:** Write `\n` explicitly in generated files (journals, logs). Not `os.EOL`.
6. **Path separators:** Forward slashes in code. `path.join()` / `path.resolve()` for construction.
7. **Dependencies:** Pin exact versions (`save-exact=true` in `.npmrc`). Especially critical for `@anthropic-ai/claude-agent-sdk`.
8. **Module system:** ESM (`"type": "module"`). Use `.js` extensions in imports (e.g., `import { x } from './types.js'`).
9. **If you get stuck or are unsure about something, report back with your question rather than guessing.**
