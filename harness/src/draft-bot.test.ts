import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { draftBot, collabDispatch, type CollabDispatchContext } from './collab-dispatch.js';
import { AgentPool } from './pool.js';
import type { BotDefinition, RoleDefinition } from './types.js';
import type { Project } from './project.js';
import type { Config } from './config.js';

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

// ── Virtual project guard ───────────────────────────────────

describe('collabDispatch — virtual project guard', () => {
  function makeCtx(projects: Map<string, Project>): CollabDispatchContext {
    const roles = new Map<string, RoleDefinition>();
    roles.set('researcher', {
      id: '01TESTROLE00000000000000000',
      version: '1.0.0',
      name: 'researcher',
      description: 'Test role',
      createdOn: '2026-01-01T00:00:00Z',
      createdBy: 'test',
      prompt: 'You are a researcher.',
      modelHint: 'sonnet-latest',
    } as RoleDefinition);

    return {
      config: {
        models: { default: 'claude-sonnet-4-6', aliases: {} },
        defaults: { stallTimeoutSeconds: 300, dispatchTimeoutMs: 0, tokenBudget: 0, maxBudgetUsd: 0 },
        agent: { maxTurns: 0, maxBudgetUsd: 0 },
        logging: { level: 'debug' },
        pool: { maxConcurrent: 0 },
        mcp: { streamTimeout: 600000 },
        cron: { enabled: false, jobsDirectory: 'cron' },
      } as Config,
      roles,
      bots: new Map(),
      projects,
      projectsDir: '/tmp',
      pool: new AgentPool(),
    };
  }

  test('rejects dispatch to virtual project', async () => {
    const projects = new Map<string, Project>();
    projects.set('lobby', {
      name: 'lobby',
      description: 'Virtual project',
      paths: ['/tmp/instance'],
      roles: ['researcher'],
      virtual: true,
    });

    const result = await collabDispatch({
      project: 'lobby',
      role: 'researcher',
      prompt: 'This should be rejected',
    }, makeCtx(projects));

    assert.equal(result.status, 'crashed');
    assert.match(result.result ?? '', /virtual project/i);
    assert.match(result.result ?? '', /bot sessions only/i);
  });

  test('allows dispatch to non-virtual project', async () => {
    const projects = new Map<string, Project>();
    projects.set('real-project', {
      name: 'real-project',
      description: 'A real project',
      paths: ['/tmp/real-project'],
      roles: ['researcher'],
      virtual: false,
    });

    // This will crash later (no SDK available) but it should NOT crash with "virtual project"
    const result = await collabDispatch({
      project: 'real-project',
      role: 'researcher',
      prompt: 'This should pass the virtual check',
    }, makeCtx(projects));

    // It won't be 'completed' (no SDK), but it should NOT say "virtual project"
    const errorText = result.result ?? '';
    assert.equal(errorText.includes('virtual project'), false, 'should not reject non-virtual project');
  });
});
