import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CronScheduler } from './cron.js';

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
  await new Promise((r) => setTimeout(r, 100));
  scheduler.stopAll();

  // Fired once immediately + at least 1-2 interval fires
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

  // Good job should have run multiple times despite error job failing
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
  scheduler.startAll(); // Should not duplicate timers

  await new Promise((r) => setTimeout(r, 30));
  scheduler.stopAll();

  // Should only fire once (immediate), not twice from double startAll
  assert.strictEqual(count, 1);
});
