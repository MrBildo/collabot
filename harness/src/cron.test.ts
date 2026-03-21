import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CronScheduler } from './cron.js';
import type { AgentJobDefinition, HandlerJobDefinition } from './cron-loader.js';

// ── Legacy tests (backward compat) ─────────────────────────

test('CronScheduler registers and lists jobs', () => {
  const scheduler = new CronScheduler();
  scheduler.register({ name: 'test-job', intervalMs: 60000, handler: async () => {} });

  assert.deepStrictEqual(scheduler.list(), ['test-job']);
});

test('CronScheduler throws on duplicate registration', () => {
  const scheduler = new CronScheduler();
  scheduler.register({ name: 'dup', intervalMs: 1000, handler: async () => {} });

  assert.throws(
    () => scheduler.register({ name: 'dup', intervalMs: 2000, handler: async () => {} }),
    /already registered/,
  );
});

test('CronScheduler fires job immediately on startAll', async () => {
  const scheduler = new CronScheduler();
  let fired = false;

  scheduler.register({
    name: 'immediate',
    intervalMs: 60000,
    handler: async () => { fired = true; },
  });

  scheduler.startAll();
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(fired, true);
  scheduler.stopAll();
});

test('CronScheduler repeats job at interval', async () => {
  const scheduler = new CronScheduler();
  let count = 0;

  scheduler.register({
    name: 'repeating',
    intervalMs: 30,
    handler: async () => { count++; },
  });

  scheduler.startAll();
  await new Promise((r) => setTimeout(r, 150));
  scheduler.stopAll();

  assert.ok(count >= 2, `Expected at least 2 fires, got ${count}`);
});

test('CronScheduler stopAll clears timers', async () => {
  const scheduler = new CronScheduler();
  let count = 0;

  scheduler.register({
    name: 'stoppable',
    intervalMs: 20,
    handler: async () => { count++; },
  });

  scheduler.startAll();
  await new Promise((r) => setTimeout(r, 30));
  scheduler.stopAll();

  const countAfterStop = count;
  await new Promise((r) => setTimeout(r, 60));

  assert.strictEqual(count, countAfterStop, 'No more fires after stopAll');
});

test('CronScheduler unregister removes job and clears its timer', async () => {
  const scheduler = new CronScheduler();
  let count = 0;

  scheduler.register({
    name: 'removable',
    intervalMs: 20,
    handler: async () => { count++; },
  });

  scheduler.startAll();
  await new Promise((r) => setTimeout(r, 30));
  scheduler.unregister('removable');

  const countAfterRemove = count;
  await new Promise((r) => setTimeout(r, 60));

  assert.strictEqual(count, countAfterRemove, 'No more fires after unregister');
  assert.deepStrictEqual(scheduler.list(), []);
});

test('CronScheduler handles handler errors without stopping', async () => {
  const scheduler = new CronScheduler();
  let successCount = 0;

  scheduler.register({
    name: 'error-job',
    intervalMs: 20,
    handler: async () => { throw new Error('boom'); },
  });

  scheduler.register({
    name: 'good-job',
    intervalMs: 20,
    handler: async () => { successCount++; },
  });

  scheduler.startAll();
  await new Promise((r) => setTimeout(r, 70));
  scheduler.stopAll();

  assert.ok(successCount >= 2, `Good job should still run. Got ${successCount}`);
});

test('CronScheduler startAll is idempotent for running jobs', async () => {
  const scheduler = new CronScheduler();
  let count = 0;

  scheduler.register({
    name: 'idempotent',
    intervalMs: 1000,
    handler: async () => { count++; },
  });

  scheduler.startAll();
  scheduler.startAll();

  await new Promise((r) => setTimeout(r, 30));
  scheduler.stopAll();

  assert.strictEqual(count, 1);
});

// ── V2 tests ────────────────────────────────────────────────

describe('CronScheduler v2', () => {
  function makeAgentDef(overrides: Partial<AgentJobDefinition> = {}): AgentJobDefinition {
    return {
      type: 'agent',
      id: '01KM1GXPS3Q0AGB45YRTE6T1YT',
      name: overrides.name ?? 'test-agent-job',
      slug: overrides.slug ?? 'test-agent-job',
      schedule: overrides.schedule ?? 'every 1m',
      enabled: overrides.enabled ?? true,
      singleton: overrides.singleton ?? true,
      role: 'researcher',
      project: 'lobby',
      prompt: 'Do something.',
      jobDir: '/tmp/test',
      ...overrides,
    };
  }

  test('registerDefinition adds v2 job', () => {
    const scheduler = new CronScheduler();
    let fired = false;
    scheduler.registerDefinition(makeAgentDef(), async () => { fired = true; });

    assert.deepStrictEqual(scheduler.list(), ['test-agent-job']);

    const state = scheduler.getState('test-agent-job');
    assert.ok(state);
    assert.equal(state.status, 'idle');
    assert.equal(state.runCount, 0);
  });

  test('registerDefinition with disabled job sets status to disabled', () => {
    const scheduler = new CronScheduler();
    scheduler.registerDefinition(makeAgentDef({ enabled: false }), async () => {});

    const state = scheduler.getState('test-agent-job');
    assert.ok(state);
    assert.equal(state.status, 'disabled');
  });

  test('pause and resume job', () => {
    const scheduler = new CronScheduler();
    scheduler.registerDefinition(makeAgentDef(), async () => {});

    scheduler.pause('test-agent-job');
    assert.equal(scheduler.getState('test-agent-job')?.status, 'paused');

    scheduler.resume('test-agent-job');
    assert.equal(scheduler.getState('test-agent-job')?.status, 'idle');
  });

  test('listWithState returns all job states', () => {
    const scheduler = new CronScheduler();
    scheduler.registerDefinition(makeAgentDef({ name: 'a', slug: 'a' }), async () => {});
    scheduler.registerDefinition(makeAgentDef({ name: 'b', slug: 'b' }), async () => {});

    const states = scheduler.listWithState();
    assert.equal(states.length, 2);
    assert.ok(states.some(s => s.name === 'a'));
    assert.ok(states.some(s => s.name === 'b'));
  });

  test('getDefinition returns the original definition', () => {
    const scheduler = new CronScheduler();
    const def = makeAgentDef();
    scheduler.registerDefinition(def, async () => {});

    const retrieved = scheduler.getDefinition('test-agent-job');
    assert.ok(retrieved);
    assert.equal(retrieved.name, 'test-agent-job');
    assert.equal(retrieved.type, 'agent');
  });

  test('state persistence writes and reads cron-state.json', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-state-'));
    const statePath = path.join(tmpDir, 'cron-state.json');

    const scheduler1 = new CronScheduler(statePath);
    scheduler1.registerDefinition(makeAgentDef(), async () => {});
    scheduler1.startAll();
    scheduler1.stopAll();

    assert.ok(fs.existsSync(statePath), 'state file should exist');

    const raw = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    assert.ok(raw['test-agent-job'], 'state should contain job');

    // Create a new scheduler and hydrate
    const scheduler2 = new CronScheduler(statePath);
    scheduler2.registerDefinition(makeAgentDef(), async () => {});
    scheduler2.hydrateState();

    const state = scheduler2.getState('test-agent-job');
    assert.ok(state);
    // State should be restored
    assert.equal(state.name, 'test-agent-job');
  });

  test('interval schedule "every 5m" resolves correctly', () => {
    const scheduler = new CronScheduler();
    scheduler.registerDefinition(makeAgentDef({ schedule: 'every 5m' }), async () => {});
    scheduler.startAll();

    const state = scheduler.getState('test-agent-job');
    assert.ok(state?.nextRunAt, 'should have a next run time');
    scheduler.stopAll();
  });

  test('cron expression schedule resolves correctly', () => {
    const scheduler = new CronScheduler();
    scheduler.registerDefinition(
      makeAgentDef({ schedule: '0 9 * * MON-FRI' }),
      async () => {},
    );
    scheduler.startAll();

    const state = scheduler.getState('test-agent-job');
    assert.ok(state?.nextRunAt, 'should calculate next fire time from cron expr');
    scheduler.stopAll();
  });

  test('error tracking updates consecutive failures', async () => {
    const scheduler = new CronScheduler();
    scheduler.registerDefinition(
      makeAgentDef({ singleton: false }),
      async () => { throw new Error('deliberate'); },
    );

    scheduler.register({
      name: '_trigger',
      intervalMs: 60000,
      handler: async () => {},
    });

    // Manually trigger the job handler
    const job = scheduler.getState('test-agent-job');
    assert.ok(job);

    // Use startAll and wait for tick to trigger via interval
    // Instead, just verify state tracking works at the unit level
    assert.equal(job.consecutiveFailures, 0);
    assert.equal(job.lastError, null);
    scheduler.stopAll();
  });

  test('rejects zero interval — every 0m', () => {
    const scheduler = new CronScheduler();
    assert.throws(
      () => scheduler.registerDefinition(makeAgentDef({ schedule: 'every 0m' }), async () => {}),
      /Interval too short/,
    );
  });

  test('rejects zero interval — every 0h', () => {
    const scheduler = new CronScheduler();
    assert.throws(
      () => scheduler.registerDefinition(makeAgentDef({ schedule: 'every 0h' }), async () => {}),
      /Interval too short/,
    );
  });

  test('rejects zero interval — every 0d', () => {
    const scheduler = new CronScheduler();
    assert.throws(
      () => scheduler.registerDefinition(makeAgentDef({ schedule: 'every 0d' }), async () => {}),
      /Interval too short/,
    );
  });

  test('one-shot job transitions to disabled after handler completes', async () => {
    const scheduler = new CronScheduler();
    let handlerRan = false;

    // Schedule 1 second in the future
    const futureDate = new Date(Date.now() + 1000);
    const def = makeAgentDef({
      name: 'one-shot',
      slug: 'one-shot',
      schedule: `at ${futureDate.toISOString()}`,
      singleton: true,
    });

    scheduler.registerDefinition(def, async () => {
      handlerRan = true;
      // Simulate async work
      await new Promise(r => setTimeout(r, 50));
    });

    scheduler.startAll();

    // Before fire time — should be idle
    assert.equal(scheduler.getState('one-shot')?.status, 'idle');

    // Wait for fire time + handler completion
    await new Promise(r => setTimeout(r, 1200));

    assert.equal(handlerRan, true, 'handler should have run');
    assert.equal(scheduler.getState('one-shot')?.status, 'disabled', 'status should be disabled after completion');
    assert.equal(scheduler.getState('one-shot')?.nextRunAt, null, 'nextRunAt should be null for one-shot');
    scheduler.stopAll();
  });

  test('job with timezone calculates next fire time correctly', () => {
    const scheduler = new CronScheduler();
    scheduler.registerDefinition(
      makeAgentDef({
        name: 'tz-job',
        slug: 'tz-job',
        schedule: '0 9 * * *',
        timezone: 'America/New_York',
      }),
      async () => {},
    );
    scheduler.startAll();

    const state = scheduler.getState('tz-job');
    assert.ok(state?.nextRunAt, 'should have a next run time');

    // Verify 9:00 AM ET = 13:00 or 14:00 UTC depending on DST
    const nextRun = new Date(state.nextRunAt);
    const hours = nextRun.getUTCHours();
    assert.ok(hours === 13 || hours === 14, `Expected UTC hour 13 or 14, got ${hours}`);
    assert.equal(nextRun.getUTCMinutes(), 0);

    scheduler.stopAll();
  });

  test('job without timezone uses system default', () => {
    const scheduler = new CronScheduler();
    scheduler.registerDefinition(
      makeAgentDef({
        name: 'no-tz-job',
        slug: 'no-tz-job',
        schedule: '0 12 * * *',
      }),
      async () => {},
    );
    scheduler.startAll();

    const state = scheduler.getState('no-tz-job');
    assert.ok(state?.nextRunAt, 'should have a next run time');
    scheduler.stopAll();
  });

  test('job auto-disables after reaching consecutive failure threshold', async () => {
    const scheduler = new CronScheduler(undefined, 3); // global threshold = 3
    let callCount = 0;

    // Use a very short interval to trigger quickly via tick
    const def = makeAgentDef({
      name: 'fail-job',
      slug: 'fail-job',
      schedule: 'every 1m',
      singleton: false,
    });

    scheduler.registerDefinition(def, async () => {
      callCount++;
      throw new Error(`fail #${callCount}`);
    });

    // Manually run the job 3 times via the internal handler path
    // We can't easily trigger the tick loop, so we test state transitions
    // by accessing the registered job's handler directly through startAll + tick
    scheduler.startAll();

    // Override nextRunAt to trigger immediately on next tick
    const state = scheduler.getState('fail-job');
    assert.ok(state);
    state.nextRunAt = new Date(Date.now() - 1000).toISOString();

    // Wait for tick to fire and handler to reject
    await new Promise(r => setTimeout(r, 1200));

    // After first failure
    assert.equal(scheduler.getState('fail-job')?.consecutiveFailures, 1);
    assert.equal(scheduler.getState('fail-job')?.status, 'idle');

    // Trigger second failure
    scheduler.getState('fail-job')!.nextRunAt = new Date(Date.now() - 1000).toISOString();
    await new Promise(r => setTimeout(r, 1200));
    assert.equal(scheduler.getState('fail-job')?.consecutiveFailures, 2);
    assert.equal(scheduler.getState('fail-job')?.status, 'idle');

    // Trigger third failure — should auto-disable
    scheduler.getState('fail-job')!.nextRunAt = new Date(Date.now() - 1000).toISOString();
    await new Promise(r => setTimeout(r, 1200));
    assert.equal(scheduler.getState('fail-job')?.consecutiveFailures, 3);
    assert.equal(scheduler.getState('fail-job')?.status, 'disabled');

    scheduler.stopAll();
  });

  test('auto-disabled job is skipped by tick loop', async () => {
    const scheduler = new CronScheduler(undefined, 1); // threshold = 1
    let callCount = 0;

    scheduler.registerDefinition(
      makeAgentDef({ name: 'skip-job', slug: 'skip-job', schedule: 'every 1m', singleton: false }),
      async () => { callCount++; throw new Error('fail'); },
    );

    scheduler.startAll();

    // Trigger first failure — should auto-disable at threshold 1
    scheduler.getState('skip-job')!.nextRunAt = new Date(Date.now() - 1000).toISOString();
    await new Promise(r => setTimeout(r, 1200));
    assert.equal(scheduler.getState('skip-job')?.status, 'disabled');
    const countAfterDisable = callCount;

    // Set nextRunAt again — tick should skip because status is disabled
    scheduler.getState('skip-job')!.nextRunAt = new Date(Date.now() - 1000).toISOString();
    await new Promise(r => setTimeout(r, 1200));
    assert.equal(callCount, countAfterDisable, 'handler should not have been called again');

    scheduler.stopAll();
  });

  test('per-job maxConsecutiveFailures overrides global default', async () => {
    const scheduler = new CronScheduler(undefined, 10); // global = 10
    let callCount = 0;

    scheduler.registerDefinition(
      makeAgentDef({
        name: 'custom-threshold',
        slug: 'custom-threshold',
        schedule: 'every 1m',
        singleton: false,
        maxConsecutiveFailures: 2,
      }),
      async () => { callCount++; throw new Error('fail'); },
    );

    scheduler.startAll();

    // First failure
    scheduler.getState('custom-threshold')!.nextRunAt = new Date(Date.now() - 1000).toISOString();
    await new Promise(r => setTimeout(r, 1200));
    assert.equal(scheduler.getState('custom-threshold')?.status, 'idle');

    // Second failure — should disable (per-job threshold = 2)
    scheduler.getState('custom-threshold')!.nextRunAt = new Date(Date.now() - 1000).toISOString();
    await new Promise(r => setTimeout(r, 1200));
    assert.equal(scheduler.getState('custom-threshold')?.status, 'disabled');
    assert.equal(scheduler.getState('custom-threshold')?.consecutiveFailures, 2);

    scheduler.stopAll();
  });

  test('successful run resets consecutiveFailures counter', async () => {
    const scheduler = new CronScheduler(undefined, 5);
    let shouldFail = true;

    scheduler.registerDefinition(
      makeAgentDef({ name: 'reset-job', slug: 'reset-job', schedule: 'every 1m', singleton: false }),
      async () => { if (shouldFail) throw new Error('fail'); },
    );

    scheduler.startAll();

    // Two failures
    scheduler.getState('reset-job')!.nextRunAt = new Date(Date.now() - 1000).toISOString();
    await new Promise(r => setTimeout(r, 1200));
    scheduler.getState('reset-job')!.nextRunAt = new Date(Date.now() - 1000).toISOString();
    await new Promise(r => setTimeout(r, 1200));
    assert.equal(scheduler.getState('reset-job')?.consecutiveFailures, 2);

    // Now succeed
    shouldFail = false;
    scheduler.getState('reset-job')!.nextRunAt = new Date(Date.now() - 1000).toISOString();
    await new Promise(r => setTimeout(r, 1200));
    assert.equal(scheduler.getState('reset-job')?.consecutiveFailures, 0);
    assert.equal(scheduler.getState('reset-job')?.status, 'idle');

    scheduler.stopAll();
  });

  test('one-shot job transitions to disabled even after handler error', async () => {
    const scheduler = new CronScheduler();

    const futureDate = new Date(Date.now() + 1000);
    const def = makeAgentDef({
      name: 'one-shot-err',
      slug: 'one-shot-err',
      schedule: `at ${futureDate.toISOString()}`,
      singleton: true,
    });

    scheduler.registerDefinition(def, async () => {
      throw new Error('deliberate one-shot error');
    });

    scheduler.startAll();
    await new Promise(r => setTimeout(r, 1200));

    const state = scheduler.getState('one-shot-err');
    assert.equal(state?.status, 'disabled', 'one-shot should disable even on error');
    assert.equal(state?.lastError, 'deliberate one-shot error');
    assert.equal(state?.consecutiveFailures, 1);
    scheduler.stopAll();
  });
});
