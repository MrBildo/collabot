# Workflow Harness — Technical Implementation Notes

> **Addendum to:** `docs/specs/workflow-harness.md`
> **Source:** Implementation planning discussion 2026-02-17
> **Purpose:** "How to build" reference — complements the "what to build" spec

These are accumulated decisions from implementation planning discussions. The coding agent building the harness should read this alongside the spec.

---

## Project Setup

**Package manager:** npm. No benefit from yarn/pnpm at this scale. Use `save-exact=true` in `.npmrc` — all dependencies pinned to exact versions (especially critical for the SDK's rapid release cadence).

**Module system:** ESM (`"type": "module"` in package.json). All modern packages (SDK, Bolt, etc.) target ESM. CommonJS is legacy.

**TypeScript configuration:** Target `ES2022` (Node 20+ supports natively), `"module": "Node16"` for Node's native module resolution with ESM/CJS interop. `"strict": true` with `"noUncheckedIndexedAccess": true` for maximum type safety. Source maps enabled for debuggable stack traces.

**Dev runner:** `tsx watch` for hot-reload development (like `dotnet watch run`). `tsx` uses esbuild under the hood — runs `.ts` directly without a separate compile step.

**Build/run model:** `tsc` compiles to `dist/`. Production runs `node dist/index.js`. Dev runs `tsx watch src/index.ts`.

**Dev tooling:** No ESLint or Prettier for PoC. `"strict": true` catches most issues. Add later if codebase grows.

**Dependencies:**

| Package | Type | Purpose |
|---------|------|---------|
| `@slack/bolt` | runtime | Slack Socket Mode, events, messaging |
| `@anthropic-ai/claude-agent-sdk` | runtime | Agent dispatch via `query()` |
| `chokidar` | runtime | Journal file watching |
| `zod` | runtime | Structured output schema validation |
| `dotenv` | runtime | Load `.env` secrets into `process.env` |
| `js-yaml` | runtime | Parse YAML config file |
| `pino` | runtime | Structured JSON logging |
| `typescript` | dev | Compiler |
| `tsx` | dev | Dev runner with hot reload |
| `@types/node` | dev | Node.js type definitions |
| `@types/js-yaml` | dev | Type definitions for js-yaml |
| `pino-pretty` | dev | Human-readable log formatting |

**package.json scripts:**

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `tsx watch src/index.ts` | Development with hot reload |
| `build` | `tsc` | Compile TypeScript to `dist/` |
| `start` | `node dist/index.js` | Run compiled output |
| `typecheck` | `tsc --noEmit` | Type checking only (CI, pre-commit) |

**Folder structure:**

```
harness/
├── src/                    # Flat until a module grows past 3-4 files
│   ├── index.ts            # Entry point — init Slack, wire components, start
│   ├── slack.ts            # Slack Bolt setup, event handlers
│   ├── dispatch.ts         # Agent SDK wrapper — query(), event processing
│   ├── monitor.ts          # Stalling detection, error loop detection
│   ├── journal.ts          # Journal file creation, reading, watching
│   ├── router.ts           # Thread-to-agent mapping, message routing
│   ├── config.ts           # Load and validate configuration
│   └── types.ts            # Shared types/interfaces
├── roles/                  # Role definition markdown files
├── config.yaml             # Non-secret configuration (categories, timeouts)
├── package.json
├── tsconfig.json
├── .npmrc                  # save-exact=true
├── .env                    # Secrets (gitignored)
└── .gitignore
```

---

## Configuration

**Secrets (`.env` + `dotenv`):** Slack tokens, API keys. Loaded into `process.env` at startup. Validated immediately — fail fast if any required var is missing.

**Behavior (`config.yaml` + `js-yaml` + Zod):** Category timeouts, error loop thresholds, budget limits, persona definitions, Slack channel config. YAML chosen over JSON (supports comments for a frequently-tuned file) and over cosmiconfig (overkill — we know where the file is). Validated at startup with a Zod schema that provides both runtime validation and compile-time types via `z.infer`.

**No hot-reload for PoC:** `tsx watch` restarts in under a second during development. Edit YAML, save, harness restarts. Revisit if restart cost grows.

**Future state — runtime config via harness:** Adjust timeouts, budgets, and thresholds via Slack commands without editing files or restarting. Natural evolution once real operational data informs tuning.

---

## Slack Bolt Patterns

**Socket Mode:** Three-line init (`new App({ token, appToken, socketMode: true })`), auto-reconnect handled by Bolt internally. No public URL needed.

**Event routing:** `app.message()` handles both DMs and thread replies. Distinguish by `thread_ts` — present on replies, absent on top-level messages. `app.event("app_mention")` handles @mentions in channels. Filter `message.subtype !== undefined` early to ignore bot messages, edits, and other non-user message types.

**Thread-to-agent mapping:** `Map<thread_ts, AgentContext>` keyed on the human's original message timestamp. `thread_ts` is unique, stable, provided by Slack on every message — natural session key. Slack message `metadata` field (invisible to users, survives restarts) is the backup for harness restart recovery (Phase 2).

**Handler pattern:** Do fast work in the handler (Slack API calls, session lookup), fire-and-forget slow work (`runAgent().catch(...)`) without awaiting. Socket Mode auto-acks `message` and `event` handlers — no explicit `ack()` needed for Phase 1 (only needed for slash commands, button clicks, modals).

**Personas:** `chat:write.customize` scope overrides `username` + `icon_url` per message. Status reactions on parent message (`reactions.add`/`reactions.remove`) for visual progress.

**Error handling:** Global `app.error()` handler as last-resort catch. Individual handlers wrap fast work in try/catch. Fire-and-forget promises always have `.catch()` to prevent unhandled rejections (which crash Node.js).

---

## Agent SDK Integration

**Dispatch function shape:** `dispatch(task)` owns a coding agent's full lifecycle — create `AbortController`, create `AgentContext`, call `query()`, consume the `for await` stream, clean up in `finally`. Returns a `DispatchResult` with status (`completed | aborted | crashed`) and result data.

**Event processing (game loop body):** Each SDK event is type-narrowed via discriminated union (`msg.type`). `system/init` → capture `session_id`. `assistant` → extract `ToolUseBlock` entries for journaling, logging, and error loop detection. `system/compact_boundary` → log + notify human. `rate_limit` → log utilization/reset/overage (new in SDK 2.1.45 via `SDKRateLimitEvent`/`SDKRateLimitInfo` types — log only for Phase 1, use for dispatch throttling in Phase 2). `result` → terminal event, capture cost/usage.

**Conversational agents (resume pattern):** `resumeAgent(context, humanMessage)` calls `query()` with `resume: context.sessionId`. Each human reply is one turn. No `maxTurns` or per-turn `maxBudgetUsd` — turns are short. Session stays resumable for 30 days per SDK docs.

**Session tracking:** `Map<string, AgentContext>` keyed by Slack `thread_ts`. Plain `Map` is safe — Node.js single-threaded, no concurrent access. Consulted on every inbound Slack message to route new tasks vs. replies to existing agents.

**AbortController lifecycle:** One controller per agent, stored on `AgentContext`. Three abort triggers: stall timer, human kill command, harness shutdown (SIGINT). Set `context.abortReason` before calling `abort()` so the catch block knows why — `AbortError` itself carries no reason payload.

**Tool call extraction:** `ToolUseBlock` entries from `SDKAssistantMessage.message.content`. `block.input` is `unknown` — cast to extract `file_path`, `command`, or `pattern` depending on tool name. Stored in a sliding window (last 20) on `AgentContext` for error loop detection.

---

## Stalling Detection Implementation

**Silent stall — `setTimeout`/`clearTimeout` pair:** `resetStallTimer(context)` clears existing timer, sets a new one with the category's inactivity timeout. Timer fires → set `abortReason`, call `controller.abort()`. Cleared in `finally`. No wrapper class — three lines of logic don't warrant one. Conversational agents: timer only exists during active turns (started on `resumeAgent()`, cleared when `for await` loop ends). Between turns, no timer — natural from the structure.

**Error loop — frequency-in-window approach (not consecutive streaks):** Count occurrences of each `tool::target` pair in the last 10 tool calls. Catches both consecutive loops (`Bash Bash Bash`) and alternating loops (`Edit Bash Edit Bash`). 3+ occurrences of any pair → warn in Slack thread, set `loopWarningPosted` flag. 5+ with no human response since warning → kill. Human reply in thread resets `humanRespondedSinceWarning` and clears the warning flag, allowing a fresh warn/kill cycle.

**Game loop integration:** Each tick: (1) reset stall timer, (2) process event, (3) check error loop. Sequential, no concurrency. Stall timer runs as a background `setTimeout` outside the loop — fires only if the loop stops ticking.

---

## Logging & Observability

**Library:** `pino` — structured JSON logging, one dependency, near-zero overhead. Equivalent to Serilog in .NET. JSON-per-line output (NDJSON) is both human-scannable and machine-parseable.

**Pattern:** `logger.info({ field1, field2 }, "message")` — data object first, message second. Child loggers (`logger.child({ sessionId, role })`) bake session context into every log line automatically — equivalent to `ILogger.BeginScope()`. Store child logger on `AgentContext`.

**Log levels:** `debug` for every SDK event (tool calls, text blocks — high volume). `info` for lifecycle events (dispatch, complete, resume). `warn` for health signals (compaction, loop detection, budget approach). `error` for failures (crashes, stalls, kills). Start at `debug` for PoC, tune up to `info` once event patterns are understood.

**Output:** Stdout during development, piped through `pino-pretty` for readability (`tsx watch src/index.ts | pino-pretty`). File logging via pino transports added later for Mac Mini / PM2 deployment.

---

## Testing Strategy

**Test runner:** Node's built-in test runner (`node:test`). Zero dependencies — ships with Node 20+. Works natively with ESM and TypeScript (via `tsx`). Run with `tsx --test src/**/*.test.ts`. Migration to vitest is a 10-minute find-and-replace if more robust testing is needed later.

**Test file convention:** `*.test.ts` co-located with source — `monitor.ts` → `monitor.test.ts`.

**What to test (priority order):** (1) Error loop detection — pure function, critical for agent health. (2) Config validation — catches bad YAML before runtime. (3) Tool call extraction — `extractTarget` logic per tool type. (4) Journal formatting — markdown generation from event data. All pure functions, easy to test with fabricated inputs.

**Design for testability:** Separate logic from I/O. `detectErrorLoop(calls): LoopDetection | null` is a pure function that takes data and returns a verdict. The glue code that calls it and does side effects (abort, Slack post) is trivial and verified by reading. Same Arrange-Act-Assert pattern as xUnit.

**Fake timers:** `mock.timers.enable()` from `node:test` for stall timer tests — control time explicitly, verify behavior at each point. Same concept as `Fake.TimeProvider` in .NET 8.

**Integration testing:** Manual for PoC. Slack connection, SDK `query()`, chokidar file watching — tested by running the harness with real inputs. Not worth mocking for a solo project at this stage.

---

## Windows Considerations

**File paths:** Forward slashes everywhere in code. `path.join()` for path construction (handles separator normalization). `process.cwd()` returns backslashes — normalize when needed for logs/display.

**Line endings:** Write `\n` explicitly in generated files (journals, logs). Not `os.EOL` (returns `\r\n` on Windows). Git handles conversion for committed files via `core.autocrlf`.

**`chokidar` file watching:** Use `awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }` to avoid mid-write events. `ignoreInitial: true` to skip existing files at startup. Fall back to `usePolling: true` (1s resolution) if native `fs.watch` is unreliable — test early.

**Graceful shutdown:** Register both `SIGINT` (Windows Ctrl+C) and `SIGTERM` (Unix PM2 stop). On Windows only `SIGINT` fires from terminal; `SIGTERM` is harmless to register.

**`tsx watch`:** Works reliably on Windows. Uses esbuild (native binary) + Node's `fs.watch`.

**Node version:** Pin with `nvm-windows` + `.nvmrc` file at project root. Target Node 22 LTS.
