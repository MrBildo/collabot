import type { CommAdapter, ChannelMessage } from '../comms.js';
import { logger } from '../logger.js';

/** Minimal set: lifecycle events + results + warnings/errors + questions. No verbose SDK stream events. */
const MINIMAL_TYPES: ReadonlySet<ChannelMessage['type']> = new Set([
  'lifecycle', 'question', 'result', 'warning', 'error',
]);

export class CliAdapter implements CommAdapter {
  readonly name = 'cli';
  readonly acceptedTypes = MINIMAL_TYPES;

  async send(msg: ChannelMessage): Promise<void> {
    const prefix = msg.type === 'result' ? '' : `[${msg.type}] `;
    logger.info({ from: msg.from, type: msg.type }, `${prefix}${msg.from}: ${msg.content}`);
  }

  async setStatus(channelId: string, status: 'received' | 'working' | 'completed' | 'failed'): Promise<void> {
    logger.info({ channelId, status }, `[${status}] ${channelId}`);
  }
}
