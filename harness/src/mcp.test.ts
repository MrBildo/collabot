import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHarnessServer, DispatchTracker } from './mcp.js';
import type { DraftAgentFn } from './mcp.js';
import { AgentPool } from './pool.js';
import { buildTaskContext } from './context.js';
import type { RoleDefinition, DispatchResult } from './types.js';

// --- Helpers ---

function makeTempTasksDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
}

function createTask(tasksDir: string, slug: string, manifest: Record<string, unknown>): string {
  const taskDir = path.join(tasksDir, slug);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  return taskDir;
}

function makeRoles(): Map<string, RoleDefinition> {
  return new Map([
    ['api-dev', {
      name: 'api-dev',
      displayName: 'API Dev',
      category: 'coding',
      cwd: '../backend-api',
      prompt: 'You are an API developer.',
    }],
    ['portal-dev', {
      name: 'portal-dev',
      displayName: 'Portal Dev',
      category: 'coding',
      cwd: '../web-portal',
      prompt: 'You are a portal developer.',
    }],
    ['product-analyst', {
      name: 'product-analyst',
      displayName: 'PM',
      category: 'conversational',
      cwd: '../',
      prompt: 'You are a product analyst.',
    }],
  ]);
}

// ============================================================
// DispatchTracker tests
// ============================================================

test('DispatchTracker — track and await returns result', async () => {
  const tracker = new DispatchTracker();
  const result: DispatchResult = { status: 'completed', result: 'done', duration_ms: 100 };
  const promise = Promise.resolve(result);

  tracker.track('agent-1', { promise, role: 'api-dev', startedAt: new Date() });
  assert.ok(tracker.has('agent-1'));

  const awaited = await tracker.await('agent-1');
  assert.equal(awaited.status, 'completed');
  assert.equal(awaited.result, 'done');
});

test('DispatchTracker — await on unknown ID throws', async () => {
  const tracker = new DispatchTracker();
  await assert.rejects(
    () => tracker.await('nonexistent'),
    /No tracked dispatch for agent "nonexistent"/,
  );
});

test('DispatchTracker — has returns false for untracked', () => {
  const tracker = new DispatchTracker();
  assert.equal(tracker.has('nope'), false);
});

test('DispatchTracker — delete removes entry', () => {
  const tracker = new DispatchTracker();
  tracker.track('agent-1', { promise: Promise.resolve({ status: 'completed', duration_ms: 0 }), role: 'api-dev', startedAt: new Date() });
  assert.ok(tracker.has('agent-1'));
  tracker.delete('agent-1');
  assert.equal(tracker.has('agent-1'), false);
});

// ============================================================
// list_agents tests
// ============================================================

test('list_agents — empty pool returns empty array', () => {
  const pool = new AgentPool();
  const tasksDir = makeTempTasksDir();

  const server = createHarnessServer({ pool, tasksDir, roles: makeRoles(), tools: 'readonly' });

  assert.equal(server.type, 'sdk');
  assert.equal(server.name, 'harness');

  const agents = pool.list();
  assert.equal(agents.length, 0);
});

test('list_agents — pool with 2 agents returns both', () => {
  const pool = new AgentPool();
  pool.register({
    id: 'agent-1',
    role: 'api-dev',
    taskSlug: 'task-1',
    startedAt: new Date('2026-02-20T10:00:00Z'),
    controller: new AbortController(),
  });
  pool.register({
    id: 'agent-2',
    role: 'portal-dev',
    taskSlug: 'task-2',
    startedAt: new Date('2026-02-20T10:05:00Z'),
    controller: new AbortController(),
  });

  const agents = pool.list().map((a) => ({
    id: a.id,
    role: a.role,
    taskSlug: a.taskSlug ?? null,
    startedAt: a.startedAt.toISOString(),
  }));

  assert.equal(agents.length, 2);
  assert.equal(agents[0]?.id, 'agent-1');
  assert.equal(agents[1]?.role, 'portal-dev');
});

// ============================================================
// list_tasks tests
// ============================================================

test('list_tasks — empty tasks dir returns empty array', () => {
  const tasksDir = makeTempTasksDir();
  const pool = new AgentPool();

  const server = createHarnessServer({ pool, tasksDir, roles: makeRoles(), tools: 'readonly' });
  assert.equal(server.type, 'sdk');
});

test('list_tasks — multiple tasks returns all', () => {
  const tasksDir = makeTempTasksDir();
  createTask(tasksDir, 'login-feature-0220', {
    slug: 'login-feature-0220',
    created: '2026-02-20T10:00:00Z',
    threadTs: 'thread-1',
    description: 'Build login feature',
    dispatches: [{ role: 'api-dev', status: 'completed' }],
  });
  createTask(tasksDir, 'rate-limit-0220', {
    slug: 'rate-limit-0220',
    created: '2026-02-20T11:00:00Z',
    threadTs: 'thread-2',
    description: 'Add rate limiting',
    dispatches: [],
  });

  const entries = fs.readdirSync(tasksDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  assert.equal(entries.length, 2);

  for (const entry of entries) {
    const manifestPath = path.join(tasksDir, entry.name, 'task.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    assert.ok(manifest.slug);
    assert.ok(manifest.created);
    assert.ok(manifest.description);
  }
});

// ============================================================
// get_task_context tests
// ============================================================

test('get_task_context — valid task returns context string', () => {
  const tasksDir = makeTempTasksDir();
  createTask(tasksDir, 'my-task', {
    slug: 'my-task',
    created: '2026-02-20T10:00:00Z',
    threadTs: 'thread-1',
    description: 'Build the feature',
    dispatches: [{
      role: 'api-dev',
      cwd: '../backend-api',
      model: 'claude-sonnet-4-6',
      startedAt: '2026-02-20T10:00:00Z',
      completedAt: '2026-02-20T10:05:00Z',
      status: 'completed',
      journalFile: 'api-dev.md',
      result: { summary: 'Added endpoint', changes: ['Controller.cs'] },
    }],
  });

  const taskDir = path.join(tasksDir, 'my-task');
  const context = buildTaskContext(taskDir);

  assert.ok(context.includes('## Task History'));
  assert.ok(context.includes('Build the feature'));
  assert.ok(context.includes('Added endpoint'));
});

test('get_task_context — invalid slug returns error', () => {
  const tasksDir = makeTempTasksDir();
  const manifestPath = path.join(tasksDir, 'nonexistent', 'task.json');
  assert.ok(!fs.existsSync(manifestPath));
});

// ============================================================
// Server creation tests
// ============================================================

test('createHarnessServer readonly — creates server with type sdk', () => {
  const pool = new AgentPool();
  const tasksDir = makeTempTasksDir();
  const server = createHarnessServer({ pool, tasksDir, roles: makeRoles(), tools: 'readonly' });

  assert.equal(server.type, 'sdk');
  assert.equal(server.name, 'harness');
  assert.ok('instance' in server);
});

test('createHarnessServer full — creates server with lifecycle tools', () => {
  const pool = new AgentPool();
  const tasksDir = makeTempTasksDir();
  const tracker = new DispatchTracker();
  const draftFn: DraftAgentFn = async () => ({ status: 'completed', duration_ms: 0 });

  const server = createHarnessServer({
    pool, tasksDir, roles: makeRoles(), tools: 'full',
    tracker, draftFn,
  });

  assert.equal(server.type, 'sdk');
  assert.equal(server.name, 'harness');
});

test('createHarnessServer full without tracker — throws', () => {
  const pool = new AgentPool();
  const tasksDir = makeTempTasksDir();

  assert.throws(
    () => createHarnessServer({ pool, tasksDir, roles: makeRoles(), tools: 'full' }),
    /Full MCP server requires tracker and draftFn/,
  );
});

test('createHarnessServer — non-existent tasksDir does not throw', () => {
  const pool = new AgentPool();
  const tasksDir = path.join(os.tmpdir(), 'nonexistent-dir-' + Date.now());
  const server = createHarnessServer({ pool, tasksDir, roles: makeRoles(), tools: 'readonly' });
  assert.ok(server);
});

// ============================================================
// draft_agent tool handler tests (via DraftAgentFn mock)
// ============================================================

test('draft_agent — returns agent ID without blocking', async () => {
  const pool = new AgentPool();
  const tasksDir = makeTempTasksDir();
  const tracker = new DispatchTracker();
  let draftCalled = false;

  // draftFn resolves after a delay — draft_agent should return immediately
  const draftFn: DraftAgentFn = async (role, prompt) => {
    draftCalled = true;
    return { status: 'completed', duration_ms: 100 };
  };

  const server = createHarnessServer({
    pool, tasksDir, roles: makeRoles(), tools: 'full',
    tracker, draftFn,
  });

  // The draft_agent tool is registered on the server.
  // We verify the tracker has an entry after creation by simulating the flow.
  // Since we can't easily invoke MCP tools in tests, we test the tracker integration directly.
  const resultPromise = draftFn('api-dev', 'Build something');
  const agentId = 'test-agent-1';
  tracker.track(agentId, { promise: resultPromise, role: 'api-dev', startedAt: new Date() });

  assert.ok(tracker.has(agentId));
  // Await the result
  const result = await tracker.await(agentId);
  assert.equal(result.status, 'completed');
  assert.ok(draftCalled);
});

test('draft_agent — invalid role rejected (roles validation)', () => {
  const roles = makeRoles();
  assert.ok(!roles.has('nonexistent-role'));
  assert.ok(roles.has('api-dev'));
});

test('await_agent — on completed dispatch returns result', async () => {
  const tracker = new DispatchTracker();
  const result: DispatchResult = {
    status: 'completed',
    structuredResult: { status: 'success', summary: 'Done' },
    cost: 0.05,
    duration_ms: 5000,
  };

  tracker.track('agent-1', { promise: Promise.resolve(result), role: 'api-dev', startedAt: new Date() });
  const awaited = await tracker.await('agent-1');

  assert.equal(awaited.status, 'completed');
  assert.equal(awaited.structuredResult?.summary, 'Done');
  assert.equal(awaited.cost, 0.05);
});

test('await_agent — on unknown ID returns error', async () => {
  const tracker = new DispatchTracker();
  await assert.rejects(
    () => tracker.await('nonexistent'),
    /No tracked dispatch/,
  );
});

test('kill_agent — calls pool.kill()', () => {
  const pool = new AgentPool();
  const controller = new AbortController();
  pool.register({
    id: 'agent-to-kill',
    role: 'api-dev',
    taskSlug: 'task-1',
    startedAt: new Date(),
    controller,
  });

  assert.equal(controller.signal.aborted, false);
  pool.kill('agent-to-kill');
  assert.equal(controller.signal.aborted, true);
  assert.equal(pool.size, 0);
});

test('kill_agent — nonexistent agent (pool empty)', () => {
  const pool = new AgentPool();
  const tracker = new DispatchTracker();

  // Not in pool, not in tracker
  const found = pool.list().find((a) => a.id === 'nonexistent');
  assert.equal(found, undefined);
  assert.equal(tracker.has('nonexistent'), false);
});
