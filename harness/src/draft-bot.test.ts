import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { draftBot } from './collab-dispatch.js';
import { AgentPool } from './pool.js';
import type { BotDefinition } from './types.js';

function makeBot(name: string, id = `01TESTBOT${name.toUpperCase().padEnd(16, '0')}`): BotDefinition {
  return {
    id,
    name,
    description: `Test bot ${name}`,
    version: '1.0.0',
    soulPrompt: 'You are a test bot.',
  };
}

function makeBots(...names: string[]): Map<string, BotDefinition> {
  const map = new Map<string, BotDefinition>();
  for (const name of names) {
    map.set(name, makeBot(name));
  }
  return map;
}

describe('draftBot — botId matching', () => {
  test('detects busy bot by botId', () => {
    const bots = makeBots('hazel', 'cedar');
    const pool = new AgentPool();
    const hazel = bots.get('hazel')!;

    // Register an agent with hazel's botId
    pool.register({
      id: 'some-agent-id-123',
      role: 'researcher',
      botId: hazel.id,
      botName: 'hazel',
      startedAt: new Date(),
      controller: new AbortController(),
    });

    const result = draftBot('hazel', bots, pool);
    assert.equal(result.status, 'unavailable');
    if (result.status === 'unavailable') {
      assert.match(result.reason, /busy/);
    }
  });

  test('finds available bot when pool has unrelated agents', () => {
    const bots = makeBots('hazel', 'cedar');
    const pool = new AgentPool();

    // Register an agent without any botId (non-bot dispatch)
    pool.register({
      id: 'rolename-1234-abcd',
      role: 'researcher',
      startedAt: new Date(),
      controller: new AbortController(),
    });

    const result = draftBot('hazel', bots, pool);
    assert.equal(result.status, 'available');
    if (result.status === 'available') {
      assert.equal(result.bot.name, 'hazel');
    }
  });

  test('picks first available bot when no name specified', () => {
    const bots = makeBots('hazel', 'cedar', 'fern');
    const pool = new AgentPool();
    const hazel = bots.get('hazel')!;

    // hazel is busy
    pool.register({
      id: 'bot-hazel-123',
      role: 'researcher',
      botId: hazel.id,
      botName: 'hazel',
      startedAt: new Date(),
      controller: new AbortController(),
    });

    // No bot name specified — should pick cedar (first available after hazel)
    const result = draftBot(undefined, bots, pool);
    assert.equal(result.status, 'available');
    if (result.status === 'available') {
      assert.equal(result.bot.name, 'cedar');
    }
  });

  test('returns unavailable when all bots are busy', () => {
    const bots = makeBots('hazel', 'cedar');
    const pool = new AgentPool();

    for (const bot of bots.values()) {
      pool.register({
        id: `agent-${bot.name}`,
        role: 'researcher',
        botId: bot.id,
        botName: bot.name,
        startedAt: new Date(),
        controller: new AbortController(),
      });
    }

    const result = draftBot(undefined, bots, pool);
    assert.equal(result.status, 'unavailable');
    if (result.status === 'unavailable') {
      assert.match(result.reason, /No bots available/);
    }
  });

  test('returns unavailable for unknown bot name', () => {
    const bots = makeBots('hazel');
    const pool = new AgentPool();

    const result = draftBot('nonexistent', bots, pool);
    assert.equal(result.status, 'unavailable');
    if (result.status === 'unavailable') {
      assert.match(result.reason, /not found/);
    }
  });
});
