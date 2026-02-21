import type { WebClient } from '@slack/web-api';
import type { CommAdapter, ChannelMessage } from '../comms.js';
import type { Config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Encodes Slack channel + timestamp into a single channelId string.
 * The CommAdapter interface uses a single channelId, but Slack needs both.
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

export class SlackAdapter implements CommAdapter {
  readonly name = 'slack';
  readonly acceptedTypes = MINIMAL_TYPES;

  constructor(
    private client: WebClient,
    private config: Config,
  ) {}

  async send(msg: ChannelMessage): Promise<void> {
    const { channel } = decodeSlackChannelId(msg.channelId);
    const threadTs = msg.channelId.includes(':')
      ? decodeSlackChannelId(msg.channelId).timestamp
      : undefined;

    try {
      await this.client.chat.postMessage({
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
    const { channel, timestamp } = decodeSlackChannelId(channelId);
    if (!timestamp) return;

    const reactions = this.config.slack?.reactions;
    if (!reactions) return;

    switch (status) {
      case 'received':
        await safeReaction(() => this.client.reactions.add({ channel, timestamp, name: reactions.received }));
        break;
      case 'working':
        await safeReaction(() => this.client.reactions.remove({ channel, timestamp, name: reactions.received }));
        await safeReaction(() => this.client.reactions.add({ channel, timestamp, name: reactions.working }));
        break;
      case 'completed':
        await safeReaction(() => this.client.reactions.remove({ channel, timestamp, name: reactions.working }));
        await safeReaction(() => this.client.reactions.add({ channel, timestamp, name: reactions.success }));
        break;
      case 'failed':
        await safeReaction(() => this.client.reactions.remove({ channel, timestamp, name: reactions.working }));
        await safeReaction(() => this.client.reactions.add({ channel, timestamp, name: reactions.failure }));
        break;
    }
  }
}
