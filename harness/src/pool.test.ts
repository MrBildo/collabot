import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentPool, AgentSnapshot } from './pool.js';

function makeAgent(id: string, role = 'api-dev') {
  return {
    id,
    role,
    taskSlug: `task-${id}`,
    startedAt: new Date(),
    controller: new AbortController(),
  };
}

test('register two agents — both in list(), size is 2', () => {
  const pool = new AgentPool();
  pool.register(makeAgent('a1'));
  pool.register(makeAgent('a2'));

  assert.strictEqual(pool.size, 2);
  const ids = pool.list().map((a) => a.id);
  assert.ok(ids.includes('a1'));
  assert.ok(ids.includes('a2'));
});

test('release one — only one remains', () => {
  const pool = new AgentPool();
  pool.register(makeAgent('a1'));
  pool.register(makeAgent('a2'));
  pool.release('a1');

  assert.strictEqual(pool.size, 1);
  assert.strictEqual(pool.list()[0]?.id, 'a2');
});

test('kill one — controller.abort() called, removed from list', () => {
  const pool = new AgentPool();
  const agent = makeAgent('a1');
  let aborted = false;
  agent.controller.signal.addEventListener('abort', () => { aborted = true; });
  pool.register(agent);

  pool.kill('a1');

  assert.strictEqual(pool.size, 0);
  assert.ok(aborted);
});

test('register at capacity (maxConcurrent: 2) — throws', () => {
  const pool = new AgentPool(2);
  pool.register(makeAgent('a1'));
  pool.register(makeAgent('a2'));

  assert.throws(
    () => pool.register(makeAgent('a3')),
    /Pool at capacity/,
  );
});

test('register with maxConcurrent: 0 (unlimited) — always succeeds', () => {
  const pool = new AgentPool(0);
  for (let i = 0; i < 10; i++) {
    pool.register(makeAgent(`a${i}`));
  }
  assert.strictEqual(pool.size, 10);
});

test('kill non-existent agent — no error (idempotent)', () => {
  const pool = new AgentPool();
  pool.register(makeAgent('a1'));
  pool.kill('nonexistent');
  assert.strictEqual(pool.size, 1);
});

test('kill propagates abort — controller.signal.aborted is true after kill', () => {
  const pool = new AgentPool();
  const controller = new AbortController();
  pool.register({
    id: 'abort-test',
    role: 'api-dev',
    taskSlug: 'task-abort-test',
    startedAt: new Date(),
    controller,
  });

  assert.strictEqual(controller.signal.aborted, false);
  pool.kill('abort-test');
  assert.strictEqual(controller.signal.aborted, true);
  assert.strictEqual(pool.size, 0);
});

// onChange tests

test('onChange fires on register with correct agent list', () => {
  const pool = new AgentPool();
  const snapshots: AgentSnapshot[][] = [];
  pool.setOnChange((agents) => snapshots.push(agents));

  pool.register(makeAgent('a1'));
  pool.register(makeAgent('a2'));

  assert.strictEqual(snapshots.length, 2);
  assert.strictEqual(snapshots[0]?.length, 1);
  assert.strictEqual(snapshots[0]?.[0]?.id, 'a1');
  assert.strictEqual(snapshots[1]?.length, 2);
  const ids = snapshots[1]?.map((a) => a.id);
  assert.ok(ids?.includes('a1'));
  assert.ok(ids?.includes('a2'));
});

test('onChange fires on release with updated agent list', () => {
  const pool = new AgentPool();
  pool.register(makeAgent('a1'));
  pool.register(makeAgent('a2'));

  const snapshots: AgentSnapshot[][] = [];
  pool.setOnChange((agents) => snapshots.push(agents));

  pool.release('a1');

  assert.strictEqual(snapshots.length, 1);
  assert.strictEqual(snapshots[0]?.length, 1);
  assert.strictEqual(snapshots[0]?.[0]?.id, 'a2');
});

test('onChange fires on kill with updated agent list', () => {
  const pool = new AgentPool();
  pool.register(makeAgent('a1'));
  pool.register(makeAgent('a2'));

  const snapshots: AgentSnapshot[][] = [];
  pool.setOnChange((agents) => snapshots.push(agents));

  pool.kill('a1');

  assert.strictEqual(snapshots.length, 1);
  assert.strictEqual(snapshots[0]?.length, 1);
  assert.strictEqual(snapshots[0]?.[0]?.id, 'a2');
});

test('pool works normally when no onChange is set (backward compat)', () => {
  const pool = new AgentPool();
  pool.register(makeAgent('a1'));
  pool.register(makeAgent('a2'));
  pool.release('a1');
  pool.kill('a2');
  assert.strictEqual(pool.size, 0);
});
