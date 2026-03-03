import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BotSessionManager } from './bot-session.js';
import type { BotSession } from './bot-session.js';
import { assembleBotPrompt } from './prompts.js';
import { AgentPool } from './pool.js';
import type { RoleDefinition, BotDefinition } from './types.js';

let tmpDir: string;

function makeRoles(...names: string[]): Map<string, RoleDefinition> {
  const map = new Map<string, RoleDefinition>();
  for (const name of names) {
    map.set(name, {
      id: '01HXYZ01234567890ABCDEFGH',
      version: '1.0.0',
      name,
      description: `${name} role.`,
      createdOn: '2026-02-24T15:00:00Z',
      createdBy: 'Test',
      displayName: name,
      modelHint: 'sonnet-latest',
      prompt: `You are ${name}`,
    });
  }
  return map;
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
      soulPrompt: `You are ${name}. Be helpful.`,
    });
  }
  return map;
}

function makeConfig() {
  return {
    models: {
      default: 'claude-sonnet-4-6',
      aliases: { 'sonnet-latest': 'claude-sonnet-4-6' },
    },
    defaults: { stallTimeoutSeconds: 300 },
    agent: { maxTurns: 50, maxBudgetUsd: 1.00 },
    logging: { level: 'debug' as const },
    routing: { default: 'product-analyst', rules: [] },
    pool: { maxConcurrent: 0 },
    mcp: { streamTimeout: 600000 },
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collabot-botsession-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- BotSessionManager unit tests (no SDK calls) ---

test('BotSessionManager.getSession returns null for unknown bot', () => {
  const manager = new BotSessionManager(makeConfig() as any, makeRoles('ts-dev'), makeBots('hazel'), new AgentPool());
  assert.strictEqual(manager.getSession('unknown'), null);
});

test('BotSessionManager.getSession returns null before any message', () => {
  const manager = new BotSessionManager(makeConfig() as any, makeRoles('ts-dev'), makeBots('hazel'), new AgentPool());
  assert.strictEqual(manager.getSession('hazel'), null);
});

test('BotSessionManager.loadSessions recovers from disk', () => {
  const taskDir = path.join(tmpDir, 'lobby', 'tasks', 'session-2026-03-01');
  fs.mkdirSync(taskDir, { recursive: true });

  const session: BotSession = {
    botName: 'hazel',
    sessionId: '11111111-1111-1111-1111-111111111111',
    dispatchId: '01JNQR000000000000000TEST',
    project: 'lobby',
    taskSlug: 'session-2026-03-01',
    taskDir,
    role: 'ts-dev',
    startedAt: '2026-03-01T10:00:00Z',
    lastActivityAt: '2026-03-01T10:05:00Z',
    turnCount: 3,
    sessionInitialized: true,
    cumulativeCostUsd: 0.05,
  };

  fs.writeFileSync(path.join(taskDir, 'bot-session-hazel.json'), JSON.stringify(session));

  const manager = new BotSessionManager(makeConfig() as any, makeRoles('ts-dev'), makeBots('hazel'), new AgentPool());

  const projects = new Map([['lobby', { name: 'lobby' }]]);
  manager.loadSessions(tmpDir, projects);

  const recovered = manager.getSession('hazel');
  assert.ok(recovered);
  assert.strictEqual(recovered!.sessionId, '11111111-1111-1111-1111-111111111111');
  assert.strictEqual(recovered!.turnCount, 3);
  assert.strictEqual(recovered!.cumulativeCostUsd, 0.05);
});

test('BotSessionManager.loadSessions skips bots not in loaded bots map', () => {
  const taskDir = path.join(tmpDir, 'lobby', 'tasks', 'session-test');
  fs.mkdirSync(taskDir, { recursive: true });

  const session: BotSession = {
    botName: 'deleted-bot',
    sessionId: '22222222-2222-2222-2222-222222222222',
    dispatchId: '01JNQR000000000000000DEL0',
    project: 'lobby',
    taskSlug: 'session-test',
    taskDir,
    role: 'ts-dev',
    startedAt: '2026-03-01T10:00:00Z',
    lastActivityAt: '2026-03-01T10:05:00Z',
    turnCount: 1,
    sessionInitialized: true,
    cumulativeCostUsd: 0,
  };

  fs.writeFileSync(path.join(taskDir, 'bot-session-deleted-bot.json'), JSON.stringify(session));

  // Only 'hazel' in bots map, not 'deleted-bot'
  const manager = new BotSessionManager(makeConfig() as any, makeRoles('ts-dev'), makeBots('hazel'), new AgentPool());
  manager.loadSessions(tmpDir, new Map([['lobby', { name: 'lobby' }]]));

  assert.strictEqual(manager.getSession('deleted-bot'), null);
});

test('BotSessionManager.loadSessions handles corrupt JSON gracefully', () => {
  const taskDir = path.join(tmpDir, 'lobby', 'tasks', 'session-corrupt');
  fs.mkdirSync(taskDir, { recursive: true });

  fs.writeFileSync(path.join(taskDir, 'bot-session-hazel.json'), 'not json {{{');

  const manager = new BotSessionManager(makeConfig() as any, makeRoles('ts-dev'), makeBots('hazel'), new AgentPool());
  manager.loadSessions(tmpDir, new Map([['lobby', { name: 'lobby' }]]));

  // Should not throw, and no session recovered
  assert.strictEqual(manager.getSession('hazel'), null);
});

test('BotSessionManager.loadSessions handles missing tasks directory', () => {
  const manager = new BotSessionManager(makeConfig() as any, makeRoles('ts-dev'), makeBots('hazel'), new AgentPool());
  // No tasks dir exists — should not throw
  manager.loadSessions(tmpDir, new Map([['lobby', { name: 'lobby' }]]));
  assert.strictEqual(manager.getSession('hazel'), null);
});

// --- assembleBotPrompt tests ---

test('assembleBotPrompt includes soul prompt section', () => {
  // assembleBotPrompt calls loadSystemPrompt() which needs COLLABOT_HOME.
  // We test the composition logic by checking the output contains expected markers.
  // In CI, prompts/system.md must exist under COLLABOT_HOME.
  // Skip if instance root isn't available.
  try {
    const result = assembleBotPrompt('Be curious.', 'You are a dev.', []);
    assert.ok(result.includes('## Bot Identity'));
    assert.ok(result.includes('Be curious.'));
    assert.ok(result.includes('You are a dev.'));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('Instance root not found')) {
      // Expected in environments without COLLABOT_HOME — skip gracefully
      return;
    }
    throw err;
  }
});

test('assembleBotPrompt includes tool docs for agent-draft permission', () => {
  try {
    const withDraft = assembleBotPrompt('Soul.', 'Role.', ['agent-draft']);
    const withoutDraft = assembleBotPrompt('Soul.', 'Role.', []);
    // With agent-draft should be longer (includes tool docs)
    assert.ok(withDraft.length > withoutDraft.length);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('Instance root not found') || msg.includes('ENOENT')) {
      return;
    }
    throw err;
  }
});

// --- handleBotMessage error cases ---

test('BotSessionManager.handleBotMessage throws for unknown bot', async () => {
  const manager = new BotSessionManager(makeConfig() as any, makeRoles('ts-dev'), makeBots('hazel'), new AgentPool());

  await assert.rejects(
    () => manager.handleBotMessage({
      botName: 'nonexistent',
      roleName: 'ts-dev',
      message: 'hello',
      project: 'lobby',
      taskSlug: 'test',
      taskDir: tmpDir,
      cwd: tmpDir,
      responseSink: async () => {},
    }),
    /Bot "nonexistent" not found/,
  );
});

test('BotSessionManager.handleBotMessage throws for unknown role', async () => {
  const manager = new BotSessionManager(makeConfig() as any, makeRoles('ts-dev'), makeBots('hazel'), new AgentPool());

  await assert.rejects(
    () => manager.handleBotMessage({
      botName: 'hazel',
      roleName: 'nonexistent',
      message: 'hello',
      project: 'lobby',
      taskSlug: 'test',
      taskDir: tmpDir,
      cwd: tmpDir,
      responseSink: async () => {},
    }),
    /Role "nonexistent" not found/,
  );
});

// --- Multiple sessions coexist ---

test('BotSessionManager manages multiple bot sessions independently', () => {
  const taskDir1 = path.join(tmpDir, 'lobby', 'tasks', 'session-a');
  const taskDir2 = path.join(tmpDir, 'lobby', 'tasks', 'session-b');
  fs.mkdirSync(taskDir1, { recursive: true });
  fs.mkdirSync(taskDir2, { recursive: true });

  const mkSession = (botName: string, td: string): BotSession => ({
    botName,
    sessionId: `${botName}-uuid`,
    dispatchId: `01JNQR0000${botName.toUpperCase().padEnd(14, '0')}`,
    project: 'lobby',
    taskSlug: `session-${botName}`,
    taskDir: td,
    role: 'ts-dev',
    startedAt: '2026-03-01T10:00:00Z',
    lastActivityAt: '2026-03-01T10:05:00Z',
    turnCount: 1,
    sessionInitialized: true,
    cumulativeCostUsd: 0,
  });

  fs.writeFileSync(path.join(taskDir1, 'bot-session-hazel.json'), JSON.stringify(mkSession('hazel', taskDir1)));
  fs.writeFileSync(path.join(taskDir2, 'bot-session-greg.json'), JSON.stringify(mkSession('greg', taskDir2)));

  const manager = new BotSessionManager(
    makeConfig() as any,
    makeRoles('ts-dev'),
    makeBots('hazel', 'greg'),
    new AgentPool(),
  );
  manager.loadSessions(tmpDir, new Map([['lobby', { name: 'lobby' }]]));

  const hazel = manager.getSession('hazel');
  const greg = manager.getSession('greg');
  assert.ok(hazel);
  assert.ok(greg);
  assert.notStrictEqual(hazel!.sessionId, greg!.sessionId);
});
