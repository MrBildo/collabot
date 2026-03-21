import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigSchema, resolveModelId } from './config.js';

const validSlack = {
  bots: {
    hazel: { botTokenEnv: 'HAZEL_BOT_TOKEN', appTokenEnv: 'HAZEL_APP_TOKEN' },
  },
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

test('slack section parses with bots', () => {
  const raw = validConfig();
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.ok(result.data.slack?.bots['hazel']);
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

test('slack section with empty object gets default bots', () => {
  const raw = validConfig({ slack: {} });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.deepStrictEqual(result.data.slack!.bots, {});
});

// ============================================================
// Slack multi-bot config tests
// ============================================================

test('slack bots config parses per-bot entries (credentials only)', () => {
  const raw = validConfig({
    slack: {
      bots: {
        hazel: { botTokenEnv: 'HAZEL_BOT_TOKEN', appTokenEnv: 'HAZEL_APP_TOKEN' },
        greg: { botTokenEnv: 'GREG_BOT_TOKEN', appTokenEnv: 'GREG_APP_TOKEN' },
      },
    },
  });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(Object.keys(result.data.slack!.bots).length, 2);
  assert.strictEqual(result.data.slack!.bots['hazel']!.botTokenEnv, 'HAZEL_BOT_TOKEN');
  assert.strictEqual(result.data.slack!.bots['greg']!.botTokenEnv, 'GREG_BOT_TOKEN');
});

test('slack bots default to empty record when not provided', () => {
  const raw = validConfig({ slack: {} });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.deepStrictEqual(result.data.slack!.bots, {});
});

test('slack bot config missing botTokenEnv fails', () => {
  const raw = validConfig({
    slack: {
      bots: {
        bad: { appTokenEnv: 'APP_TOKEN' },
      },
    },
  });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(!result.success);
});

test('slack taskRotationIntervalHours defaults to 24', () => {
  const raw = validConfig({ slack: {} });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.slack!.taskRotationIntervalHours, 24);
});

test('slack taskRotationIntervalHours accepts custom value', () => {
  const raw = validConfig({ slack: { taskRotationIntervalHours: 12 } });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.slack!.taskRotationIntervalHours, 12);
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
  assert.strictEqual(result.data.agent.maxTurns, 0);
  assert.strictEqual(result.data.agent.maxBudgetUsd, 0);
});

test('agent section with custom values parses correctly', () => {
  const raw = validConfig({ agent: { maxTurns: 100, maxBudgetUsd: 5.00 } });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.agent.maxTurns, 100);
  assert.strictEqual(result.data.agent.maxBudgetUsd, 5.00);
});

test('agent.maxTurns of 0 is valid (unlimited)', () => {
  const raw = validConfig({ agent: { maxTurns: 0, maxBudgetUsd: 0 } });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.agent.maxTurns, 0);
  assert.strictEqual(result.data.agent.maxBudgetUsd, 0);
});

test('agent.maxTurns rejects negative values', () => {
  const raw = validConfig({ agent: { maxTurns: -1, maxBudgetUsd: 0 } });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(!result.success);
});

test('agent.maxBudgetUsd rejects negative values', () => {
  const raw = validConfig({ agent: { maxTurns: 0, maxBudgetUsd: -1 } });
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

// ============================================================
// [bots.*] config tests (D11)
// ============================================================

test('bots section parses with defaultProject and defaultRole', () => {
  const raw = validConfig({
    bots: {
      hazel: { defaultProject: 'slack-room', defaultRole: 'researcher' },
    },
  });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.bots?.['hazel']?.defaultProject, 'slack-room');
  assert.strictEqual(result.data.bots?.['hazel']?.defaultRole, 'researcher');
});

test('bots section is optional', () => {
  const raw = validConfig();
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.bots, undefined);
});

test('bots entry with no fields uses defaults', () => {
  const raw = validConfig({
    bots: { hazel: {} },
  });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.bots?.['hazel']?.defaultProject, undefined);
  assert.strictEqual(result.data.bots?.['hazel']?.defaultRole, undefined);
});

test('bots entry with only defaultProject is valid', () => {
  const raw = validConfig({
    bots: { hazel: { defaultProject: 'slack-room' } },
  });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.bots?.['hazel']?.defaultProject, 'slack-room');
  assert.strictEqual(result.data.bots?.['hazel']?.defaultRole, undefined);
});

test('resolveModelId resolves default through aliases when default is alias name', () => {
  const config = ConfigSchema.parse(validConfig({
    models: {
      default: 'sonnet-latest',
      aliases: { 'sonnet-latest': 'claude-sonnet-4-6' },
    },
  }));
  // Unknown hint should fall back to default, which is an alias — should resolve to concrete ID
  assert.strictEqual(resolveModelId('unknown-hint', config), 'claude-sonnet-4-6');
});

// ============================================================
// Cron config tests
// ============================================================

test('config without cron section uses defaults (enabled: true, jobsDirectory: "cron")', () => {
  const raw = validConfig();
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.cron.enabled, true);
  assert.strictEqual(result.data.cron.jobsDirectory, 'cron');
});

test('config with cron.enabled = false parses correctly', () => {
  const raw = validConfig({ cron: { enabled: false } });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.cron.enabled, false);
  assert.strictEqual(result.data.cron.jobsDirectory, 'cron');
});

test('config with custom cron.jobsDirectory parses correctly', () => {
  const raw = validConfig({ cron: { jobsDirectory: 'scheduled-jobs' } });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  assert.strictEqual(result.data.cron.enabled, true);
  assert.strictEqual(result.data.cron.jobsDirectory, 'scheduled-jobs');
});

test('cron section rejects invalid types', () => {
  const raw = validConfig({ cron: { enabled: 'yes' } });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(!result.success);

  const raw2 = validConfig({ cron: { jobsDirectory: 42 } });
  const result2 = ConfigSchema.safeParse(raw2);
  assert.ok(!result2.success);
});

test('slack config without role field is valid (credentials only)', () => {
  const raw = validConfig({
    slack: {
      bots: {
        hazel: { botTokenEnv: 'HAZEL_BOT_TOKEN', appTokenEnv: 'HAZEL_APP_TOKEN' },
      },
    },
  });
  const result = ConfigSchema.safeParse(raw);
  assert.ok(result.success);
  const botConfig = result.data.slack!.bots['hazel'];
  assert.strictEqual(botConfig.botTokenEnv, 'HAZEL_BOT_TOKEN');
  // role field should NOT exist on the type
  assert.strictEqual('role' in botConfig, false);
});
