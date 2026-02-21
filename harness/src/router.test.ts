import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRole, resolveRoutingCwd } from './router.js';
import type { Config } from './config.js';

function makeConfig(overrides: Partial<Config['routing']> = {}): Config {
  return {
    models: { default: 'claude-sonnet-4-6' },
    categories: { coding: { inactivityTimeout: 300 } },
    routing: {
      default: 'api-dev',
      rules: [
        { pattern: '^(portal|frontend|ui)', role: 'portal-dev' },
        { pattern: '^(test|e2e|playwright)', role: 'qa-dev' },
        { pattern: '^(api|backend|endpoint)', role: 'api-dev' },
        { pattern: '^(app|mobile|react.native)', role: 'app-dev' },
      ],
      ...overrides,
    },
    pool: { maxConcurrent: 0 },
    mcp: { streamTimeout: 600000, fullAccessCategories: ['conversational'] },
  };
}

test('resolveRole: message matches first rule → correct role', () => {
  const config = makeConfig();
  assert.strictEqual(resolveRole('portal fix the flyout bug', config), 'portal-dev');
});

test('resolveRole: message matches no rule → default role', () => {
  const config = makeConfig();
  assert.strictEqual(resolveRole('do something random', config), 'api-dev');
});

test('resolveRole: case insensitive matching', () => {
  const config = makeConfig();
  assert.strictEqual(resolveRole('PORTAL fix the thing', config), 'portal-dev');
  assert.strictEqual(resolveRole('Frontend update styles', config), 'portal-dev');
});

test('resolveRole: first-match-wins when multiple rules could match', () => {
  const config = makeConfig({
    default: 'api-dev',
    rules: [
      { pattern: '^test', role: 'qa-dev' },
      { pattern: '^test', role: 'portal-dev' },
    ],
  });
  assert.strictEqual(resolveRole('test the login flow', config), 'qa-dev');
});

test('resolveRole: empty message → default role', () => {
  const config = makeConfig();
  assert.strictEqual(resolveRole('', config), 'api-dev');
});

test('resolveRoutingCwd: rule with cwd override returns it', () => {
  const config = makeConfig({
    default: 'api-dev',
    rules: [
      { pattern: '^portal', role: 'portal-dev', cwd: '../web-portal-next' },
    ],
  });
  assert.strictEqual(resolveRoutingCwd('portal fix the bug', config), '../web-portal-next');
});

test('resolveRoutingCwd: rule without cwd returns undefined', () => {
  const config = makeConfig();
  assert.strictEqual(resolveRoutingCwd('portal fix the bug', config), undefined);
});

test('resolveRoutingCwd: no matching rule returns undefined', () => {
  const config = makeConfig();
  assert.strictEqual(resolveRoutingCwd('do something random', config), undefined);
});

test('resolveRole: "plan" prefix routes to product-analyst', () => {
  const config = makeConfig({
    default: 'api-dev',
    rules: [
      { pattern: '^(plan|analyze|spec|design|feature)', role: 'product-analyst' },
      { pattern: '^(portal|frontend|ui)', role: 'portal-dev' },
      { pattern: '^(test|e2e|playwright)', role: 'qa-dev' },
      { pattern: '^(api|backend|endpoint)', role: 'api-dev' },
      { pattern: '^(app|mobile|react.native)', role: 'app-dev' },
    ],
  });
  assert.strictEqual(resolveRole('plan the implementation of user settings', config), 'product-analyst');
  assert.strictEqual(resolveRole('analyze the login flow', config), 'product-analyst');
  assert.strictEqual(resolveRole('design a new feature', config), 'product-analyst');
});
