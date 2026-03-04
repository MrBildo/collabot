import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeBots, BotPlacementStore } from './bot-placement.js';
import type { Config } from './config.js';
import type { BotDefinition, RoleDefinition } from './types.js';
import type { VirtualProjectMeta } from './comms.js';
import type { Project } from './project.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    models: { default: 'claude-sonnet-4-6', aliases: { 'sonnet-latest': 'claude-sonnet-4-6' } },
    defaults: { stallTimeoutSeconds: 300 },
    agent: { maxTurns: 50, maxBudgetUsd: 1.00 },
    logging: { level: 'debug' },
    routing: { default: 'ts-dev', rules: [] },
    pool: { maxConcurrent: 0 },
    mcp: { streamTimeout: 600000 },
    ...overrides,
  } as Config;
}

function makeRoles(...names: string[]): Map<string, RoleDefinition> {
  const map = new Map<string, RoleDefinition>();
  for (const name of names) {
    map.set(name, {
      id: '01HXYZ01234567890ABCDEFGH',
      version: '1.0.0',
      name,
      description: `${name} role`,
      createdOn: '2026-03-01T00:00:00Z',
      createdBy: 'test',
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
      description: `${name} bot`,
      version: '1.0.0',
      soulPrompt: `You are ${name}.`,
    });
  }
  return map;
}

function makeProjects(...names: string[]): Map<string, Project> {
  const map = new Map<string, Project>();
  for (const name of names) {
    map.set(name.toLowerCase(), {
      name,
      description: `${name} project`,
      paths: ['/tmp/test'],
      roles: ['ts-dev', 'researcher'],
      virtual: name === 'lobby' || name === 'slack-room',
    });
  }
  return map;
}

// ── Basic placement ──────────────────────────────────────────

test('placeBots places bot in configured project with configured role', () => {
  const config = makeConfig({
    bots: { hazel: { defaultProject: 'slack-room', defaultRole: 'researcher' } },
  });
  const placements = placeBots(
    config,
    makeBots('hazel'),
    makeRoles('ts-dev', 'researcher'),
    makeProjects('lobby', 'slack-room'),
    new Map(),
  );

  assert.strictEqual(placements.size, 1);
  const p = placements.get('hazel')!;
  assert.strictEqual(p.project, 'slack-room');
  assert.strictEqual(p.roleName, 'researcher');
});

test('placeBots defaults to lobby when no defaultProject configured', () => {
  const config = makeConfig({
    bots: { hazel: {} },
  });
  const placements = placeBots(
    config,
    makeBots('hazel'),
    makeRoles('ts-dev'),
    makeProjects('lobby'),
    new Map(),
  );

  assert.strictEqual(placements.get('hazel')!.project, 'lobby');
});

test('placeBots defaults to lobby when no bots config section exists', () => {
  const config = makeConfig();
  const placements = placeBots(
    config,
    makeBots('hazel'),
    makeRoles('ts-dev'),
    makeProjects('lobby'),
    new Map(),
  );

  assert.strictEqual(placements.get('hazel')!.project, 'lobby');
});

// ── Role fallback chain ──────────────────────────────────────

test('placeBots falls back to routing.default when no role configured', () => {
  const config = makeConfig({
    routing: { default: 'ts-dev', rules: [] },
  });
  const placements = placeBots(
    config,
    makeBots('hazel'),
    makeRoles('ts-dev'),
    makeProjects('lobby'),
    new Map(),
  );

  assert.strictEqual(placements.get('hazel')!.roleName, 'ts-dev');
});

test('placeBots uses slack.defaultRole as intermediate fallback', () => {
  const config = makeConfig({
    slack: { defaultRole: 'researcher', taskRotationIntervalHours: 24, bots: {} },
    routing: { default: 'ts-dev', rules: [] },
  });
  const placements = placeBots(
    config,
    makeBots('hazel'),
    makeRoles('ts-dev', 'researcher'),
    makeProjects('lobby'),
    new Map(),
  );

  assert.strictEqual(placements.get('hazel')!.roleName, 'researcher');
});

// ── Project fallback ─────────────────────────────────────────

test('placeBots falls back to lobby when configured project not found', () => {
  const config = makeConfig({
    bots: { hazel: { defaultProject: 'nonexistent' } },
  });
  const placements = placeBots(
    config,
    makeBots('hazel'),
    makeRoles('ts-dev'),
    makeProjects('lobby'),
    new Map(),
  );

  assert.strictEqual(placements.get('hazel')!.project, 'lobby');
});

// ── Role not found ───────────────────────────────────────────

test('placeBots falls back to default role when configured role not found', () => {
  const config = makeConfig({
    bots: { hazel: { defaultRole: 'nonexistent' } },
    routing: { default: 'ts-dev', rules: [] },
  });
  const placements = placeBots(
    config,
    makeBots('hazel'),
    makeRoles('ts-dev'),
    makeProjects('lobby'),
    new Map(),
  );

  assert.strictEqual(placements.get('hazel')!.roleName, 'ts-dev');
});

test('placeBots skips bot when neither configured nor default role exists', () => {
  const config = makeConfig({
    bots: { hazel: { defaultRole: 'nonexistent' } },
    routing: { default: 'also-nonexistent', rules: [] },
  });
  const placements = placeBots(
    config,
    makeBots('hazel'),
    makeRoles('ts-dev'),
    makeProjects('lobby'),
    new Map(),
  );

  assert.strictEqual(placements.size, 0);
});

// ── Virtual project meta inheritance ─────────────────────────

test('placeBots inherits disallowedTools from virtual project meta', () => {
  const config = makeConfig({
    bots: { hazel: { defaultProject: 'slack-room' } },
  });
  const meta = new Map<string, VirtualProjectMeta>([
    ['slack-room', { disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit'] }],
  ]);
  const placements = placeBots(
    config,
    makeBots('hazel'),
    makeRoles('ts-dev'),
    makeProjects('lobby', 'slack-room'),
    meta,
  );

  assert.deepStrictEqual(placements.get('hazel')!.disallowedTools, ['Bash', 'Edit', 'Write', 'NotebookEdit']);
});

test('placeBots inherits skills from virtual project meta', () => {
  const config = makeConfig({
    bots: { hazel: { defaultProject: 'slack-room' } },
  });
  const skills = [{ name: 'slack-etiquette', content: 'Be nice in Slack.' }];
  const meta = new Map<string, VirtualProjectMeta>([
    ['slack-room', { skills }],
  ]);
  const placements = placeBots(
    config,
    makeBots('hazel'),
    makeRoles('ts-dev'),
    makeProjects('lobby', 'slack-room'),
    meta,
  );

  assert.deepStrictEqual(placements.get('hazel')!.skills, skills);
});

test('placeBots has no disallowedTools/skills when no meta for project', () => {
  const config = makeConfig({
    bots: { hazel: { defaultProject: 'lobby' } },
  });
  const placements = placeBots(
    config,
    makeBots('hazel'),
    makeRoles('ts-dev'),
    makeProjects('lobby'),
    new Map(),
  );

  assert.strictEqual(placements.get('hazel')!.disallowedTools, undefined);
  assert.strictEqual(placements.get('hazel')!.skills, undefined);
});

// ── Multiple bots ────────────────────────────────────────────

test('placeBots places multiple bots independently', () => {
  const config = makeConfig({
    bots: {
      hazel: { defaultProject: 'slack-room', defaultRole: 'researcher' },
      greg: { defaultProject: 'lobby', defaultRole: 'ts-dev' },
    },
  });
  const placements = placeBots(
    config,
    makeBots('hazel', 'greg'),
    makeRoles('ts-dev', 'researcher'),
    makeProjects('lobby', 'slack-room'),
    new Map(),
  );

  assert.strictEqual(placements.size, 2);
  assert.strictEqual(placements.get('hazel')!.project, 'slack-room');
  assert.strictEqual(placements.get('hazel')!.roleName, 'researcher');
  assert.strictEqual(placements.get('greg')!.project, 'lobby');
  assert.strictEqual(placements.get('greg')!.roleName, 'ts-dev');
});

// ── Initial status ────────────────────────────────────────────

test('placeBots sets status to available on all placements', () => {
  const config = makeConfig({
    bots: { hazel: { defaultProject: 'lobby' } },
  });
  const placements = placeBots(
    config,
    makeBots('hazel'),
    makeRoles('ts-dev'),
    makeProjects('lobby'),
    new Map(),
  );

  assert.strictEqual(placements.get('hazel')!.status, 'available');
});

// ── BotPlacementStore ─────────────────────────────────────────

function makeStore() {
  const config = makeConfig({
    bots: {
      hazel: { defaultProject: 'slack-room', defaultRole: 'researcher' },
      greg: { defaultProject: 'lobby', defaultRole: 'ts-dev' },
    },
  });
  const initial = placeBots(
    config,
    makeBots('hazel', 'greg'),
    makeRoles('ts-dev', 'researcher'),
    makeProjects('lobby', 'slack-room'),
    new Map(),
  );
  return new BotPlacementStore(initial);
}

test('BotPlacementStore.get returns placement for known bot', () => {
  const store = makeStore();
  const p = store.get('hazel');
  assert.ok(p);
  assert.strictEqual(p.project, 'slack-room');
  assert.strictEqual(p.status, 'available');
});

test('BotPlacementStore.get returns undefined for unknown bot', () => {
  const store = makeStore();
  assert.strictEqual(store.get('unknown'), undefined);
});

test('BotPlacementStore.getAll returns copy of all placements', () => {
  const store = makeStore();
  const all = store.getAll();
  assert.strictEqual(all.size, 2);
  // Modifying returned map does not affect store
  all.delete('hazel');
  assert.ok(store.get('hazel'));
});

test('BotPlacementStore.moveBot changes project', () => {
  const store = makeStore();
  const prev = store.moveBot('hazel', 'lobby');
  assert.strictEqual(prev, 'slack-room');
  assert.strictEqual(store.get('hazel')!.project, 'lobby');
});

test('BotPlacementStore.moveBot to lobby sets status available', () => {
  const store = makeStore();
  store.setDrafted('hazel', 'ws');
  assert.strictEqual(store.get('hazel')!.status, 'drafted');

  store.moveBot('hazel', 'lobby');
  assert.strictEqual(store.get('hazel')!.status, 'available');
  assert.strictEqual(store.get('hazel')!.draftedBy, undefined);
});

test('BotPlacementStore.moveBot throws for unknown bot', () => {
  const store = makeStore();
  assert.throws(() => store.moveBot('unknown', 'lobby'), /not found/);
});

test('BotPlacementStore.moveBot accepts optional roleName', () => {
  const store = makeStore();
  store.moveBot('hazel', 'research-lab', { roleName: 'ts-dev' });
  assert.strictEqual(store.get('hazel')!.roleName, 'ts-dev');
  assert.strictEqual(store.get('hazel')!.project, 'research-lab');
});

test('BotPlacementStore.setDrafted transitions to drafted status', () => {
  const store = makeStore();
  store.setDrafted('hazel', 'ws');
  assert.strictEqual(store.get('hazel')!.status, 'drafted');
  assert.strictEqual(store.get('hazel')!.draftedBy, 'ws');
});

test('BotPlacementStore.setBusy transitions to busy status', () => {
  const store = makeStore();
  store.setBusy('hazel');
  assert.strictEqual(store.get('hazel')!.status, 'busy');
});

test('BotPlacementStore.setAvailable transitions to available status', () => {
  const store = makeStore();
  store.setDrafted('hazel', 'ws');
  store.setAvailable('hazel');
  assert.strictEqual(store.get('hazel')!.status, 'available');
  assert.strictEqual(store.get('hazel')!.draftedBy, undefined);
});
