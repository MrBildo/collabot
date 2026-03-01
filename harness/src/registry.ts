import type { CommunicationProvider, ChannelMessage } from './comms.js';
import { filteredSend } from './comms.js';
import { logger } from './logger.js';

export class CommunicationRegistry {
  private registry: Map<string, CommunicationProvider> = new Map();

  /** Register a provider. Throws if a provider with the same name is already registered. */
  register(provider: CommunicationProvider): void {
    if (this.registry.has(provider.name)) {
      throw new Error(`CommunicationProvider '${provider.name}' is already registered`);
    }
    this.registry.set(provider.name, provider);
  }

  /** Typed lookup by name. */
  get<T extends CommunicationProvider>(name: string): T | undefined {
    return this.registry.get(name) as T | undefined;
  }

  /** Whether a provider with the given name is registered. */
  has(name: string): boolean {
    return this.registry.has(name);
  }

  /** All registered providers in registration order. */
  providers(): CommunicationProvider[] {
    return [...this.registry.values()];
  }

  /** Start all registered providers in registration order. Best-effort — failures are logged, provider stays not-ready. */
  async startAll(): Promise<void> {
    for (const provider of this.registry.values()) {
      try {
        await provider.start();
      } catch (err) {
        logger.error({ err, provider: provider.name }, 'failed to start provider');
      }
    }
  }

  /** Stop all registered providers in reverse registration order. Errors logged, never thrown. */
  async stopAll(): Promise<void> {
    const providers = [...this.registry.values()].reverse();
    for (const provider of providers) {
      try {
        await provider.stop();
      } catch (err) {
        logger.error({ err, provider: provider.name }, 'failed to stop provider');
      }
    }
  }

  /** Send to all ready providers, respecting acceptedTypes via filteredSend(). */
  async broadcast(msg: ChannelMessage): Promise<void> {
    const sends: Promise<void>[] = [];
    for (const provider of this.registry.values()) {
      if (provider.isReady()) {
        sends.push(filteredSend(provider, msg));
      }
    }
    await Promise.all(sends);
  }

  /** Set status on all ready providers. */
  async broadcastStatus(channelId: string, status: 'received' | 'working' | 'completed' | 'failed'): Promise<void> {
    const sends: Promise<void>[] = [];
    for (const provider of this.registry.values()) {
      if (provider.isReady()) {
        sends.push(provider.setStatus(channelId, status));
      }
    }
    await Promise.all(sends);
  }
}
