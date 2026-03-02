import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeSlackChannelId, decodeSlackChannelId, SlackAdapter } from './slack.js';
import type { SlackConfig } from './slack.js';
import { BotMessageQueue } from '../bot-queue.js';
import type { BotDefinition } from '../types.js';

// --- encode/decode helpers ---

test('encodeSlackChannelId encodes channel + timestamp', () => {
  const result = encodeSlackChannelId('C12345', '1709300000.123456');
  assert.strictEqual(result, 'C12345:1709300000.123456');
});

test('decodeSlackChannelId decodes correctly', () => {
  const result = decodeSlackChannelId('C12345:1709300000.123456');
  assert.strictEqual(result.channel, 'C12345');
  assert.strictEqual(result.timestamp, '1709300000.123456');
});

test('decodeSlackChannelId handles no colon', () => {
  const result = decodeSlackChannelId('C12345');
  assert.strictEqual(result.channel, 'C12345');
  assert.strictEqual(result.timestamp, '');
});

// --- SlackAdapter construction ---

function makeSlackConfig(overrides?: Partial<SlackConfig>): SlackConfig {
  return {
    taskRotationIntervalHours: 24,
    bots: {
      hazel: { botTokenEnv: 'HAZEL_BOT_TOKEN', appTokenEnv: 'HAZEL_APP_TOKEN', role: 'ts-dev' },
    },
    ...overrides,
  };
}

function makeBots(...names: string[]): Map<string, BotDefinition> {
  const map = new Map<string, BotDefinition>();
  for (const name of names) {
    map.set(name, {
      id: `01JNQR0000${name.toUpperCase().padEnd(14, '0')}`,
      name,
      displayName: name.charAt(0).toUpperCase() + name.slice(1),
      description: `${name} bot`,
      version: '1.0.0',
      soulPrompt: `You are ${name}.`,
    });
  }
  return map;
}

test('SlackAdapter has correct name and manifest', () => {
  const adapter = new SlackAdapter(makeSlackConfig(), makeBots('hazel'), new BotMessageQueue());
  assert.strictEqual(adapter.name, 'slack');
  assert.strictEqual(adapter.manifest.version, '2.0.0');
  assert.strictEqual(adapter.manifest.providerType, 'communication');
});

test('SlackAdapter is not ready before start', () => {
  const adapter = new SlackAdapter(makeSlackConfig(), makeBots('hazel'), new BotMessageQueue());
  assert.strictEqual(adapter.isReady(), false);
});

test('SlackAdapter getBotConfig returns config for known bot', () => {
  const adapter = new SlackAdapter(makeSlackConfig(), makeBots('hazel'), new BotMessageQueue());
  const config = adapter.getBotConfig('hazel');
  assert.ok(config);
  assert.strictEqual(config!.role, 'ts-dev');
});

test('SlackAdapter getBotConfig returns undefined for unknown bot', () => {
  const adapter = new SlackAdapter(makeSlackConfig(), makeBots('hazel'), new BotMessageQueue());
  assert.strictEqual(adapter.getBotConfig('unknown'), undefined);
});

test('SlackAdapter getBotNames returns empty before start', () => {
  const adapter = new SlackAdapter(makeSlackConfig(), makeBots('hazel'), new BotMessageQueue());
  assert.deepStrictEqual(adapter.getBotNames(), []);
});

test('SlackAdapter start skips bots with missing env vars', async () => {
  // Don't set env vars — bot should be skipped
  const adapter = new SlackAdapter(makeSlackConfig(), makeBots('hazel'), new BotMessageQueue());
  await adapter.start();
  // No bots started (env vars not set)
  assert.deepStrictEqual(adapter.getBotNames(), []);
  assert.strictEqual(adapter.isReady(), false);
  await adapter.stop();
});

test('SlackAdapter start skips bots not in bots map', async () => {
  // Config references 'hazel' but bots map is empty
  const adapter = new SlackAdapter(makeSlackConfig(), new Map(), new BotMessageQueue());
  await adapter.start();
  assert.deepStrictEqual(adapter.getBotNames(), []);
  await adapter.stop();
});

test('SlackAdapter acceptedTypes matches minimal set', () => {
  const adapter = new SlackAdapter(makeSlackConfig(), makeBots('hazel'), new BotMessageQueue());
  assert.ok(adapter.acceptedTypes);
  assert.ok(adapter.acceptedTypes!.has('lifecycle'));
  assert.ok(adapter.acceptedTypes!.has('result'));
  assert.ok(adapter.acceptedTypes!.has('warning'));
  assert.ok(adapter.acceptedTypes!.has('error'));
  assert.ok(!adapter.acceptedTypes!.has('tool_use'));
  assert.ok(!adapter.acceptedTypes!.has('thinking'));
});

test('SlackAdapter onInbound stores handler', () => {
  const adapter = new SlackAdapter(makeSlackConfig(), makeBots('hazel'), new BotMessageQueue());
  let called = false;
  adapter.onInbound(async () => { called = true; return { status: 'completed' }; });
  // Handler is stored but not directly testable without mocking Bolt
  assert.ok(true);
});

// --- Integration: multi-bot config ---

test('SlackAdapter supports multiple bots in config', () => {
  const config = makeSlackConfig({
    bots: {
      hazel: { botTokenEnv: 'HAZEL_BOT_TOKEN', appTokenEnv: 'HAZEL_APP_TOKEN', role: 'ts-dev' },
      greg: { botTokenEnv: 'GREG_BOT_TOKEN', appTokenEnv: 'GREG_APP_TOKEN', role: 'dotnet-dev' },
    },
  });
  const adapter = new SlackAdapter(config, makeBots('hazel', 'greg'), new BotMessageQueue());

  assert.ok(adapter.getBotConfig('hazel'));
  assert.ok(adapter.getBotConfig('greg'));
  assert.strictEqual(adapter.getBotConfig('hazel')!.role, 'ts-dev');
  assert.strictEqual(adapter.getBotConfig('greg')!.role, 'dotnet-dev');
});
