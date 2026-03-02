# Slack Revisited — Initiative #3

| Field | Value |
|-------|-------|
| **Source** | Spec discussion |
| **Status** | **Signed off** |
| **Created** | 2026-03-01 |
| **Last Updated** | 2026-03-01 |

## Summary

Rebuild Collabot's Slack integration from a mechanical dispatch interface into a conversational surface where bots are first-class citizens. A Slack bot isn't a remote control for the harness — it's a bot that *lives* in Slack the way a teammate does. Conversations are natural; when work needs doing, the bot handles project/task scoping and dispatches agents through the existing pipeline.

This initiative has two layers: (1) the **bot session pattern** — a provider-agnostic foundation for draft-on-demand bot sessions with identity reconstruction, and (2) the **Slack provider rebuild** — the first consumer of that pattern, replacing the PoC adapter with a proper Slack experience.

## Design Decisions

### D1: Slack is a place where bots live

Slack is not a dispatch interface or a notification channel. It's a communication surface where bots exist as first-class citizens — conversing naturally, carrying out work when asked, and behaving according to their role and identity. The PoC treated Slack as a chat-shaped CLI. The rebuild treats it as a social environment where bots participate like teammates.

This model is transport-agnostic. The same bot session pattern should work for Discord, Teams, or any future communication provider.

### D2: Bots are persistent identities, not persistent processes

A bot is a definition (personality/soul + memories) stored on disk, not a running process. When a message arrives for a bot, the harness drafts a session on demand, loading the bot's identity and reconstructing context from conversation history and memories. The session handles the interaction and ends. The bot persists because its data persists, not because a process stays alive.

This is context reconstruction applied at the bot level — the same pattern used for task follow-up dispatches, extended to include bot identity and conversational context.

### D3: Virtual projects — bots are always in a project

Every bot is always in a project. There is no "outside the project-task system." When a bot isn't working on a real project, it's in a **virtual project** managed by the harness.

The harness provides built-in virtual projects:
- **`lobby`** — default virtual project. Bots not assigned elsewhere land here.
- Providers can inject additional virtual projects when registered (e.g., `slack-room`).

Virtual projects follow the same infrastructure as regular projects — task directories, event capture, dispatch history. The difference:
- Paths are harness-managed, not user-configured
- Project-level restrictions limit what agents can do (no code changes, no file writes outside the project, etc.)
- System prompt injection makes the bot aware of its restricted context

This eliminates the need for a separate "conversational mode." Conversation IS task work — just in a restricted virtual project. Storage, event capture, and context reconstruction all use the existing infrastructure.

### D4: The project-task constraint is unchanged

The dispatch pipeline still requires project + task. No exceptions, no loosening. When a bot needs to do real work on a real project, it switches project context — either by dispatching child agents scoped to the target project, or by being re-drafted into that project's context. Casual conversation stays in the virtual project. The architecture doesn't bend.

### D5: Temporal task rotation via cron

Conversations in virtual projects accumulate indefinitely without intervention, leading to context rot. A **harness cron job** rotates tasks on a configurable interval:

- Closes the active task in the virtual project
- Opens a new task for the next window
- Produces output from the closed task before closing (day-1: a marker/log; future: memory synthesis trigger)

Configuration lives in the provider config:

```toml
[slack]
taskRotationIntervalHours = 24    # default: 1 day
```

This is the first consumer of a **harness cron framework** — virtual cron jobs that follow the same pattern as future pluggable cron jobs but are not externally exposed. The cron framework is minimal: register a named job with an interval and a handler. The summarization/memory hook is a known extension point, not built in this initiative.

### D6: Bot definition — minimal schema, known stub

Bot definitions live in `./bots/` at the repo root, alongside `./roles/`. Format follows the established pattern: markdown files with YAML frontmatter. The markdown body is the bot's soul prompt (personality, behavioral traits, communication style).

**Frontmatter fields (day-1):**

| Field | Type | Purpose |
|-------|------|---------|
| `id` | ULID | Unique identifier |
| `name` | string | Bot identity key |
| `displayName` | string | Human-facing name |
| `description` | string | What this bot is |
| `version` | semver | Definition version |

This is intentionally minimal. The bot schema will grow significantly as the bot abstraction matures (preferred roles, personality traits, memory configuration, capabilities). Day-1 fields are only what the harness mechanically needs to load and identify a bot.

**Memories** live outside the definition file in a mutable sibling structure (e.g., `./bots/alice/memories/`), since memories accumulate over time while the definition is relatively stable. Memory format is deferred — this initiative needs the directory convention, not the synthesis system.

### D7: Role assignment lives with the provider, not the bot

Bots and roles are independent concepts composed at draft time. A bot's definition does not reference roles — no `defaultRole` field, no coupling. This avoids hard dependencies between bots and roles (removing a role shouldn't require updating bot definitions) and keeps role assignment contextual to the use case.

Role binding is configured per-provider in `config.toml`:

```toml
[slack]
defaultBotRole = "product-analyst"    # fallback for unmapped bots

[slack.botRoles]
alice = "product-analyst"
bob = "ts-dev"
```

- Per-bot role overrides where needed
- Fallback default so every bot doesn't need explicit mapping
- Validated at startup (harness checks referenced roles exist)
- Provider-scoped — a Discord provider could map the same bots to different roles
- No special-casing — a `slack-emissary` role may exist but it's mechanically identical to any other role

### D8: Resume-per-message session lifecycle

Bot sessions use a **resume-per-message** pattern. When a message arrives, the harness drafts a session (or resumes an existing one via session ID). The agent processes the message, responds, and the session closes (process ends). The next message resumes the session from the persisted transcript.

This is the same mechanism the Claude Code Agent SDK uses for `resume: sessionId` — the SDK persists the conversation transcript to disk, and on resume, replays it with prompt caching keeping cost manageable. The SDK handles context compaction internally via `compact_boundary` events when the context window fills.

**Why not keep sessions alive between messages:**
- No idle process consumption (critical on Windows where orphaned node processes accumulate silently)
- No timeout management complexity
- No leaked subprocess risk
- Messages in Slack may arrive minutes or hours apart — holding a process open for that duration is wasteful
- Prompt caching means resume cost is reasonable

**This applies platform-wide**, not just Slack. The TUI draft pattern (interactive sessions that stay alive for rapid back-and-forth) is the exception for user-driven interactive work, not the rule for bot-driven conversations.

**Future:** The harness will eventually need its own compaction/summarization scheme independent of SDK compaction. The temporal task rotation (D5) provides a natural boundary for this — when a task rotates, the old task's context can be summarized rather than carried forward verbatim.

### D9: One Slack app per bot — first-class citizens

Each bot that lives in Slack gets its own Slack app installation. This gives each bot:
- Its own `@mentionable` identity (e.g., `@Alice`)
- Its own DM channel (anyone can DM the bot directly)
- Its own avatar, display name, and profile
- Presence indicator (`always_online: true` in the Slack app manifest)
- Independent event subscriptions and Socket Mode connection
- Membership in channel member lists

**The only limitation:** bot messages show a small "APP" badge. This cannot be removed. Otherwise, bots appear and behave like teammates.

**Harness mechanics:** The `SlackAdapter` manages N Bolt `App` instances — one per configured bot. A single Node.js process holds all Socket Mode connections. When a message arrives on any connection, the adapter identifies which bot it's for (by which app received it) and routes to the correct bot session.

**Configuration:** Per-bot Slack credentials in `config.toml`, with actual tokens in `.env`:

```toml
[slack]
taskRotationIntervalHours = 24

[slack.bots.alice]
botTokenEnv = "SLACK_BOT_TOKEN_ALICE"
appTokenEnv = "SLACK_APP_TOKEN_ALICE"
role = "product-analyst"

[slack.bots.greg]
botTokenEnv = "SLACK_BOT_TOKEN_GREG"
appTokenEnv = "SLACK_APP_TOKEN_GREG"
role = "ts-dev"
```

This supersedes D7's `defaultBotRole` / `[slack.botRoles]` pattern — role assignment is now inline with the bot's Slack app config since each bot entry is already bot-specific. A `defaultRole` at the `[slack]` level can serve as a fallback for bots without an explicit role.

**Slack plan requirement:** Free plan caps at 10 apps. Pro and above are unlimited. This is a deployment concern, not an architectural one.

**Future:** Slack's AI Agents framework (October 2025) offers a dedicated side-panel UI with agent switcher, streaming, and context awareness. Each agent is still a separate app. This can be layered on without architectural changes.

### D10: Interaction model — addressed, synchronous, queued

**Trigger:** Bots respond when directly addressed — DMs or `@mentions` in channels. No unprompted responses day-1.

**Replies:** Top-level channel replies, not threaded. Each `@mention` or DM is treated as an independent interaction. The bot's SDK session transcript provides natural continuity without explicit conversation grouping.

**Multi-bot mentions:** Each mentioned bot responds independently. No coordination or deference logic day-1.

**Synchronous + queued:** Each bot processes one message at a time. While busy, incoming messages are queued per-bot and processed in order when the bot is free. The bot itself decides how to acknowledge the busy state (via its personality/soul prompt) — the harness manages the queue and busy flag.

**Per-bot isolation:** Alice can be busy while Greg is free. Busy state is per-bot, not global. This replaces the PoC's single `agentBusy` boolean.

## Scope

### In this initiative

1. **Bot definition schema + loader** — minimal frontmatter (`id`, `name`, `displayName`, `description`, `version`), markdown body as soul prompt, `./bots/` directory, Zod validation, loaded at startup alongside roles
2. **Virtual projects infrastructure** — `lobby` built-in, provider-injected virtual projects (e.g., `slack-room`), harness-managed paths, project-level restrictions via system prompt injection
3. **Bot session drafting** — resume-per-message via SDK session resume, bot identity + role composed at draft time, session ID tracked per-bot
4. **Per-bot message queue + busy state** — harness-managed queue, one message at a time per bot, FIFO processing
5. **SlackAdapter rebuild** — multi-App (one Bolt `App` per bot), per-bot Socket Mode connections, DM + @mention routing, plain text / mrkdwn responses
6. **Slack config schema update** — per-bot token env var references, per-bot role mapping, task rotation interval
7. **Cron framework (minimal)** — register named job with interval + handler, task rotation as first consumer
8. **One working bot on Slack** — proof of the full pipeline: bot definition loaded, virtual project created, message received, session drafted with bot identity + role, conversational response posted

### Deferred

- **Memory synthesis / memory management** — converting task data and conversation history into bot memories. The directory structure (`./bots/<name>/memories/`) is created but not populated by any automated process.
- **Bot personality system** — beyond the soul prompt. Rich personality traits, communication style preferences, per-bot threading/formatting choices.
- **Unprompted responses** — bots proactively responding to channel activity without being @mentioned.
- **Multi-bot social coordination** — peer bots on the same channel being aware of each other's responses and adjusting behavior (deference, complementary answers, avoiding redundancy). This is social intelligence between bots, distinct from the existing child agent dispatch mechanism which already works.
- **Slack threads** — optional per-bot behavior where some bots prefer threaded replies. Day-1 is top-level only.
- **Slack AI Agents framework** — side-panel UI with agent switcher, streaming, context awareness. Layered on without architectural changes.
- **Custom compaction / context summarization** — harness-owned context management independent of SDK compaction. Task rotation (D5) provides the natural boundary.
- **Bot-to-bot communication** — bots conversing with each other in private channels or shared spaces.

## Acceptance Criteria

1. A bot definition file in `./bots/` is loaded and validated at harness startup
2. A virtual project (`lobby` or provider-injected) is created with task infrastructure when the harness starts
3. A Slack message (DM or @mention) for a configured bot drafts a session with the bot's soul prompt + assigned role
4. The bot responds conversationally in Slack using plain text / mrkdwn
5. A second message to the same bot resumes the session (SDK session resume), preserving conversational context
6. A second message while the bot is busy is queued and processed in FIFO order when the bot is free
7. Multiple bots can be configured and operate independently (Alice busy, Greg free)
8. Task rotation cron closes and rotates the virtual project's active task on the configured interval
9. Harness validates all Slack bot configs at startup (bot definition exists, role exists, env vars present)
10. Harness startup/shutdown cleanly manages N Bolt App instances

## Technical Notes

- Slack tokens live in `.env`, config references env var names (e.g., `botTokenEnv = "SLACK_BOT_TOKEN_ALICE"`)
- Each Slack app requires Socket Mode enabled, `app_mentions:read` + `im:read` + `chat:write` scopes minimum
- `always_online: true` in each Slack app manifest for presence indicator
- Bot messages show an "APP" badge — this is a Slack platform limitation, not removable
- Free Slack plan caps at 10 apps; Pro+ unlimited
- The PoC `SlackAdapter` is replaced, not extended — clean break from the mechanical dispatch model
- Virtual project CWD should be the collabot harness directory (or a dedicated sandbox directory) since there's no project repo to point at

---

## Sign-off

- [x] Design discussion completed — 2026-03-01
