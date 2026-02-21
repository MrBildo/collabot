import { App, LogLevel } from '@slack/bolt';
import { logger } from './logger.js';
import { handleTask } from './core.js';
import type { McpServers } from './core.js';
import { Debouncer } from './debounce.js';
import { SlackAdapter, encodeSlackChannelId } from './adapters/slack.js';
import type { InboundMessage } from './comms.js';
import type { RoleDefinition } from './types.js';
import type { Config } from './config.js';

export async function startSlackApp(
  token: string,
  appToken: string,
  roles: Map<string, RoleDefinition>,
  config: Config,
  mcpServers?: McpServers,
): Promise<App> {
  const app = new App({
    token,
    appToken,
    socketMode: true,
    logLevel: LogLevel.ERROR,
  });

  const adapter = new SlackAdapter(app.client, config);
  const debounceMs = config.slack?.debounceMs ?? 2000;
  const debouncer = new Debouncer<string>(debounceMs);

  let agentBusy = false;

  app.message(async ({ message, client }) => {
    if ('subtype' in message && message.subtype !== undefined) return;

    const text = 'text' in message ? (message.text ?? '') : '';
    const user = 'user' in message ? message.user : undefined;
    const messageTs = message.ts;
    const channel = message.channel;
    // Thread root: for replies this is thread_ts (the parent message's ts).
    // For top-level messages, it's the message's own ts.
    // This is the stable identifier that matches across all messages in a thread.
    const threadRootTs = ('thread_ts' in message && message.thread_ts) ? message.thread_ts : messageTs;
    // Thread key: use thread_ts if in a thread, otherwise the channel itself.
    // In DMs, each message has a unique ts but the channel IS the conversation,
    // so grouping by channel lets debounce combine rapid sequential DMs.
    const threadKey = ('thread_ts' in message && message.thread_ts) ? message.thread_ts : channel;

    logger.info({ user, channel, text }, 'inbound message');
    logger.flush();

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
          // Use the adapter's client directly for busy responses
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

        handleTask(inbound, adapter, roles, config, undefined, mcpServers)
          .catch((err: unknown) => {
            logger.error({ err }, 'message handler error');
          })
          .finally(() => {
            agentBusy = false;
          });
      },
      { firstMessageTs: messageTs, threadRootTs, channel },
    );

    // Received reaction — only on first message in debounce window
    if (isFirst) {
      adapter.setStatus(encodeSlackChannelId(channel, messageTs), 'received')
        .catch(() => { /* non-fatal */ });
    }
  });

  app.error(async (error) => {
    logger.error({ err: error }, 'Slack app error');
  });

  await app.start();
  return app;
}
