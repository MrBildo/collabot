# Milestones G & H — WebSocket Adapter + TUI Client

## Context

The harness is the core orchestration engine — always running, interface-independent. It currently has two adapters: Slack (conversational) and CLI (one-shot). The user wants to interact with the harness through a dedicated TUI.

This requires two things: (1) a WebSocket adapter on the harness so external processes can connect, and (2) a .NET TUI client as the first external consumer. The WS adapter is a strategic investment — every future interface (web UI, mobile, remote harness) connects through it.

**Key decisions:**
- .NET 10 TUI using Terminal.Gui v2
- JSON-RPC 2.0 over WebSocket
- TUI lives at `harness/tui/` (inside harness, not a sibling project)
- Server: `json-rpc-2.0` npm + `ws` npm | Client: `StreamJsonRpc` (.NET)
- C# coding conventions from `../kindkatchapi/.agents/docs/CONVENTIONS_CORE.md` apply

---

## Protocol: JSON-RPC 2.0 over WebSocket

### Client → Server (requests with `id`)

| Method | Params | Result |
|--------|--------|--------|
| `submit_prompt` | `{ content, role?, taskSlug? }` | `{ threadId, taskSlug }` |
| `kill_agent` | `{ agentId }` | `{ success, message }` |
| `list_agents` | none | `{ agents: [{ id, role, taskSlug, startedAt }] }` |
| `list_tasks` | none | `{ tasks: [{ slug, created, description, dispatchCount }] }` |
| `get_task_context` | `{ slug }` | `{ context }` |

### Server → Client (notifications, no `id`)

| Method | Params |
|--------|--------|
| `channel_message` | ChannelMessage fields (timestamp as ISO string) |
| `status_update` | `{ channelId, status }` |
| `pool_status` | `{ agents: [{ id, role, taskSlug, startedAt }] }` |

`submit_prompt` is fire-and-forget from the caller's perspective — returns `threadId` immediately, agent output arrives as `channel_message` notifications.

App-specific error codes: `-32000` task not found, `-32001` agent not found, `-32002` role not found, `-32003` pool at capacity.

---

## Milestone G — WebSocket Adapter (4 steps, TypeScript)

### Step G0: WebSocket Server + JSON-RPC Foundation

New file `harness/src/adapters/ws.ts`:
- `WsAdapter` class implementing `CommAdapter`
- Uses `ws.WebSocketServer` + `json-rpc-2.0` `JSONRPCServer`
- Tracks connected clients in `Map<WebSocket, ClientState>`
- `send()` broadcasts `channel_message` notification to all clients
- `setStatus()` broadcasts `status_update` notification to all clients
- `broadcastNotification(method, params)` iterates clients, catches per-client errors
- `start()` / `stop()` lifecycle

Add `ws` optional section to `ConfigSchema` in `config.ts`: `{ port: number, host: string }`

Dependencies: `ws`, `@types/ws`, `json-rpc-2.0` (already installed)

### Step G1: RPC Method Handlers

New file `harness/src/ws-methods.ts`:
- `registerWsMethods(deps)` — registers all 5 RPC methods on the WsAdapter
- `submit_prompt`: builds `InboundMessage`, calls `handleTask()` (fire-and-forget), returns `threadId`
- `kill_agent`: calls `pool.kill()`, returns success/failure
- `list_agents`: projects `pool.list()` to safe JSON (strips AbortController)
- `list_tasks`: reads task dirs (copy pattern from `mcp.ts` private `listTasks`)
- `get_task_context`: calls `buildTaskContext()`
- Uses `JSONRPCErrorException` for typed errors

### Step G2: Pool Change Events

Modify `harness/src/pool.ts`:
- Add `onChange?: (event: PoolChangeEvent) => void` callback
- Add `setOnChange(cb)` method
- Call from `register()`, `release()`, `kill()` — projects agents to safe JSON
- Backward compatible: onChange is optional, no existing behavior changes

### Step G3: Wiring & Config Integration

Modify `harness/src/index.ts`:
- Conditionally create `WsAdapter` if `config.ws` exists
- Call `registerWsMethods()` with deps
- Wire `pool.setOnChange()` → `wsAdapter.broadcastNotification('pool_status', ...)`
- Start WS server after Slack (if enabled), stop in shutdown
- Update startup banner: `interfaces: Slack, WS (127.0.0.1:9800), CLI`

Add `ws` section to `config.yaml`: `{ port: 9800, host: 127.0.0.1 }`

---

## Milestone H — TUI Client (6 steps, .NET 10)

### Step H0: Project Scaffold + WebSocket Connection

New project at `harness/tui/`:
- `KindKatch.Tui.csproj` — .NET 10, Terminal.Gui (prerelease), StreamJsonRpc
- `Services/HarnessConnection.cs` — WebSocket + StreamJsonRpc client
- `Models/` — record DTOs for all notification params and RPC results
- `Program.cs` — minimal: connect, print messages, Ctrl+C to exit (no UI yet)

### Step H1: Terminal.Gui Application Shell

- `Views/MainWindow.cs` — Terminal.Gui layout
- Top: title + connection indicator
- Middle: `ListView` (scrollable message list)
- Status bar: pool count, role, task
- Bottom: `TextField` for input

### Step H2: Chat Interaction + Prompt Submission

- `OnInputSubmit()`: if not a `/command`, call `SubmitPromptAsync()`
- Display `[you] > text` locally, then stream `channel_message` notifications

### Step H3: Slash Commands

- `Commands/CommandHandler.cs`
- Commands: `/agents`, `/tasks`, `/kill <id>`, `/context <slug>`, `/role <name>`, `/task <slug>`, `/help`, `/quit`

### Step H4: Auto-Reconnect

- Exponential backoff: 1s → 2s → 4s → 8s → max 30s
- Guard RPC calls against disconnected state

### Step H5: Polish

- Keyboard shortcuts, command history, timestamps, startup banner
- `appsettings.json` + `HARNESS_WS_URL` env var fallback

---

## Known Gaps (deferred)

| Gap | Closes When |
|-----|-------------|
| No auth on WS | Auth milestone |
| No per-client notification filtering | Subscription milestone |
| `listTasks` duplicated from mcp.ts | Next cleanup pass |
| No message replay on reconnect | Message buffer milestone |
| No TLS/WSS | Production deploy |
