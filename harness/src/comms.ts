/** An inbound message from any interface */
export interface InboundMessage {
  id: string;
  content: string;
  threadId: string;        // conversation grouping key
  source: string;          // 'slack', 'cli', 'http', etc.
  project?: string;        // project name — required at runtime, optional for type compatibility
  role?: string;           // pre-resolved role
  metadata?: Record<string, unknown>;
}

/** A message flowing through the communication layer */
export interface ChannelMessage {
  id: string;
  channelId: string;
  from: string;            // participant identifier (role name, 'harness', 'human')
  timestamp: Date;
  type: 'lifecycle' | 'chat' | 'question' | 'result' | 'warning' | 'error' | 'tool_use' | 'thinking';
  content: string;
  metadata?: Record<string, unknown>;
}

// ── Plugin Manifest ─────────────────────────────────────────────

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

// ── Inbound ─────────────────────────────────────────────────────

/** Result of processing an inbound message. */
export interface InboundResult {
  status: 'completed' | 'aborted' | 'crashed';
  summary?: string;
}

/** Handler that the harness registers to receive inbound messages. */
export type InboundHandler = (msg: InboundMessage) => Promise<InboundResult>;

// ── CommunicationProvider ───────────────────────────────────────

/** The provider interface — each interface (Slack, CLI, WS, etc.) implements this */
export interface CommunicationProvider {
  /** Provider identity — matches config section name. */
  readonly name: string;

  /** Plugin manifest — identity, version, config schema. */
  readonly manifest: PluginManifest;

  /**
   * Message types this provider accepts. If undefined, all types are accepted.
   * Used by filteredSend() to skip messages the provider doesn't want (e.g.,
   * Slack doesn't need tool_use/thinking — only the TUI's WS adapter does).
   */
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

  /** Update channel status (e.g., reactions in Slack, spinner in CLI) */
  setStatus(channelId: string, status: 'received' | 'working' | 'completed' | 'failed'): Promise<void>;

  // ── Inbound ──

  /** Register the harness handler for inbound messages. Called once at startup. */
  onInbound(handler: InboundHandler): void;
}

/** Send a message to a provider, respecting its acceptedTypes filter. */
export function filteredSend(provider: CommunicationProvider, msg: ChannelMessage): Promise<void> {
  if (provider.acceptedTypes && !provider.acceptedTypes.has(msg.type)) {
    return Promise.resolve();
  }
  return provider.send(msg);
}

// NOTE: Channel and Participant types are intentionally deferred.
// They will be defined when bot-to-bot communication (chatrooms, knowledge sharing) is built.
// The current CommunicationProvider interface is designed to accommodate them without breaking changes.
