import { ulid } from 'ulid';
import { logger } from './logger.js';

export type QueuedMessage = {
  id: string;
  botName: string;
  content: string;
  metadata: Record<string, unknown>;
  enqueuedAt: string;
};

export type MessageHandler = (msg: QueuedMessage) => Promise<void>;

/**
 * Per-bot FIFO message queue. Each bot processes one message at a time.
 * While a bot is busy, incoming messages are queued and processed in order.
 */
export class BotMessageQueue {
  private queues = new Map<string, QueuedMessage[]>();
  private busy = new Map<string, boolean>();
  private handler: MessageHandler | undefined;

  setHandler(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Enqueue a message for a bot. Processes immediately if the bot is free. */
  enqueue(msg: Omit<QueuedMessage, 'id' | 'enqueuedAt'>): void {
    const full: QueuedMessage = {
      ...msg,
      id: ulid(),
      enqueuedAt: new Date().toISOString(),
    };

    if (!this.busy.get(msg.botName)) {
      this.processNext(msg.botName, full);
    } else {
      const queue = this.queues.get(msg.botName) ?? [];
      queue.push(full);
      this.queues.set(msg.botName, queue);
      logger.debug({ botName: msg.botName, queueDepth: queue.length }, 'message queued (bot busy)');
    }
  }

  isBusy(botName: string): boolean {
    return this.busy.get(botName) === true;
  }

  queueDepth(botName: string): number {
    return this.queues.get(botName)?.length ?? 0;
  }

  private async processNext(botName: string, msg: QueuedMessage): Promise<void> {
    if (!this.handler) {
      logger.warn({ botName }, 'BotMessageQueue: no handler set, dropping message');
      return;
    }

    this.busy.set(botName, true);

    try {
      await this.handler(msg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ botName, error: message }, 'BotMessageQueue: handler error');
    }

    this.busy.set(botName, false);

    // Process next queued message for this bot
    const queue = this.queues.get(botName);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      this.processNext(botName, next);
    }
  }
}
