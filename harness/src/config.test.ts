import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigSchema } from './config.js';

const validSlack = {
  debounceMs: 2000,
  reactions: { received: 'eyes', working: 'hammer', success: 'white_check_mark', failure: 'x' },
};

const validRouting = {
  default: 'api-dev',
  rules: [{ pattern: '^(portal|frontend)', role: 'portal-dev' }],
};

function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    models: { default: 'claude-sonnet-4-6' },
    categories: { coding: { inactivityTimeout: 300 } },
    routing: validRouting,
    slack: validSlack,
    ...overrides,
  };
}

test('valid YAML object parses correctly', () => {
  const raw = validConfig();
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.models.default, 'claude-sonnet-4-6');
  assert.strictEqual(result.data.categories['coding']?.inactivityTimeout, 300);
});

test('missing models.default fails validation', () => {
  const raw = validConfig({ models: {} });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(!result.success);
  const paths = result.error.issues.map((i) => i.path.join('.'));
  assert.ok(paths.some((p) => p.includes('default')));
});

test('negative inactivityTimeout fails validation', () => {
  const raw = validConfig({ categories: { coding: { inactivityTimeout: -1 } } });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(!result.success);
  const paths = result.error.issues.map((i) => i.path.join('.'));
  assert.ok(paths.some((p) => p.includes('inactivityTimeout')));
});

test('routing section with rules parses correctly', () => {
  const raw = validConfig();
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.routing.default, 'api-dev');
  assert.strictEqual(result.data.routing.rules.length, 1);
  assert.strictEqual(result.data.routing.rules[0]?.role, 'portal-dev');
});

test('routing rule with optional cwd parses correctly', () => {
  const raw = validConfig({
    routing: {
      default: 'api-dev',
      rules: [{ pattern: '^portal', role: 'portal-dev', cwd: '../web-portal' }],
    },
  });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.routing.rules[0]?.cwd, '../web-portal');
});

test('slack reactions parse correctly', () => {
  const raw = validConfig();
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.slack?.reactions.received, 'eyes');
  assert.strictEqual(result.data.slack?.debounceMs, 2000);
});

test('missing routing section fails validation', () => {
  const { routing: _routing, ...noRouting } = validConfig();
  const result = ConfigSchema.safeParse(noRouting);
  assert.ok(!result.success);
});

test('config without slack section is valid with defaults', () => {
  const { slack: _slack, ...noSlack } = validConfig();
  const result = ConfigSchema.safeParse(noSlack);
  assert.ok(result.success);
  assert.strictEqual(result.data.slack, undefined);
});

test('config without pool section is valid — defaults to maxConcurrent: 0', () => {
  const raw = validConfig();
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.pool.maxConcurrent, 0);
});

test('config with pool.maxConcurrent: 3 parses correctly', () => {
  const raw = validConfig({ pool: { maxConcurrent: 3 } });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.pool.maxConcurrent, 3);
});

test('slack section with defaults fills in reaction names', () => {
  const raw = validConfig({ slack: {} });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.slack?.reactions.received, 'eyes');
  assert.strictEqual(result.data.slack?.reactions.working, 'hammer');
  assert.strictEqual(result.data.slack?.debounceMs, 2000);
});

// ============================================================
// MCP config tests
// ============================================================

test('config without mcp section is valid — defaults applied', () => {
  const raw = validConfig();
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.mcp.streamTimeout, 600000);
  assert.deepStrictEqual(result.data.mcp.fullAccessCategories, ['conversational']);
});

test('config with mcp section parses correctly', () => {
  const raw = validConfig({
    mcp: {
      streamTimeout: 300000,
      fullAccessCategories: ['conversational', 'research'],
    },
  });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.mcp.streamTimeout, 300000);
  assert.deepStrictEqual(result.data.mcp.fullAccessCategories, ['conversational', 'research']);
});

test('config with empty mcp section gets defaults', () => {
  const raw = validConfig({ mcp: {} });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.mcp.streamTimeout, 600000);
  assert.deepStrictEqual(result.data.mcp.fullAccessCategories, ['conversational']);
});

test('mcp fullAccessCategories determines tool access level', () => {
  const raw = validConfig({
    mcp: { fullAccessCategories: ['conversational'] },
  });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  const fullAccess = result.data.mcp.fullAccessCategories;

  // conversational category should get full access
  assert.ok(fullAccess.includes('conversational'));
  // coding category should NOT get full access
  assert.ok(!fullAccess.includes('coding'));
});

// ============================================================
// WS config tests
// ============================================================

test('config without ws section is valid — ws is undefined', () => {
  const raw = validConfig();
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.ws, undefined);
});

test('config with ws section parses correctly', () => {
  const raw = validConfig({ ws: { port: 9800, host: '127.0.0.1' } });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.ws?.port, 9800);
  assert.strictEqual(result.data.ws?.host, '127.0.0.1');
});

test('config with empty ws section gets defaults', () => {
  const raw = validConfig({ ws: {} });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.ws?.port, 9800);
  assert.strictEqual(result.data.ws?.host, '127.0.0.1');
});

test('ws port must be a positive integer', () => {
  const raw = validConfig({ ws: { port: -1, host: '127.0.0.1' } });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(!result.success);
  const paths = result.error.issues.map((i) => i.path.join('.'));
  assert.ok(paths.some((p) => p.includes('port')));
});
