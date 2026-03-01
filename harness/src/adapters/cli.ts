import type { CommunicationProvider, ChannelMessage, PluginManifest, InboundHandler } from '../comms.js';
import { logger } from '../logger.js';

/** Minimal set: lifecycle events + results + warnings/errors + questions. No verbose SDK stream events. */
const MINIMAL_TYPES: ReadonlySet<ChannelMessage['type']> = new Set([
  'lifecycle', 'question', 'result', 'warning', 'error',
]);

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

  async start(): Promise<void> { /* no-op — stateless */ }
  async stop(): Promise<void> { /* no-op — stateless */ }
  isReady(): boolean { return true; }

  onInbound(handler: InboundHandler): void {
    this.handler = handler;
  }

  async send(msg: ChannelMessage): Promise<void> {
    const prefix = msg.type === 'result' ? '' : `[${msg.type}] `;
    logger.info({ from: msg.from, type: msg.type }, `${prefix}${msg.from}: ${msg.content}`);
  }

  async setStatus(channelId: string, status: 'received' | 'working' | 'completed' | 'failed'): Promise<void> {
    logger.info({ channelId, status }, `[${status}] ${channelId}`);
  }
}
