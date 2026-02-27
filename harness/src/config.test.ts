import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigSchema, resolveModelId } from './config.js';

const validSlack = {
  debounceMs: 2000,
  reactions: { received: 'eyes', working: 'hammer', success: 'white_check_mark', failure: 'x' },
};

function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    models: {
      default: 'claude-sonnet-4-6',
      aliases: {
        'opus-latest': 'claude-opus-4-6',
        'sonnet-latest': 'claude-sonnet-4-6',
        'haiku-latest': 'claude-haiku-4-5-20251001',
      },
    },
    defaults: { stallTimeoutSeconds: 300 },
    slack: validSlack,
    ...overrides,
  };
}

test('valid config object parses correctly', () => {
  const raw = validConfig();
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.models.default, 'claude-sonnet-4-6');
});

test('missing models.default fails validation', () => {
  const raw = validConfig({ models: {} });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(!result.success);
  const paths = result.error.issues.map((i) => i.path.join('.'));
  assert.ok(paths.some((p) => p.includes('default')));
});

test('routing section is optional — defaults applied', () => {
  const raw = validConfig();
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.routing.default, 'product-analyst');
  assert.deepStrictEqual(result.data.routing.rules, []);
});

test('explicit routing section still parses', () => {
  const raw = validConfig({
    routing: {
      default: 'ts-dev',
      rules: [{ pattern: '^portal', role: 'react-dev' }],
    },
  });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.routing.default, 'ts-dev');
  assert.strictEqual(result.data.routing.rules.length, 1);
});

test('slack reactions parse correctly', () => {
  const raw = validConfig();
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.slack?.reactions.received, 'eyes');
  assert.strictEqual(result.data.slack?.debounceMs, 2000);
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
// Model aliases tests
// ============================================================

test('model aliases parse correctly', () => {
  const raw = validConfig();
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.models.aliases['opus-latest'], 'claude-opus-4-6');
  assert.strictEqual(result.data.models.aliases['sonnet-latest'], 'claude-sonnet-4-6');
  assert.strictEqual(result.data.models.aliases['haiku-latest'], 'claude-haiku-4-5-20251001');
});

test('config without aliases section defaults to empty record', () => {
  const raw = validConfig({ models: { default: 'claude-sonnet-4-6' } });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.deepStrictEqual(result.data.models.aliases, {});
});

// ============================================================
// Defaults tests
// ============================================================

test('defaults.stallTimeoutSeconds parses correctly', () => {
  const raw = validConfig();
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.defaults.stallTimeoutSeconds, 300);
});

test('config without defaults section uses default (300s)', () => {
  const { defaults: _defaults, ...noDefaults } = validConfig();
  const result = ConfigSchema.safeParse(noDefaults);
  assert.ok(result.success);
  assert.strictEqual(result.data.defaults.stallTimeoutSeconds, 300);
});

test('negative stallTimeoutSeconds fails validation', () => {
  const raw = validConfig({ defaults: { stallTimeoutSeconds: -1 } });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(!result.success);
});

// ============================================================
// Agent defaults tests
// ============================================================

test('agent section defaults applied when omitted', () => {
  const raw = validConfig();
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.agent.maxTurns, 50);
  assert.strictEqual(result.data.agent.maxBudgetUsd, 1.00);
});

test('agent section with custom values parses correctly', () => {
  const raw = validConfig({ agent: { maxTurns: 100, maxBudgetUsd: 5.00 } });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.agent.maxTurns, 100);
  assert.strictEqual(result.data.agent.maxBudgetUsd, 5.00);
});

test('agent.maxTurns must be positive', () => {
  const raw = validConfig({ agent: { maxTurns: 0, maxBudgetUsd: 1.00 } });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(!result.success);
});

// ============================================================
// Logging tests
// ============================================================

test('logging section defaults to debug when omitted', () => {
  const raw = validConfig();
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.logging.level, 'debug');
});

test('logging.level accepts valid tiers', () => {
  for (const level of ['minimal', 'debug', 'verbose']) {
    const raw = validConfig({ logging: { level } });
    const result = ConfigSchema.safeParse(raw);
    assert.ok(result.success, `should accept level "${level}"`);
    assert.strictEqual(result.data.logging.level, level);
  }
});

test('logging.level rejects invalid values', () => {
  const raw = validConfig({ logging: { level: 'trace' } });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(!result.success);
});

// ============================================================
// resolveModelId tests
// ============================================================

test('resolveModelId resolves known alias', () => {
  const config = ConfigSchema.parse(validConfig());
  assert.strictEqual(resolveModelId('opus-latest', config), 'claude-opus-4-6');
  assert.strictEqual(resolveModelId('sonnet-latest', config), 'claude-sonnet-4-6');
  assert.strictEqual(resolveModelId('haiku-latest', config), 'claude-haiku-4-5-20251001');
});

test('resolveModelId falls back to default for unknown alias', () => {
  const config = ConfigSchema.parse(validConfig());
  assert.strictEqual(resolveModelId('unknown-hint', config), 'claude-sonnet-4-6');
});

// ============================================================
// MCP config tests
// ============================================================

test('config without mcp section is valid — defaults applied', () => {
  const raw = validConfig();
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.mcp.streamTimeout, 600000);
});

test('config with mcp section parses correctly', () => {
  const raw = validConfig({
    mcp: { streamTimeout: 300000 },
  });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.mcp.streamTimeout, 300000);
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

test('ws port must be a positive integer', () => {
  const raw = validConfig({ ws: { port: -1, host: '127.0.0.1' } });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(!result.success);
  const paths = result.error.issues.map((i) => i.path.join('.'));
  assert.ok(paths.some((p) => p.includes('port')));
});
