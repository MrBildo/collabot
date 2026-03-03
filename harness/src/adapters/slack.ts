import { App, LogLevel } from '@slack/bolt';
import type { CommunicationProvider, ChannelMessage, PluginManifest, InboundHandler, VirtualProjectRequest } from '../comms.js';
import type { BotMessageQueue } from '../bot-queue.js';
import type { BotDefinition } from '../types.js';
import { logger } from '../logger.js';

// ── Slack Etiquette Skill ────────────────────────────────────

export const SLACK_ETIQUETTE = `You are responding in Slack. Follow these conventions:

**Formatting:** Use Slack mrkdwn, not standard markdown.
- Bold: *bold* (single asterisks, not double)
- Italic: _italic_ (underscores)
- Strikethrough: ~strikethrough~
- Code: \`inline code\` and \`\`\`code blocks\`\`\`
- Lists: use simple dashes or numbers, no nested indentation
- Links: <url|display text>
- No headings (# syntax doesn't render in Slack)

**Tone:** Be conversational and concise. You're a teammate in a chat, not writing documentation. Keep responses short — prefer a few sentences over paragraphs. Use line breaks between distinct thoughts.

**Tool awareness:** You have restricted tool access in this context. You cannot edit files, run shell commands, or write code directly. Focus on conversation, analysis, research, and guidance. If asked to do something requiring restricted tools, explain what you'd do and suggest the user dispatch a coding agent for the work.

**Behavior:** Respond naturally to greetings, questions, and casual conversation. You don't need to frame everything as a task. Be helpful, direct, and personable.`;

// ── Slack Virtual Project ────────────────────────────────────

const SLACK_ROOM_DISALLOWED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit'];

// ── Channel encoding ────────────────────────────────────────────

export function encodeSlackChannelId(channel: string, timestamp: string): string {
  return `${channel}:${timestamp}`;
}

export function decodeSlackChannelId(channelId: string): { channel: string; timestamp: string } {
  const idx = channelId.indexOf(':');
  if (idx === -1) {
    return { channel: channelId, timestamp: '' };
  }
  return { channel: channelId.slice(0, idx), timestamp: channelId.slice(idx + 1) };
}

// ── Types ────────────────────────────────────────────────────────

export type SlackBotConfig = {
  botTokenEnv: string;
  appTokenEnv: string;
};

export type SlackConfig = {
  defaultRole?: string;
  taskRotationIntervalHours: number;
  bots: Record<string, SlackBotConfig>;
};

type SlackBotInstance = {
  botName: string;
  app: App;
};

// ── SlackAdapter ─────────────────────────────────────────────────

/** Minimal set: lifecycle events + results + warnings/errors + questions. */
const MINIMAL_TYPES: ReadonlySet<ChannelMessage['type']> = new Set([
  'lifecycle', 'question', 'result', 'warning', 'error',
]);

export class SlackAdapter implements CommunicationProvider {
  readonly name = 'slack';
  readonly manifest: PluginManifest = {
    id: 'collabot.communication.slack',
    name: 'Slack Adapter',
    version: '2.0.0',
    description: 'Multi-bot Slack integration via Bolt SDK Socket Mode.',
    providerType: 'communication',
  };
  readonly acceptedTypes = MINIMAL_TYPES;

  private instances = new Map<string, SlackBotInstance>();
  private handler: InboundHandler | undefined;
  private started = false;

  constructor(
    private slackConfig: SlackConfig,
    private bots: Map<string, BotDefinition>,
    private botQueue: BotMessageQueue,
  ) {}

  async start(): Promise<void> {
    for (const [botName, botConfig] of Object.entries(this.slackConfig.bots)) {
      const token = process.env[botConfig.botTokenEnv];
      const appToken = process.env[botConfig.appTokenEnv];

      if (!token || !appToken) {
        logger.warn({ botName, botTokenEnv: botConfig.botTokenEnv, appTokenEnv: botConfig.appTokenEnv },
          'Slack bot skipped — missing env vars');
        continue;
      }

      if (!this.bots.has(botName)) {
        logger.warn({ botName }, 'Slack bot skipped — no bot definition found');
        continue;
      }

      const app = new App({
        token,
        appToken,
        socketMode: true,
        logLevel: LogLevel.ERROR,
      });

      // DM + @mention handler
      app.message(async ({ message }) => {
        if ('subtype' in message && message.subtype !== undefined) return;

        const text = 'text' in message ? (message.text ?? '') : '';
        if (!text.trim()) return;

        const user = 'user' in message ? message.user : undefined;
        const channel = message.channel;
        const messageTs = message.ts;

        logger.info({ botName, user, channel, text: text.slice(0, 200) }, 'slack bot inbound message');

        this.botQueue.enqueue({
          botName,
          content: text,
          metadata: { channel, messageTs, user, source: 'slack' },
        });
      });

      app.event('app_mention', async ({ event }) => {
        const text = event.text ?? '';
        if (!text.trim()) return;

        const user = event.user;
        const channel = event.channel;
        const messageTs = event.ts;

        logger.info({ botName, user, channel, text: text.slice(0, 200) }, 'slack bot @mention');

        this.botQueue.enqueue({
          botName,
          content: text,
          metadata: { channel, messageTs, user, source: 'slack' },
        });
      });

      app.error(async (error) => {
        logger.error({ err: error, botName }, 'Slack bot app error');
      });

      try {
        await app.start();
        this.instances.set(botName, { botName, app });
        logger.info({ botName }, 'Slack bot started');
      } catch (err) {
        logger.error({ err, botName }, 'Failed to start Slack bot');
      }
    }

    this.started = this.instances.size > 0;
  }

  async stop(): Promise<void> {
    for (const [botName, instance] of this.instances) {
      try {
        await instance.app.stop();
        logger.info({ botName }, 'Slack bot stopped');
      } catch (err) {
        logger.error({ err, botName }, 'Failed to stop Slack bot');
      }
    }
    this.instances.clear();
    this.started = false;
  }

  isReady(): boolean {
    return this.started;
  }

  onInbound(handler: InboundHandler): void {
    this.handler = handler;
  }

  /**
   * Send a message to Slack. Routes to the correct bot's client via metadata.botName.
   * Messages without a botName target are sent via the first available bot.
   */
  async send(msg: ChannelMessage): Promise<void> {
    const botName = msg.metadata?.['botName'] as string | undefined;

    let instance: SlackBotInstance | undefined;
    if (botName) {
      instance = this.instances.get(botName);
    }
    if (!instance) {
      // Fallback: use first available bot
      instance = this.instances.values().next().value;
    }
    if (!instance) return;

    const { channel } = decodeSlackChannelId(msg.channelId);

    try {
      await instance.app.client.chat.postMessage({
        channel,
        text: msg.content,
      });
    } catch (err) {
      logger.error({ err, channelId: msg.channelId, botName: instance.botName }, 'SlackAdapter: failed to send message');
    }
  }

  async setStatus(_channelId: string, _status: 'received' | 'working' | 'completed' | 'failed'): Promise<void> {
    // No-op — bots handle acknowledgment conversationally, not via mechanical reactions
  }

  /** Get the config for a specific bot (used by integration wiring). */
  getBotConfig(botName: string): SlackBotConfig | undefined {
    return this.slackConfig.bots[botName];
  }

  /** Get a running bot instance (for direct client access). */
  getInstance(botName: string): SlackBotInstance | undefined {
    return this.instances.get(botName);
  }

  /** Get all running bot names. */
  getBotNames(): string[] {
    return [...this.instances.keys()];
  }

  // ── Provider Interrogation ──────────────────────────────────

  /** Return the slack-room virtual project with tool restrictions and slack-etiquette skill. */
  getVirtualProjects(): VirtualProjectRequest[] {
    return [{
      name: 'slack-room',
      description: 'Slack communication surface for bot conversations',
      roles: [],  // empty = all loaded roles
      disallowedTools: SLACK_ROOM_DISALLOWED_TOOLS,
      skills: [{
        name: 'slack-etiquette',
        content: SLACK_ETIQUETTE,
      }],
    }];
  }

  // ── Presence Management ─────────────────────────────────────

  /** Set Slack presence for a bot. Requires the bot's Slack app to be started. */
  async setPresence(botName: string, presence: 'auto' | 'away'): Promise<void> {
    const instance = this.instances.get(botName);
    if (!instance) {
      logger.debug({ botName, presence }, 'setPresence: bot not started, skipping');
      return;
    }

    try {
      await instance.app.client.users.setPresence({ presence });
      logger.debug({ botName, presence }, 'Slack presence set');
    } catch (err) {
      logger.warn({ err, botName, presence }, 'Failed to set Slack presence');
    }
  }
}
