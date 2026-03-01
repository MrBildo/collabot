# Communication Provider — Plugin/Provider Pattern & Adapter Formalization

| Field | Value |
|-------|-------|
| **Source** | Design analysis & codebase exploration 2026-03-01 |
| **Status** | **Signed off** |
| **Created** | 2026-03-01 |
| **Last Updated** | 2026-03-01 |

## Summary

Formalize Collabot's communication layer from the ad-hoc `CommAdapter` interface into a proper `CommunicationProvider` following the plugin/provider pattern promised in Event System v2 (D14). This spec defines a bidirectional provider interface (outbound messaging, inbound message handling, lifecycle management), establishes a provider registry with broadcast semantics, and introduces the plugin manifest schema shared across all future provider types.

The existing three adapters (Slack, WebSocket, CLI) become `CommunicationProvider` implementations. The manual if/else wiring in `index.ts` is replaced by a registry that handles registration, lookup, lifecycle orchestration, and broadcast. All harness activity is visible to all connected providers — a task initiated from any interface is observable from every interface.

## Motivation

The current `CommAdapter` interface works but has accumulated three debts:

1. **Outbound-only interface.** `CommAdapter` defines `send()` and `setStatus()` — both outbound. Inbound handling is completely outside the contract. Each adapter handles inbound differently (Bolt SDK event subscriptions, JSON-RPC method registration, CLI arg parsing) with no common surface, even for the parts that could be shared.

2. **WsAdapter exceeds the interface.** `WsAdapter` implements `start()`, `stop()`, `addMethod()`, `broadcastNotification()`, and a `port` getter — none of which exist on `CommAdapter`. Callers hold the concrete `WsAdapter` type to access these. This is pragmatic but undocumented. `SlackAdapter` and `CliAdapter` have no lifecycle methods at all.

3. **No lifecycle management or registry.** Adapter instantiation, startup, and shutdown are manually wired in `index.ts` with conditional blocks. There's no centralized way to enumerate registered adapters, start/stop them together, or broadcast to all. Adding a new adapter means editing multiple files.

Event System v2 (D14) established the plugin/provider pattern and the first provider type (`DispatchStoreProvider`). It explicitly deferred the full pattern formalization to this spec. Initiative #3 (Slack revisited) will be the first adapter built as a proper `CommunicationProvider` — this spec must land first.

## Design Decisions

### D1: CommunicationProvider interface — CommAdapter + lifecycle

The new `CommunicationProvider` interface extends the existing `CommAdapter` surface (`name`, `acceptedTypes`, `send`, `setStatus`) with lifecycle methods and a manifest.

```typescript
/** Handler that the harness registers to receive inbound messages. */
type InboundHandler = (msg: InboundMessage) => Promise<InboundResult>;

interface CommunicationProvider {
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

**Stateless providers** (e.g., CLI) implement `start()`/`stop()` as no-ops and `isReady()` returning `true`. The interface doesn't distinguish stateful from stateless — it just has a uniform surface.

**`filteredSend()` remains** as a standalone utility function. It respects `acceptedTypes` and works with the new interface unchanged.

### D2: Inbound — bidirectional interface with transport-specific internals

All three existing adapters receive messages through different transport mechanisms (Bolt SDK events, JSON-RPC methods, CLI argv) but all produce the same output: an `InboundMessage`. The convergence point is already there in the code — this decision puts it on the interface.

| Provider | Transport mechanism | Convergence |
|----------|------------------|-------------|
| Slack | Bolt SDK Socket Mode → event subscriptions | → `InboundMessage` |
| WebSocket | JSON-RPC 2.0 `dispatch_task` method | → `InboundMessage` |
| CLI | Process argv parsing at startup | → `InboundMessage` |

**Decision:** The `CommunicationProvider` interface includes `onInbound(handler)`. The harness registers a single handler at startup. Each provider wires its transport internals to call that handler with an `InboundMessage`. Transport complexity stays inside the provider — the harness only sees the unified message type.

**The handler returns `Promise<InboundResult>`.** This solves the WS request/response pattern: the WS provider awaits the handler result and sends it back as the JSON-RPC response. Fire-and-forget providers (like a future webhook adapter) can ignore the return value.

```typescript
/** Result of processing an inbound message. */
interface InboundResult {
  status: 'completed' | 'aborted' | 'crashed';
  summary?: string;
}
```

**CLI is a degenerate case** — a one-shot provider that calls the handler once from `start()` and then the process exits. It fits the model as a provider with exactly one inbound event.

**Transport-specific concerns stay inside the provider.** Bolt SDK reconnection, WebSocket handshake/protocol versioning, JSON-RPC method dispatch — none of this leaks into the interface. The provider owns its transport; the interface defines the handoff.

### D3: Transport-specific extensions are valid and expected

`WsAdapter` has methods beyond the interface: `addMethod()`, `broadcastNotification()`, `port` getter. These are legitimate transport extensions — not violations of the contract.

**Pattern:** The `CommunicationProvider` interface defines the common surface. Providers may expose additional methods for transport-specific features. Consumers that need extensions hold the concrete type via the registry's typed getter.

```typescript
// Common surface — any code that just needs to send messages
function notifyAll(registry: CommunicationRegistry, msg: ChannelMessage): void {
  registry.broadcast(msg);
}

// Transport-specific — code that needs WS-specific features
const ws = registry.get<WsAdapter>('ws');
if (ws) {
  ws.addMethod('dispatch_task', handler);
  ws.broadcastNotification('pool_status', { agents });
}
```

No marker interface, no capability flags. If you need the extension, you know the type.

### D4: CommunicationRegistry — centralized provider management

A `CommunicationRegistry` replaces the manual if/else blocks in `index.ts`. It handles:

- **Registration** — `register(provider)` adds a provider by name
- **Lookup** — `get<T>(name)` returns typed provider or undefined
- **Lifecycle** — `startAll()` / `stopAll()` orchestrate startup/shutdown in registration order
- **Broadcast** — `broadcast(msg)` sends to all ready providers via `filteredSend()`
- **Enumeration** — `providers()` returns all registered providers

```typescript
class CommunicationRegistry {
  private registry: Map<string, CommunicationProvider> = new Map();

  register(provider: CommunicationProvider): void;
  get<T extends CommunicationProvider>(name: string): T | undefined;
  has(name: string): boolean;
  providers(): CommunicationProvider[];

  /** Start all registered providers in registration order. Best-effort — failures are logged, provider stays not-ready. */
  startAll(): Promise<void>;

  /** Stop all registered providers in reverse registration order. Errors logged, never thrown. */
  stopAll(): Promise<void>;

  /** Send to all ready providers, respecting acceptedTypes. */
  broadcast(msg: ChannelMessage): Promise<void>;

  /** Set status on all ready providers. */
  broadcastStatus(channelId: string, status: 'received' | 'working' | 'completed' | 'failed'): Promise<void>;
}
```

**`handleTask()` and `draftAgent()` take the registry, not a single provider.** All lifecycle messages, status updates, streaming events, and results are broadcast to every connected provider. A task initiated from Slack is visible in the TUI. A task initiated from the TUI is visible in Slack. The harness is the source of truth for activity — every interface sees everything.

The originating provider doesn't need special treatment for the direct response. The `onInbound` handler returns `InboundResult`, which goes back to the caller through the callback chain. Broadcast handles the real-time narrative; the return value handles the direct acknowledgment.

```
Slack DM → SlackProvider.onInbound(handler)
                ↓
        handler = handleTask(msg, registry, ...)
                ↓
        registry.broadcast(lifecycle msgs)  →  SlackProvider.send() ✓
                                            →  WsProvider.send()    ✓  (TUI sees it)
                                            →  CliProvider.send()   ✓  (logs it)
                ↓
        returns InboundResult  →  SlackProvider awaits and posts final reply
```

**`index.ts` transformation:**

Before (manual):
```typescript
if (wsEnabled) {
  wsAdapter = new WsAdapter({ port, host });
  registerWsMethods({ wsAdapter, ... });
  await wsAdapter.start();
}
// ... in shutdown:
if (wsAdapter) await wsAdapter.stop();
```

After (registry):
```typescript
const registry = new CommunicationRegistry();
if (wsEnabled) {
  const ws = new WsAdapter({ port, host });
  registerWsMethods({ wsAdapter: ws, ... });
  registry.register(ws);
}
registry.register(new CliAdapter()); // always present
await registry.startAll();
// ... in shutdown:
await registry.stopAll();
```

**Startup is best-effort.** `startAll()` attempts each provider in registration order. If a provider fails to start, the error is logged and the provider remains not-ready (`isReady() → false`). The harness continues with whatever started successfully. `broadcast()` and `broadcastStatus()` naturally skip providers that aren't ready. This means a WS port conflict doesn't prevent Slack-initiated tasks from working.

**Shutdown is unconditional.** `stopAll()` attempts every provider in reverse order, logging errors but never throwing.

### D5: Plugin manifest — common metadata envelope (delivering on Event System v2 D14)

Event System v2 D14 established the two-layer extensibility model: **Plugin** (packaging/discovery/loading unit with manifest) → **Provider** (typed capability). D14 deferred the concrete manifest schema to this spec. `DispatchStoreProvider` shipped as the first provider type but without the plugin layer — only the provider interface was implemented. This decision closes that gap.

Every provider carries a `PluginManifest` — a common metadata envelope shared across all provider types. The manifest exists to support future plugin resolution: when third-party or disk-based plugins arrive, the harness needs a uniform way to identify, version, and classify what it's loading. The `id` field protects against name collision across plugin sources. Building this into the architecture now means plugin resolution is a loading concern, not a structural retrofit.

```typescript
interface PluginManifest {
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
```

**Day-1: manifests are in-code metadata.** Each provider class returns its manifest from the `manifest` property. No files on disk, no discovery, no dynamic loading — but the structure is in place for when they arrive.

**Future: disk-based manifests.** When plugins are loaded from `~/.collabot/plugins/`, each plugin directory will contain a `plugin.toml` with the manifest fields. The runtime manifest interface stays the same — only the source changes.

**`providerType` is an extensible union.** New provider types (e.g., `'tool'`, `'hook'`) are added to the union as they're built. No shared base interface between provider types — the manifest is the only common thread.

### D6: Configuration via config.toml sections

Each provider gets a top-level section in `config.toml`, keyed by provider name. The provider declares its config shape via a Zod schema.

```toml
[slack]
debounceMs = 2000

[slack.reactions]
received = "eyes"
working = "hammer"

[ws]
port = 9800
host = "127.0.0.1"
```

**This already works.** The current `ConfigSchema` has optional `slack` and `ws` sections with Zod validation. The pattern is formalized, not invented:

- Section key = provider name
- Section present = provider enabled (unless env vars gate it, like Slack tokens)
- Zod schema defines shape and defaults
- `config.defaults.toml` provides package defaults; user `config.toml` overrides

**No changes to the config system.** Provider config schemas remain declared in `config.ts` as they are today. A future plugin system may allow providers to contribute their own Zod schemas, but that's out of scope.

### D7: Migration path — clean rename, no aliasing

`CommAdapter` is renamed to `CommunicationProvider` in place. All references updated in one pass. No type aliases, no backward compatibility shims, no transition period. The codebase is pre-production and all consumers are in this repo.

**Migration steps:**

1. **Replace `CommAdapter` with `CommunicationProvider`** — interface definition, all imports, all parameter types, all references
2. **Add new members to the interface** — `manifest`, `start()`, `stop()`, `isReady()`
3. **Update all three adapter implementations** to conform
4. **Build `CommunicationRegistry`** — wire it in `index.ts`
5. **Remove `filteredSend()` standalone function** if broadcast on the registry replaces it (or keep if still useful for single-provider sends)

**Adapter migration notes:**

| Adapter | Changes needed |
|---------|----------------|
| `CliAdapter` | Add manifest, no-op start/stop, `isReady() → true` |
| `WsAdapter` | Add manifest, has start/stop already, add `isReady()` |
| `SlackAdapter` | Add manifest, extract start from `startSlackApp()`, add stop/isReady |

`SlackAdapter` requires the most work — its lifecycle is currently managed by `startSlackApp()` in `slack.ts`, which handles Bolt SDK initialization, event binding, and the adapter is constructed inside that function. This will need restructuring to expose lifecycle on the provider.

### D8: DispatchStoreProvider retroactive alignment — closing the D14 gap

Event System v2 D14 committed to the plugin/provider two-layer model but only the provider layer shipped. `DispatchStoreProvider` has the interface and a pluggable implementation (`JsonFileDispatchStore`) but no plugin metadata. This spec closes that gap by retrofitting the manifest.

| Aspect | Status |
|--------|--------|
| Interface defined | Yes — `DispatchStoreProvider` in `dispatch-store.ts` |
| Implementation pluggable | Yes — `JsonFileDispatchStore` |
| Singleton access | Yes — `getDispatchStore()` |
| Config section | No (uses file paths from `paths.ts`) |
| Plugin manifest | **Missing** — must be added as part of this initiative |

**Action:** Add a `manifest` property to the `DispatchStoreProvider` interface and implement it on `JsonFileDispatchStore`, returning a `PluginManifest` with `providerType: 'dispatch-store'`. This brings the first provider type into conformance with the architecture that D14 described and this spec formalizes.

The dispatch store does not join the `CommunicationRegistry` (wrong provider type). A future `ProviderRegistry` or per-type registries may unify lifecycle management across all provider types — that's out of scope here.

## Design Constraints

- **Bidirectional interface, transport-agnostic.** The `CommunicationProvider` interface covers outbound (`send`, `setStatus`), inbound (`onInbound`), and lifecycle (`start`, `stop`, `isReady`). Transport complexity stays inside the provider.
- **Registry broadcasts everything.** `handleTask()` and `draftAgent()` take the registry. All activity is visible to all connected providers. The originating provider gets its direct response via `InboundResult`.
- **No shared base interface across provider types.** `CommunicationProvider` and `DispatchStoreProvider` are independent interfaces. The `PluginManifest` is the only shared structure.
- **In-code manifests only.** No file-based plugin discovery, no dynamic loading. Manifests are properties on provider classes.
- **Config system unchanged.** Provider config lives in `config.toml` sections, validated by Zod schemas in `config.ts`. No plugin-contributed schemas yet.
- **Best-effort startup.** Provider failures don't block the harness. Failed providers stay not-ready; broadcast skips them.
- **No aliasing, no versioning.** Clean rename from `CommAdapter` to `CommunicationProvider`. Breaking changes are fine pre-production.
- **Verbose naming.** `CommunicationProvider`, `CommunicationRegistry`, `PluginManifest` — not abbreviated forms.

## Out of Scope

- **Plugin discovery from disk** — dynamic loading from `~/.collabot/plugins/` directories
- **ToolProvider / HookProvider interfaces** — future provider types, not defined here
- **WsAdapter JSON-RPC method redesign** — the RPC surface works; restructuring it is separate
- **Unified ProviderRegistry** — a single registry across all provider types (comm, dispatch store, future types)
- **Provider-contributed config schemas** — providers declaring their own Zod schemas for dynamic config sections
- **SlackAdapter implementation** — that's Initiative #3; this spec defines what it must conform to

---

## Sign-off

- [x] Design discussion completed — 2026-03-01
