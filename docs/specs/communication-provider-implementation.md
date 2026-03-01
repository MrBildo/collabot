# Communication Provider — Implementation Plan

| Field | Value |
|-------|-------|
| **Spec** | `docs/specs/communication-provider.md` |
| **Created** | 2026-03-01 |
| **Branch** | `feature/communication-provider` |

## Phase Overview

```
Phase 1: Foundation (types + registry + DispatchStoreProvider manifest)
         Sequential — everything else depends on this.
         Branch: feature/communication-provider

Phase 2: Migration (rename + adapt + rewire)
         All adapters, core.ts, index.ts, cli.ts, ws-methods.ts, slack.ts.
         One coordinated pass — rename CommAdapter, conform adapters,
         wire registry, connect inbound handlers.

Phase 3: Cleanup + Integration Testing
         Remove dead code, verify end-to-end, PR.
```

---

## Phase 1: Foundation

**Goal:** New types, `CommunicationProvider` interface, `CommunicationRegistry` class, and `DispatchStoreProvider` manifest retrofit. After this phase, Phase 2 has a stable foundation to build on.

**Files to modify:**
- `harness/src/comms.ts` — rename `CommAdapter` → `CommunicationProvider`, add new types
- `harness/src/dispatch-store.ts` — add `manifest` to `DispatchStoreProvider` interface and `JsonFileDispatchStore`

**Files to create:**
- `harness/src/registry.ts` — `CommunicationRegistry` class
- `harness/src/registry.test.ts` — tests

**Files NOT to touch:**
- Adapter files, `core.ts`, `index.ts`, `cli.ts`, `ws-methods.ts`, `slack.ts` — Phase 2 work

### Types to define in `comms.ts`

Rename `CommAdapter` to `CommunicationProvider`. Remove the old interface. Define the new interface alongside the supporting types:

```typescript
// ── Plugin Manifest ─────────────────────────────────────

export interface PluginManifest {
  /** Unique identifier — guards against collision across plugin sources. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Semver version string. */
  version: string;
  /** Short description of what this provider does. */
  description: string;
  /** Which provider type this plugin contributes. */
  providerType: 'communication' | 'dispatch-store';
}

// ── Inbound ─────────────────────────────────────────────

/** Result of processing an inbound message. */
export interface InboundResult {
  status: 'completed' | 'aborted' | 'crashed';
  summary?: string;
}

/** Handler that the harness registers to receive inbound messages. */
export type InboundHandler = (msg: InboundMessage) => Promise<InboundResult>;

// ── CommunicationProvider ───────────────────────────────

export interface CommunicationProvider {
  /** Provider identity — matches config section name. */
  readonly name: string;

  /** Plugin manifest — identity, version, config schema. */
  readonly manifest: PluginManifest;

  /** Message types this provider accepts. Undefined = all types. */
  readonly acceptedTypes?: ReadonlySet<ChannelMessage['type']>;

  // ── Lifecycle ──

  /** Start the provider (open connections, bind ports). No-op if stateless. */
  start(): Promise<void>;

  /** Stop the provider (close connections, release resources). No-op if stateless. */
  stop(): Promise<void>;

  /** Whether the provider is ready to send/receive. */
  isReady(): boolean;

  // ── Outbound ──

  /** Send a message to a channel. */
  send(msg: ChannelMessage): Promise<void>;

  /** Update channel status (reactions, spinners, etc.). */
  setStatus(channelId: string, status: 'received' | 'working' | 'completed' | 'failed'): Promise<void>;

  // ── Inbound ──

  /** Register the harness handler for inbound messages. Called once at startup. */
  onInbound(handler: InboundHandler): void;
}
```

Keep `InboundMessage`, `ChannelMessage`, and `filteredSend()` as they are. `filteredSend()` works with `CommunicationProvider` since the send/acceptedTypes signature is unchanged.

### DispatchStoreProvider manifest retrofit

Add `manifest` as a readonly property to the `DispatchStoreProvider` interface:

```typescript
export interface DispatchStoreProvider {
  readonly manifest: PluginManifest;
  // ... existing methods unchanged
}
```

Implement on `JsonFileDispatchStore`:

```typescript
readonly manifest: PluginManifest = {
  id: 'collabot.dispatch-store.json-file',
  name: 'JSON File Dispatch Store',
  version: '1.0.0',
  description: 'File-based dispatch store using JSON files in task directories.',
  providerType: 'dispatch-store',
};
```

### CommunicationRegistry in `registry.ts`

```typescript
import type { CommunicationProvider, ChannelMessage } from './comms.js';
import { filteredSend } from './comms.js';
import { logger } from './logger.js';

export class CommunicationRegistry {
  private registry: Map<string, CommunicationProvider> = new Map();

  register(provider: CommunicationProvider): void;
  get<T extends CommunicationProvider>(name: string): T | undefined;
  has(name: string): boolean;
  providers(): CommunicationProvider[];

  /** Best-effort — failures logged, provider stays not-ready. */
  async startAll(): Promise<void>;

  /** Reverse registration order. Errors logged, never thrown. */
  async stopAll(): Promise<void>;

  /** Send to all ready providers, respecting acceptedTypes. */
  async broadcast(msg: ChannelMessage): Promise<void>;

  /** Set status on all ready providers. */
  async broadcastStatus(
    channelId: string,
    status: 'received' | 'working' | 'completed' | 'failed',
  ): Promise<void>;
}
```

Key behaviors:
- `register()` throws if a provider with the same name is already registered
- `startAll()` calls `provider.start()` for each provider, catches errors, logs them, continues
- `stopAll()` iterates in reverse registration order, catches errors, logs them, continues
- `broadcast()` calls `filteredSend(provider, msg)` for each ready provider
- `broadcastStatus()` calls `provider.setStatus()` for each ready provider

### Tests for `registry.test.ts`

- Register a provider, verify `get()` and `has()` work
- Register duplicate name throws
- `startAll()` starts all providers
- `startAll()` logs and continues when a provider fails to start
- `stopAll()` stops in reverse order
- `broadcast()` sends to all ready providers
- `broadcast()` skips providers where `isReady()` is false
- `broadcast()` respects `acceptedTypes` (via `filteredSend`)
- `broadcastStatus()` calls setStatus on all ready providers

### Acceptance criteria

- [ ] `CommunicationProvider` interface exported from `comms.ts`
- [ ] `CommAdapter` name no longer exists in `comms.ts`
- [ ] `PluginManifest`, `InboundHandler`, `InboundResult` exported from `comms.ts`
- [ ] `CommunicationRegistry` class exported from `registry.ts` with all methods
- [ ] `DispatchStoreProvider` interface includes `manifest` property
- [ ] `JsonFileDispatchStore` implements `manifest`
- [ ] All registry tests pass
- [ ] `npm run typecheck` passes (note: adapter files and consumers will have broken imports from the rename — that's expected, fixed in Phase 2)
- [ ] Existing `dispatch-store.test.ts` tests still pass

---

## Phase 2: Migration

**Depends on:** Phase 1 complete

**Goal:** Migrate all three adapters to implement `CommunicationProvider`, update all consumers to use the registry, wire inbound handlers. This is one coordinated pass — the rename breaks all imports, so everything updates together.

**Files to modify:**
- `harness/src/adapters/cli.ts` — implement full `CommunicationProvider` interface
- `harness/src/adapters/ws.ts` — implement full `CommunicationProvider` interface
- `harness/src/adapters/slack.ts` — implement full `CommunicationProvider` interface
- `harness/src/core.ts` — `handleTask()` and `draftAgent()` take `CommunicationRegistry`
- `harness/src/index.ts` — replace manual adapter wiring with registry
- `harness/src/cli.ts` — use registry for one-shot dispatch
- `harness/src/ws-methods.ts` — update `WsMethodDeps` type, use registry
- `harness/src/slack.ts` — restructure to wire Bolt events through `onInbound`
- `harness/src/mcp.ts` — `draftFn` uses registry instead of headless adapter
- `harness/src/draft.ts` — if it references `CommAdapter`, update to `CommunicationProvider`

**Files NOT to touch:**
- `comms.ts`, `registry.ts`, `dispatch-store.ts` — Phase 1 (already done)

### CliAdapter migration

Minimal changes — CLI is stateless:

```typescript
export class CliAdapter implements CommunicationProvider {
  readonly name = 'cli';
  readonly manifest: PluginManifest = {
    id: 'collabot.communication.cli',
    name: 'CLI Adapter',
    version: '1.0.0',
    description: 'Logs messages to stdout. Stateless, always ready.',
    providerType: 'communication',
  };
  readonly acceptedTypes = MINIMAL_TYPES;

  private handler: InboundHandler | undefined;

  async start(): Promise<void> { /* no-op */ }
  async stop(): Promise<void> { /* no-op */ }
  isReady(): boolean { return true; }

  onInbound(handler: InboundHandler): void {
    this.handler = handler;
  }

  // send() and setStatus() unchanged
}
```

CLI's inbound path is special — `cli.ts` parses argv, constructs an `InboundMessage`, and calls the handler directly. The `onInbound` handler is set by the registry wiring, and `cli.ts` calls it after arg parsing.

### WsAdapter migration

WsAdapter already has `start()` and `stop()`. Add `manifest`, `isReady()`, and `onInbound()`:

```typescript
export class WsAdapter implements CommunicationProvider {
  readonly name = 'ws';
  readonly manifest: PluginManifest = {
    id: 'collabot.communication.ws',
    name: 'WebSocket Adapter',
    version: '1.0.0',
    description: 'JSON-RPC 2.0 over WebSocket. Supports TUI and external clients.',
    providerType: 'communication',
  };

  private handler: InboundHandler | undefined;

  isReady(): boolean { return this.wss !== null; }

  onInbound(handler: InboundHandler): void {
    this.handler = handler;
  }

  // start(), stop(), send(), setStatus() already exist
  // addMethod(), broadcastNotification(), port getter remain as transport extensions
}
```

### SlackAdapter migration

**Minimal conformance for this initiative.** The full Slack rebuild is Initiative #3. The goal here is to make `SlackAdapter` implement `CommunicationProvider` without deeply restructuring `startSlackApp()`.

The restructure needed: move Bolt App creation and event binding into the adapter's `start()` method. Currently `startSlackApp()` creates the adapter — invert this so the adapter owns the Bolt App.

```typescript
export class SlackAdapter implements CommunicationProvider {
  readonly name = 'slack';
  readonly manifest: PluginManifest = {
    id: 'collabot.communication.slack',
    name: 'Slack Adapter',
    version: '1.0.0',
    description: 'Slack integration via Bolt SDK Socket Mode.',
    providerType: 'communication',
  };
  readonly acceptedTypes = MINIMAL_TYPES;

  private app: App | null = null;
  private handler: InboundHandler | undefined;

  constructor(
    private token: string,
    private appToken: string,
    private config: Config,
  ) {}

  async start(): Promise<void> {
    // Create Bolt App, register event handlers, call app.start()
    // Event handlers call this.handler(msg) when messages arrive
  }

  async stop(): Promise<void> {
    if (this.app) await this.app.stop();
    this.app = null;
  }

  isReady(): boolean { return this.app !== null; }

  onInbound(handler: InboundHandler): void {
    this.handler = handler;
  }

  // send() and setStatus() use this.app.client (or stored client reference)
}
```

The debouncing logic currently in `slack.ts` moves inside `SlackAdapter.start()` as part of the event handler wiring. The `startSlackApp()` function is retired — its responsibilities move into the adapter.

### core.ts changes

`handleTask()` and `draftAgent()` take `CommunicationRegistry` instead of a single `CommAdapter`:

```typescript
export async function handleTask(
  message: InboundMessage,
  registry: CommunicationRegistry,  // was: adapter: CommAdapter
  roles: Map<string, RoleDefinition>,
  config: Config,
  pool: AgentPool | undefined,
  mcpServers: McpServers | undefined,
  projects: Map<string, Project>,
  projectsDir: string,
): Promise<DispatchResult> { ... }
```

Inside `handleTask()`:
- Replace all `adapter.send(...)` calls with `registry.broadcast(...)`
- Replace all `adapter.setStatus(...)` calls with `registry.broadcastStatus(...)`
- Return the `DispatchResult` as before — the caller (the provider's inbound handler) converts it to `InboundResult`

`draftAgent()` same treatment:

```typescript
export async function draftAgent(
  roleName: string,
  taskContext: string,
  registry: CommunicationRegistry,  // was: adapter: CommAdapter
  roles: Map<string, RoleDefinition>,
  config: Config,
  options?: { ... },
): Promise<DispatchResult> { ... }
```

Inside `draftAgent()`, replace `filteredSend(adapter, ...)` with `registry.broadcast(...)`.

### index.ts rewiring

Replace the manual adapter construction and conditional blocks with registry:

```typescript
const registry = new CommunicationRegistry();

// CLI always present
const cli = new CliAdapter();
registry.register(cli);

// WS — conditional on config
if (wsEnabled) {
  const ws = new WsAdapter({ port: config.ws!.port, host: config.ws!.host });
  registerWsMethods({ wsAdapter: ws, registry, roles, config, pool, projects, projectsDir: PROJECTS_DIR, mcpServers });
  registry.register(ws);
}

// Slack — conditional on tokens
if (slackEnabled) {
  const slack = new SlackAdapter(SLACK_BOT_TOKEN!, SLACK_APP_TOKEN!, config);
  registry.register(slack);
}

// Register inbound handler on all providers
const inboundHandler: InboundHandler = async (msg) => {
  const result = await handleTask(msg, registry, roles, config, pool, mcpServers, projects, PROJECTS_DIR);
  return {
    status: result.status === 'completed' ? 'completed' : result.status === 'aborted' ? 'aborted' : 'crashed',
    summary: result.structuredResult?.summary ?? result.result?.slice(0, 200),
  };
};
for (const provider of registry.providers()) {
  provider.onInbound(inboundHandler);
}

// Start all
await registry.startAll();

// Shutdown
async function shutdown(): Promise<void> {
  logger.info('shutting down');
  if (heartbeatInterval !== undefined) clearInterval(heartbeatInterval);
  await registry.stopAll();
  process.exit(0);
}
```

The `startSlackApp()` function is replaced by `SlackAdapter` lifecycle. The `WsAdapter` creation remains similar but uses the registry.

### ws-methods.ts changes

Update `WsMethodDeps` to use `CommunicationRegistry` instead of `CommAdapter`:

```typescript
export type WsMethodDeps = {
  wsAdapter: WsAdapter;
  registry: CommunicationRegistry;  // was: handleTask function reference
  roles: Map<string, RoleDefinition>;
  config: Config;
  pool: AgentPool;
  projects: Map<string, Project>;
  projectsDir: string;
  mcpServers?: McpServers;
};
```

The `dispatch_task` RPC method no longer calls `handleTask()` directly. Instead, it constructs an `InboundMessage` and calls `wsAdapter`'s inbound handler (which is the same handler registered by `index.ts`). The RPC method awaits the `InboundResult` and returns it as the JSON-RPC response.

Alternatively, the `dispatch_task` method can still call `handleTask(msg, registry, ...)` directly — the inbound handler pattern is for when the transport receives messages (Socket Mode events, RPC calls), but the WS RPC methods are already registered on the adapter and have access to deps. Either approach works; the key is that `handleTask` receives the registry for broadcast.

### cli.ts changes

The one-shot CLI dispatch creates a minimal registry with just `CliAdapter`:

```typescript
const registry = new CommunicationRegistry();
const adapter = new CliAdapter();
registry.register(adapter);
await registry.startAll();

const result = await handleTask(message, registry, roles, config, pool, mcpServers, projects, PROJECTS_DIR);
```

### mcp.ts changes

The `draftFn` wrapper currently passes a headless `CliAdapter`. Update to pass the registry (or create a minimal registry with CliAdapter for MCP-initiated dispatches):

```typescript
const draftFn: DraftAgentFn = async (roleName, taskContext, opts) => {
  return draftAgent(roleName, taskContext, registry, roles, config, { ... });
};
```

### Acceptance criteria

- [ ] `CommAdapter` name no longer exists anywhere in the codebase
- [ ] All three adapters implement `CommunicationProvider` with manifest, lifecycle, and onInbound
- [ ] `handleTask()` and `draftAgent()` take `CommunicationRegistry`
- [ ] `index.ts` uses registry for all adapter management
- [ ] `startSlackApp()` retired — lifecycle moved into `SlackAdapter`
- [ ] Inbound handler registered on all providers in `index.ts`
- [ ] `cli.ts` uses registry for one-shot dispatch
- [ ] `ws-methods.ts` uses registry
- [ ] `mcp.ts` draftFn uses registry
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes

---

## Phase 3: Cleanup + Integration Testing

**Depends on:** Phase 2 complete

**Goal:** Remove dead code, verify end-to-end behavior, prepare PR.

**Cleanup tasks:**
- Remove `startSlackApp()` function from `slack.ts` (if not already done in Phase 2)
- Remove any orphaned imports of `CommAdapter`
- Evaluate whether `filteredSend()` in `comms.ts` is still needed — if `registry.broadcast()` is the only consumer, it may become a private helper or stay as a utility
- Remove the `NOTE: Channel and Participant types are intentionally deferred` comment in `comms.ts` if no longer accurate

**Integration testing:**
- Start harness with WS enabled, verify WS provider starts and is ready
- Start harness without Slack tokens, verify harness continues with WS + CLI only
- Dispatch via CLI (`collabot dispatch`), verify lifecycle messages are broadcast
- Dispatch via WS (`dispatch_task` RPC), verify all providers receive lifecycle updates
- Verify `pool_status` broadcast still works via WsAdapter transport extension
- Verify `isReady()` returns false for providers that failed to start
- Verify shutdown calls `stopAll()` cleanly

### Acceptance criteria

- [ ] No references to `CommAdapter` remain in codebase
- [ ] No orphaned imports or dead code
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (all existing + new tests)
- [ ] End-to-end: CLI dispatch broadcasts to all providers
- [ ] End-to-end: WS dispatch broadcasts to all providers
- [ ] End-to-end: harness starts with failed provider (best-effort)
- [ ] End-to-end: shutdown is clean

---

## Dispatch Prompts

### Phase 1 — Foundation

Open Claude Code in `../collabot/harness/`

> Check out branch `feature/communication-provider` (from `master`). Read the spec at `docs/specs/communication-provider.md` and the implementation plan at `docs/specs/communication-provider-implementation.md`. Implement **Phase 1: Foundation** — define `PluginManifest`, `InboundHandler`, `InboundResult`, and rename `CommAdapter` to `CommunicationProvider` in `comms.ts` (replace in place, no aliases). Create `CommunicationRegistry` class in a new `registry.ts` with register, get, has, providers, startAll, stopAll, broadcast, broadcastStatus methods. Write tests in `registry.test.ts`. Add `manifest` property to the `DispatchStoreProvider` interface in `dispatch-store.ts` and implement it on `JsonFileDispatchStore`. Do NOT modify adapter files, `core.ts`, `index.ts`, `cli.ts`, `ws-methods.ts`, or `slack.ts` — those are Phase 2. Adapter files and consumers will have broken imports from the rename — that's expected. Run `npm run typecheck` (adapter import errors are acceptable) and `npm test` to verify dispatch-store and registry tests pass.

### Phase 2 — Migration

Open Claude Code in `../collabot/harness/`

> Check out branch `feature/communication-provider` (should have Phase 1 committed). Read the spec at `docs/specs/communication-provider.md` and the implementation plan at `docs/specs/communication-provider-implementation.md`. Implement **Phase 2: Migration** — this is one coordinated pass that updates everything. Migrate all three adapters (`CliAdapter`, `WsAdapter`, `SlackAdapter`) to implement `CommunicationProvider` with manifest, lifecycle, and `onInbound()`. Move Bolt App lifecycle from `startSlackApp()` into `SlackAdapter.start()` — this is a minimal conformance migration, not a full Slack rebuild. Update `handleTask()` and `draftAgent()` in `core.ts` to take `CommunicationRegistry` instead of a single adapter — use `registry.broadcast()` and `registry.broadcastStatus()` for all outbound. Rewire `index.ts` to use the registry pattern (register providers, register inbound handler, startAll, stopAll). Update `cli.ts` to create a minimal registry for one-shot dispatch. Update `ws-methods.ts` to use registry. Update `mcp.ts` draftFn to use registry. Run `npm run typecheck` and `npm test`.

### Phase 3 — Cleanup + Integration

Open Claude Code in `../collabot/harness/`

> Check out branch `feature/communication-provider` (should have Phases 1 and 2 committed). Read the spec at `docs/specs/communication-provider.md` and the implementation plan at `docs/specs/communication-provider-implementation.md`. Implement **Phase 3: Cleanup + Integration** — remove any dead code (orphaned `CommAdapter` references, `startSlackApp()` if still present, unused imports). Evaluate whether `filteredSend()` should remain as a public utility or become internal to the registry. Run full integration verification: `npm run typecheck`, `npm test`. Verify the harness starts cleanly with `npm run dev` (kill any existing node processes first). Create a commit with all changes and prepare for PR.
