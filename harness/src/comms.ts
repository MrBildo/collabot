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

/** The adapter interface — each interface (Slack, CLI, etc.) implements this */
export interface CommAdapter {
  readonly name: string;

  /**
   * Message types this adapter accepts. If undefined, all types are accepted.
   * Used by filteredSend() to skip messages the adapter doesn't want (e.g.,
   * Slack doesn't need tool_use/thinking — only the TUI's WS adapter does).
   */
  readonly acceptedTypes?: ReadonlySet<ChannelMessage['type']>;

  /** Send a message to a channel */
  send(msg: ChannelMessage): Promise<void>;

  /** Update channel status (e.g., reactions in Slack, spinner in CLI) */
  setStatus(channelId: string, status: 'received' | 'working' | 'completed' | 'failed'): Promise<void>;
}

/** Send a message to an adapter, respecting its acceptedTypes filter. */
export function filteredSend(adapter: CommAdapter, msg: ChannelMessage): Promise<void> {
  if (adapter.acceptedTypes && !adapter.acceptedTypes.has(msg.type)) {
    return Promise.resolve();
  }
  return adapter.send(msg);
}

// NOTE: Channel and Participant types are intentionally deferred.
// They will be defined when bot-to-bot communication (chatrooms, knowledge sharing) is built.
// The current CommAdapter interface is designed to accommodate them without breaking changes.
