# Milestone A — The Pipe Works

> **Parent spec:** `docs/specs/workflow-harness.md`
> **Tech notes:** `docs/specs/workflow-harness-tech-notes.md`
> **Goal:** Prove Slack ↔ harness ↔ SDK ↔ agent ↔ Slack

Each step is independently verifiable. Don't move to the next step until the current one works.

---

## Step 1: Create Slack App

**Who:** Human (manual Slack admin)

**Do:**
1. Go to https://api.slack.com/apps → Create New App → From scratch
2. Name: `KindKatch Agents` (or similar), workspace: your corporate workspace
3. Enable **Socket Mode** (Settings → Socket Mode → Enable). Create an app-level token with `connections:write` scope. Save the `xapp-...` token.
4. Add **Bot Token Scopes** (OAuth & Permissions):
   - `chat:write`
   - `chat:write.customize`
   - `chat:write.public`
   - `files:write`
   - `reactions:write`
   - `channels:read`
   - `im:read`
   - `im:write`
   - `im:history` (needed for Socket Mode DM events)
   - `app_mentions:read`
5. **Subscribe to Bot Events** (Event Subscriptions → Subscribe to bot events):
   - `message.im` (DMs to the bot)
   - `app_mention` (@ mentions in channels)
6. Install the app to your workspace. Save the **Bot User OAuth Token** (`xoxb-...`).
7. Find the bot in Slack, send it a DM to create the DM channel (it won't respond yet — that's fine).

**Verify:** You have two tokens:
- App-level token: `xapp-...` (Socket Mode)
- Bot token: `xoxb-...` (API calls)

**Output for next step:** Both tokens, ready to put in `.env`.

---

## Step 2: Scaffold the Project

**Who:** Agent (or human — it's fast either way)

**Do:**
1. Create `harness/` directory structure per tech notes (src/, roles/, etc.)
2. `npm init` with `"type": "module"`
3. Install runtime deps: `@slack/bolt`, `dotenv`, `pino`
4. Install dev deps: `typescript`, `tsx`, `@types/node`
5. Create `tsconfig.json` per tech notes (`ES2022`, `Node16`, `strict`)
6. Create `.npmrc` with `save-exact=true`
7. Create `.env` with placeholder tokens:
   ```
   SLACK_BOT_TOKEN=xoxb-your-token
   SLACK_APP_TOKEN=xapp-your-token
   ```
8. Create `harness/.gitignore` (node_modules, .env, dist/, logs/)
9. Create `src/index.ts` — empty entry point that just logs "harness starting"
10. Add `package.json` scripts: `dev`, `build`, `start`, `typecheck`

**Verify:** `npm run dev` starts, prints "harness starting", `tsx watch` is running.

**Note:** Do NOT install the Agent SDK yet. Prove Slack first.

---

## Step 3: Slack Connection

**Who:** Agent

**Input:** Spec sections: Slack App Setup, Slack UX. Tech notes: Slack Bolt Patterns.

**Do:**
1. Create `src/slack.ts` — initialize Bolt app with Socket Mode:
   ```
   new App({ token: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN, socketMode: true })
   ```
2. Wire up in `src/index.ts` — load `.env`, create Bolt app, call `app.start()`
3. Add `pino` logger — basic setup, log "connected to Slack" on successful start
4. Add global `app.error()` handler that logs and doesn't crash

**Verify:**
- `npm run dev` → logs "connected to Slack" (or Bolt's startup confirmation)
- Bot shows as online (green dot) in Slack
- Changing a source file → `tsx watch` restarts → reconnects automatically

---

## Step 4: Echo Handler

**Who:** Agent

**Input:** Tech notes: Slack Bolt Patterns (event routing, handler pattern).

**Do:**
1. Add `app.message()` handler in `src/slack.ts`
2. Filter out bot messages (`message.subtype !== undefined`)
3. On DM from human: reply in a thread with the same text, prefixed with "Echo: "
4. Log inbound and outbound messages with pino

**Verify:**
- DM the bot "hello" → bot replies in thread "Echo: hello"
- Send another message in the same thread → bot replies in thread again
- Check logs — inbound message logged with timestamp, channel, user

**Why this step exists:** Proves inbound routing, outbound posting, and thread mechanics before adding SDK complexity.

---

## Step 5: Agent SDK Dispatch

**Who:** Agent

**Input:** Spec sections: Agent Dispatch, Agent Result Schema. Tech notes: Agent SDK Integration. Research: `03-agent-sdk.md` (query API, event types, error handling).

**Do:**
1. Install `@anthropic-ai/claude-agent-sdk` (pin exact version) and `zod`
2. Add `ANTHROPIC_API_KEY` to `.env`
3. Create `src/dispatch.ts` — wrap `query()` with:
   - `AbortController` with a wall-clock timeout (5 min for this test)
   - Try/catch around the entire `for await` loop
   - Capture `session_id` from init event
   - Log every event type received (don't process them yet — just log)
   - Capture `SDKResultMessage` at the end
4. Create `src/types.ts` — `AgentContext` and `DispatchResult` types
5. Replace echo handler: on DM, dispatch an agent with a simple task prompt:
   - `"List the files in the current directory and summarize what you see."`
   - `cwd` set to the harness project directory (not a sub-project — keep it self-contained)
   - `systemPrompt: { type: "preset", preset: "claude_code" }`
   - `permissionMode: "bypassPermissions"`, `allowDangerouslySkipPermissions: true`
   - `maxTurns: 10`, `maxBudgetUsd: 1.00` (tight limits for a test)
6. Post the agent's final result text back to the Slack thread

**Verify:**
- DM the bot "go" → bot spawns agent → agent lists files → result appears in thread
- Logs show: init event with session_id, assistant events, tool_use events, result event with cost
- Cost is captured and logged
- If agent crashes (exit code 1), it's caught and logged — doesn't crash the harness

**This is the critical step.** If this works, the pipe is proven.

---

## Step 6: Polish & Observe

**Who:** Agent

**Do:**
1. Add persona to outbound messages (`username: "KK Agent"`, skip `icon_url` for now)
2. Add status reactions on the parent message:
   - 👀 when message received
   - 🔨 when agent dispatched
   - ✅ when agent completes successfully
   - ❌ when agent fails/crashes
3. Format the result message nicely (not raw dump — structured summary)
4. Add basic stall timer (setTimeout/clearTimeout from tech notes) — abort if no events for 5 min
5. Log cost summary at end of dispatch: model, tokens, USD

**Verify:**
- Full flow works with persona name and status reactions
- Stall timer exists (test by setting it artificially low, like 5 seconds, and dispatching a longer task)
- Cost is visible in logs

---

## Step 7: End-to-End Verification

**Who:** Human

**Checklist:**
- [ ] `npm run dev` → harness connects to Slack
- [ ] DM the bot → agent spawns, does work, result appears in thread
- [ ] Status reactions update correctly (👀 → 🔨 → ✅)
- [ ] Persona name shows on bot messages
- [ ] Logs capture: all SDK events, session_id, cost
- [ ] Agent crash handled gracefully (test: dispatch with impossible task or tiny budget)
- [ ] `tsx watch` restarts cleanly on code change
- [ ] `.env` is gitignored, tokens not in source

**Milestone A is complete when all boxes are checked.**

---

## What's NOT in Milestone A

These are Milestone B or later — don't scope-creep:

- Journal system (file creation, watching, Slack updates)
- Config.yaml (hardcoded values are fine for Milestone A)
- Role definitions (single hardcoded prompt is fine)
- Conversational agents / session resume
- Error loop detection
- Structured output schema
- Command system
- Multiple agent types/personas
