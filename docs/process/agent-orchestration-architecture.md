# Agent Orchestration Architecture

> Captured from design discussion 2026-02-17. This is a living doc — will evolve as we build.

## Vision

The human's primary interface shifts from "sitting in Claude Code" to **interacting with agents via the harness through any adapter** (Slack, CLI, TUI, future web UI). The hub agent is an async project manager with a workforce of sub-agents. The human checks in when pinged, answers questions, reviews work, gives approvals. The hub handles everything in between.

Agents are treated as **employees, not tools**. They have names, personalities, and presence through whatever interface is active. The workflow harness is the persistent core — always running, interface-independent — that makes this possible.

```
Human (any adapter) ←→ Workflow Harness (always on) ←→ Claude Agent Instances (ephemeral)
                              ↓                              ↓
                     Adapters (Slack, CLI,          Journals, Tasks, Logs,
                      TUI, future web UI)           MCP Tool Surface
```

> **Note:** This doc was originally written 2026-02-17 when Slack was the only interface. Milestone D (2026-02-19) decoupled core from Slack. Sections below retain historical context alongside the evolved architecture.

### Deployment

- **Development/testing:** Current Windows dev machine
- **Target production:** Dedicated Mac Mini (headless, always on, no monitor)
- **Platform note:** Workflow is currently Windows-centric (company has many Windows-locked devs). POSIX-friendly version planned for future portability.

## Core Principles

1. **Files are the communication bus.** Journals, specs, and logs — not return values or process memory. If an agent dies, the files survive. A new agent reads the files and picks up.
2. **The hub is the boss.** Sub-agents are subordinates. They have some agency (ask technical questions) but the hub coordinates, monitors, and reports.
3. **Tools over tokens.** Deterministic operations become scripts/tools/MCPs. Agent reasoning is reserved for judgment calls. If the operation has a deterministic correct answer, it's a tool. If it requires judgment, it's an agent.
4. **Iterate, don't overengineer.** Build the foundation, prove the pattern, then expand.

## Dispatch Mechanism

### Current: CLI Pipe Mode (interim)

```powershell
cd ..\kindkatchapi
unset CLAUDECODE
claude -p "<prompt>" --output-format text --dangerously-skip-permissions
```

**Known issues:**
- Must clear env vars to prevent nested session errors (CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)
- `--allowedTools` unreliable in non-interactive mode — use `--dangerously-skip-permissions`
- `stream-json` format has a known hanging bug (process doesn't exit after final result)
- General CLI freezing after ~10 minutes reported in some cases

**Hardening (do now):** Clear all 4 env vars, add timeout wrappers.

### Target: Agent SDK Wrapper Script

The `@anthropic-ai/claude-agent-sdk` (TypeScript) or `claude-agent-sdk` (Python) provides a programmatic `query()` function that returns an async iterable of typed events.

**Why this over CLI pipe:**
- No env var inheritance bugs (not a shell subprocess)
- Typed event streams (tool_use, tool_result, message, result)
- Proper session management (capture session_id, resume)
- Programmatic error handling
- Cost tracking built in

**What the wrapper does:**
1. Creates/updates journal file before spawning agent
2. Calls `query()` with the dispatch prompt
3. Streams events — can write key events to the journal in real-time
4. Captures final result and appends summary to journal
5. Handles agent failure gracefully (journal has state for handoff)

**Tradeoff:** Requires a Node.js or Python runtime. Not a raw shell command anymore.

## Journal System

### Purpose

The journal is the **authoritative record of work in progress**. Not a debug log — a cue for any agent (or human) to understand where things stand and pick up where someone left off.

### Structure

One directory per feature, one file per project/agent:

```
.agents/journals/<feature-slug>/
  api.md              ← API agent writes here
  portal.md           ← Portal agent writes here
  tester.md           ← Testing agent writes here
```

Naming is project-based for now. Evolves to agent-name-based when agent identity matures.

### Format

```markdown
# Journal: <feature name>
Spec: docs/specs/<feature>.md
Project: kindkatchapi
Branch: feature/<branch-name>
Started: 2026-02-17 12:34
Status: in-progress | completed | failed | blocked

## Log

- 12:34 — Branch `feature/12654-whatever` created from `master`
- 12:34 — Starting §1: <spec section name>
- 12:35 — Modified `Domain/Entities/Sender.cs` — added IsDefault property
- 12:35 — Modified `Infrastructure/Persistence/SenderConfiguration.cs`
- 12:36 — §1 complete
- 12:36 — Starting §2: <spec section name>
- 12:37 — Modified `Application/Commands/CreateSenderCommandHandler.cs`
- 12:38 — ⚠️ BLOCKED: <question or issue>
- 12:42 — Answer received: <resolution>
- 12:43 — §2 complete
- 12:45 — All sections complete, PR created: <url>
```

### Mechanics

- SDK wrapper creates the journal file with header before spawning agent
- Agent's dispatch prompt includes journal path and instructions to maintain it
- Agent appends entries as it works (branch, section start/complete, files modified, blockers)
- Hub reads any journal anytime for progress checks
- If agent dies, hub reads journal, spawns replacement pointed at the same journal
- Section references (§1, §2) tie to spec sections for handoff clarity

## Structured Returns

Less critical now that the journal is the source of truth. The SDK captures a final result with session_id, cost, duration, and turn count. A simple return schema is nice-to-have:

```json
{
  "status": "success | partial | failed | blocked",
  "summary": "What was done",
  "changes": ["file1.cs", "file2.cs"],
  "issues": ["Could not resolve X"],
  "questions": ["Should Z use pattern A or B?"],
  "pr_url": "https://..."
}
```

If the agent crashes before returning, the journal has the state. The return is a convenience, not the lifeline.

## Communication Layer (Slack)

### Why Slack

The human's IRL team is fully remote — all communication happens via Slack (DMs, channels, occasional voice). No office, no in-person. Agent communication should mirror this exactly. Slack provides:

- **Channels** for project/feature collaboration (multiple agents + human)
- **DMs** for direct agent interaction
- **Threads** for organized conversations within channels
- **File sharing** for specs, reports, journals
- **Mobile app** — human can interact from phone, no laptop required
- **Socket Mode** — app connects outbound via WebSocket, no public URL/port forwarding needed. Perfect for a machine behind a firewall with no domain or SSL.

This eliminates the need for SMS, email, or other communication channels. Slack was the first adapter built, but the harness is interface-independent — CLI, TUI, and future web UI are peer adapters, not alternatives.

### Use Cases

1. **Agent → Human notifications:** "Research complete", "Feature done", "PRs ready for review"
2. **Agent → Human with content:** Send specs, reports, summaries via Slack
3. **Human → Agent responses:** Sign-offs, notes, answers to questions
4. **Sub-agent → Human directly:** Technical questions from coding agents
5. **Human → Hub on-demand:** "What's the progress?" → Hub reads journals, reports back
6. **Multi-agent meetings:** Multiple agents + human in a channel/thread, discussing a spec or design. Hub chairs, specialists contribute from their domain expertise.

### Architecture: The Workflow Harness

The harness is a **persistent Node.js orchestration engine** running on the dev machine (eventually the Mac Mini). It is the core that manages agent lifecycle, task state, context reconstruction, and the MCP tool surface. Interfaces connect as adapters — Slack, CLI, and future TUI/web UI all implement the same `CommAdapter` interface.

```
Workflow Harness (Node.js, always running)
  ├── Core (core.ts) — handleTask + draftAgent, adapter-agnostic
  ├── Agent SDK — spawns/manages Claude instances via query()
  ├── MCP Server — in-process tools (draft, await, kill, list, context)
  ├── Agent Pool — tracks concurrent agents, capacity limits, abort
  ├── Task System — manifests, journals, context reconstruction
  ├── File System — reads/writes journals, specs (local, same machine)
  └── Adapters (optional)
      ├── Slack (adapters/slack.ts) — Bolt SDK, Socket Mode
      ├── CLI (adapters/cli.ts) — one-shot terminal dispatch
      └── Future: TUI, web UI, programmatic API
```

**Why Node.js:** Most portable runtime, Agent SDK has a TypeScript package. Single language for the entire harness.

### Slack Workspace Design

| Channel/DM | Purpose |
|-------------|---------|
| DM with Hub Agent | Project management, spec reviews, status reports |
| DM with API Agent | Technical questions during API implementation |
| DM with Portal Agent | Technical questions during portal implementation |
| `#feature-<slug>` | Per-feature collaboration channel (all relevant agents + human) |
| `#agent-ops` | System-level: agent health, errors, cost tracking |

### Agent Identities in Slack

Each agent gets a Slack bot identity — name, avatar, personality. They show up like real team members. Can be multiple bot users within one Slack app, or separate apps per agent.

### How Two-Way Communication Works

1. **Outbound (agent → Slack):** Harness receives events from Agent SDK stream, formats and posts to Slack via Bolt SDK. Deterministic — a tool, not agent reasoning.
2. **Inbound (Slack → agent):** Harness receives Slack messages via Socket Mode, routes to the correct active agent instance. If no agent is active, harness can spawn one with context (journals, specs, conversation history).
3. **Request/response pattern:** Agent asks a question (tool call in the SDK stream), harness posts it to Slack, waits for human reply, feeds reply back into the agent's session. The agent experiences it as a blocking tool call.

### Slack Workspace Optimization

Current corporate Slack setup is minimalist — near-zero plugins/integrations. Admin rights available. Research needed on what Slack features and integrations could support this workflow (Workflows, Canvas, Automations, relevant apps).

### Open Questions

- Slack app architecture: one app with multiple bot users, or multiple apps?
- Thread management: how does the harness track which thread maps to which agent/conversation?
- Agent session persistence: when human messages the hub bot hours later, does it resume or start fresh?
- Rate limiting: Slack API limits vs agent message frequency
- Cost visibility: should agent token costs be tracked and surfaced in Slack?

## Agent Identity (Future)

Currently agents are identified by project (api, portal, tester). Future state includes:
- Named agents with identities and capabilities
- Agent registry/manager
- More sophisticated dispatch based on agent specialization
- Journal files named by agent identity rather than project

Not building this now. Natural evolution when the workforce grows beyond 3.

## Phase 1 Build Order

1. **Research** — Existing frameworks, Slack Bolt patterns, Agent SDK in practice, Slack workspace features
2. **SDK wrapper script** — foundation for everything else
3. **Journal system** — baked into the wrapper
4. **Workflow harness (PoC)** — Node.js app with Slack Bolt + Agent SDK
5. **PoC scope:** DM the hub bot → hub spawns agent → agent works + journals → hub reports back via Slack

### PoC Success Criteria

- Human can DM the hub bot in Slack and get a response
- Hub can spawn a sub-agent (API) that does real work
- Sub-agent writes to journal as it works
- Hub reads journal and reports progress back via Slack
- Hub notifies human when sub-agent finishes
- All running on the current dev machine (Windows)

## Tooling Candidates

Operations that should become deterministic tools (not agent reasoning):

| Operation | Current | Target |
|-----------|---------|--------|
| Send Slack message | N/A | Script/MCP tool |
| Wait for Slack reply | N/A | MCP tool with listener |
| Read journal, extract status | Agent reads file | Script that parses and summarizes |
| Create branch, update journal | Agent does it | Script |
| Pull PR comments | `bb` CLI (exists) | Already a tool |
| Create journal file with header | Agent does it | Part of SDK wrapper |

## Research Agenda

Before building, research the following:

1. **Existing frameworks:** Are there Slack + AI agent orchestration frameworks we can use or reference?
2. **Slack Bolt SDK:** Socket Mode patterns, multi-bot setup, thread management, message routing
3. **Agent SDK in practice:** Real-world `query()` usage, session management, gotchas, event stream handling
4. **Slack workspace features:** Workflows, Canvas, Automations, integrations that support agent interaction
5. **Multi-agent chat patterns:** How others have built multi-agent conversations in chat interfaces

## Technical References

- Agent SDK: `@anthropic-ai/claude-agent-sdk` (TS), `claude-agent-sdk` (Python)
- Slack Bolt SDK: `@slack/bolt` (Node.js, Socket Mode supported)
- Claude Code GitHub issues: #26190 (env var inheritance), #25629 (stream-json hang), #24478 (CLI freeze), #7091 (sub-agent stall)
- Agent Teams: Experimental (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) — hub-spoke model but not production-ready
- MCP for communication: Not native agent-to-agent, but can be used as message broker via custom MCP servers

## Design Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-17 | SDK wrapper over CLI pipe mode | Avoids env var bugs, typed events, proper error handling |
| 2026-02-17 | Files as communication bus | Survives agent death, any agent can read, hub reports from them |
| 2026-02-17 | Journal: dir per feature, file per agent | No write collisions with parallel agents |
| 2026-02-17 | Node.js for harness | Portable, first-class Slack Bolt + Agent SDK support |
| 2026-02-17 | Slack as first communication adapter | Mirrors existing team workflow, eliminates SMS/email need. **Revised 2026-02-19 (Milestone D):** Slack decoupled to adapter; harness runs headless without it. CLI adapter added as peer. TUI planned. |
| 2026-02-17 | Slack Socket Mode | No public URL needed, works behind firewall on headless machine |
| 2026-02-17 | Tools over tokens | Deterministic ops become scripts; agent reasoning for judgment only |
| 2026-02-17 | Project-based agent naming (for now) | Evolves to named identities when workforce grows |
| 2026-02-17 | Dev on current Windows machine | Mac Mini is target production, not immediate |
