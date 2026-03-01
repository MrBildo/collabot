import { App, LogLevel } from '@slack/bolt';
import type { CommunicationProvider, ChannelMessage, PluginManifest, InboundHandler, InboundMessage } from '../comms.js';
import type { Config } from '../config.js';
import { logger } from '../logger.js';
import { Debouncer } from '../debounce.js';

/**
 * Encodes Slack channel + timestamp into a single channelId string.
 * The CommunicationProvider interface uses a single channelId, but Slack needs both.
 */
export function encodeSlackChannelId(channel: string, timestamp: string): string {
  return `${channel}:${timestamp}`;
}

/** Decodes a composite channelId back to channel + timestamp. */
export function decodeSlackChannelId(channelId: string): { channel: string; timestamp: string } {
  const idx = channelId.indexOf(':');
  if (idx === -1) {
    return { channel: channelId, timestamp: '' };
  }
  return { channel: channelId.slice(0, idx), timestamp: channelId.slice(idx + 1) };
}

async function safeReaction(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (_err: unknown) {
    // Reactions fail silently (already added/removed, or missing scope)
  }
}

/** Minimal set: lifecycle events + results + warnings/errors + questions. No verbose SDK stream events. */
const MINIMAL_TYPES: ReadonlySet<ChannelMessage['type']> = new Set([
  'lifecycle', 'question', 'result', 'warning', 'error',
]);

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
    const app = new App({
      token: this.token,
      appToken: this.appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    const debounceMs = this.config.slack?.debounceMs ?? 2000;
    const debouncer = new Debouncer<string>(debounceMs);
    let agentBusy = false;

    app.message(async ({ message, client }) => {
      if ('subtype' in message && message.subtype !== undefined) return;

      const text = 'text' in message ? (message.text ?? '') : '';
      const user = 'user' in message ? message.user : undefined;
      const messageTs = message.ts;
      const channel = message.channel;
      const threadRootTs = ('thread_ts' in message && message.thread_ts) ? message.thread_ts : messageTs;
      const threadKey = ('thread_ts' in message && message.thread_ts) ? message.thread_ts : channel;

      logger.info({ user, channel, text }, 'inbound message');

      const isFirst = !debouncer.has(threadKey);

      debouncer.debounce(
        threadKey,
        text,
        (items, metadata) => {
          const combined = items.join('\n');
          const firstTs = metadata?.['firstMessageTs'] as string;
          const threadRoot = metadata?.['threadRootTs'] as string;
          const msgChannel = metadata?.['channel'] as string;
          const channelId = encodeSlackChannelId(msgChannel, threadRoot);

          if (agentBusy) {
            client.chat.postMessage({
              channel: msgChannel,
              text: `I'm currently working on another task. I'll get to yours when I'm done.`,
              thread_ts: firstTs,
              username: 'KK Agent',
            }).catch((err: unknown) => {
              logger.error({ err }, 'failed to post busy message');
            });
            return;
          }

          agentBusy = true;

          const inbound: InboundMessage = {
            id: firstTs,
            content: combined,
            threadId: threadRoot,
            source: 'slack',
            metadata: { channelId, channel: msgChannel, firstMessageTs: firstTs, user },
          };

          if (this.handler) {
            this.handler(inbound)
              .catch((err: unknown) => {
                logger.error({ err }, 'Slack inbound handler error');
              })
              .finally(() => {
                agentBusy = false;
              });
          } else {
            agentBusy = false;
          }
        },
        { firstMessageTs: messageTs, threadRootTs, channel },
      );

      if (isFirst) {
        this.setStatus(encodeSlackChannelId(channel, messageTs), 'received')
          .catch(() => { /* non-fatal */ });
      }
    });

    app.error(async (error) => {
      logger.error({ err: error }, 'Slack app error');
    });

    await app.start();
    this.app = app;
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
    }
  }

  isReady(): boolean {
    return this.app !== null;
  }

  onInbound(handler: InboundHandler): void {
    this.handler = handler;
  }

  async send(msg: ChannelMessage): Promise<void> {
    if (!this.app) return;

    const { channel } = decodeSlackChannelId(msg.channelId);
    const threadTs = msg.channelId.includes(':')
      ? decodeSlackChannelId(msg.channelId).timestamp
      : undefined;

    try {
      await this.app.client.chat.postMessage({
        channel,
        text: msg.content,
        thread_ts: threadTs,
        username: msg.from,
      });
    } catch (err) {
      logger.error({ err, channelId: msg.channelId }, 'SlackAdapter: failed to send message');
    }
  }

  async setStatus(channelId: string, status: 'received' | 'working' | 'completed' | 'failed'): Promise<void> {
    if (!this.app) return;

    const { channel, timestamp } = decodeSlackChannelId(channelId);
    if (!timestamp) return;

    const reactions = this.config.slack?.reactions;
    if (!reactions) return;

    const client = this.app.client;
    switch (status) {
      case 'received':
        await safeReaction(() => client.reactions.add({ channel, timestamp, name: reactions.received }));
        break;
      case 'working':
        await safeReaction(() => client.reactions.remove({ channel, timestamp, name: reactions.received }));
        await safeReaction(() => client.reactions.add({ channel, timestamp, name: reactions.working }));
        break;
      case 'completed':
        await safeReaction(() => client.reactions.remove({ channel, timestamp, name: reactions.working }));
        await safeReaction(() => client.reactions.add({ channel, timestamp, name: reactions.success }));
        break;
      case 'failed':
        await safeReaction(() => client.reactions.remove({ channel, timestamp, name: reactions.working }));
        await safeReaction(() => client.reactions.add({ channel, timestamp, name: reactions.failure }));
        break;
    }
  }
}
