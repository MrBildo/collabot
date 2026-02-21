# Milestone G+H Handoff — WebSocket Adapter + TUI Client

**Date:** 2026-02-21
**Branch:** `workflow-v2`
**Spec:** `docs/specs/workflow-harness-milestone-g-h.md`

## Milestone G — WebSocket Adapter (TypeScript)

**Status:** Complete. 136 tests passing, tsc clean.

Added a WebSocket adapter to the harness using `ws` + `json-rpc-2.0` npm packages. Any external process can now connect to the harness over WebSocket and interact via JSON-RPC 2.0.

### What was built
- `harness/src/adapters/ws.ts` — `WsAdapter` implementing `CommAdapter`. WebSocketServer with JSON-RPC request handling, notification broadcast, dynamic port support.
- `harness/src/ws-methods.ts` — 5 RPC method handlers: `submit_prompt`, `kill_agent`, `list_agents`, `list_tasks`, `get_task_context`. Fire-and-forget dispatch pattern.
- `harness/src/pool.ts` — `onChange` callback + `AgentSnapshot` interface for safe JSON serialization of pool state changes.
- `harness/src/index.ts` — Conditional WS startup from `config.ws`, pool change → `pool_status` broadcast wiring, shutdown cleanup.
- `harness/config.yaml` — `ws: { port: 9800, host: 127.0.0.1 }`
- `harness/src/config.ts` — Optional `ws` section in config schema.
- Integration tests with real WebSocket round-trips.

### Key design decisions
- Adapter pre-filtering: each adapter declares what message types it accepts. Slack gets minimal (lifecycle + result + warning + error). WS passes everything through — TUI filters client-side.
- `pool_status` is the only cross-adapter broadcast. `channel_message` and `status_update` go only to the adapter that received the task.
- SDK event streaming: `dispatch.ts` taps the SDK `query()` event stream and forwards events as `channel_message` notifications through an `onEvent` callback (follows the existing `onLoopWarning` pattern).

## Milestone H — TUI Client (.NET 10)

**Status:** Complete. `dotnet build` clean (0 errors, 0 warnings).

Built a Terminal.Gui v2 TUI client at `harness/tui/` as the first external consumer of the WebSocket adapter.

### What was built
- `harness/tui/` — Full .NET 10 project: Terminal.Gui v2 + StreamJsonRpc
- WebSocket connection with JSON-RPC 2.0 (connect, disconnect, RPC methods, notification handlers)
- Terminal.Gui layout: title bar with connection indicator, scrollable message area, status bar, text input
- 3-tier message filter system: minimal (result only), feedback (no tool_use/thinking), verbose (everything)
- Color-coded messages by type
- Slash commands: `/agents`, `/tasks`, `/kill`, `/context`, `/role`, `/task`, `/filter`, `/help`, `/quit`
- Auto-reconnect with exponential backoff (1s → 30s max)
- Command history (Up/Down arrows), keyboard shortcuts (Ctrl+Q, Ctrl+L)
- `appsettings.json` + `HARNESS_WS_URL` env var for config

### TUI rewrite note
The initial TUI implementation (H0-H3) did not follow coding conventions or correct Terminal.Gui v2 patterns. It was scrapped entirely and rewritten from scratch after building a Terminal.Gui v2 knowledge base at `.agents/kb/`. The rewrite used only KB patterns and C# conventions from `../kindkatchapi/.agents/docs/CONVENTIONS_CORE.md`. Lesson: for unfamiliar libraries, build the KB first, code second.

## Known Gaps (deferred)

| Gap | Closes When |
|-----|-------------|
| No auth on WS | Auth milestone |
| No per-client notification filtering | Subscription milestone |
| No message replay on reconnect | Message buffer milestone |
| No TLS/WSS | Production deploy |
| `listTasks` duplicated in mcp.ts and ws-methods.ts | Next cleanup pass |
