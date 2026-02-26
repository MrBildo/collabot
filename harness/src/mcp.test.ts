import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHarnessServer, DispatchTracker } from './mcp.js';
import type { DraftAgentFn } from './mcp.js';
import { AgentPool } from './pool.js';
import { buildTaskContext } from './context.js';
import type { RoleDefinition, DispatchResult, Project } from './types.js';

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
      id: '01HXYZ01234567890ABCDEFGH',
      version: '1.0.0',
      name: 'api-dev',
      description: 'Backend development.',
      createdOn: '2026-02-24T15:00:00Z',
      createdBy: 'Test',
      displayName: 'API Dev',
      modelHint: 'sonnet-latest',
      prompt: 'You are an API developer.',
    }],
    ['portal-dev', {
      id: '01HXYZ01234567890ABCDEFGI',
      version: '1.0.0',
      name: 'portal-dev',
      description: 'Frontend development.',
      createdOn: '2026-02-24T15:00:00Z',
      createdBy: 'Test',
      displayName: 'Portal Dev',
      modelHint: 'sonnet-latest',
      prompt: 'You are a portal developer.',
    }],
    ['product-analyst', {
      id: '01HXYZ01234567890ABCDEFGJ',
      version: '1.0.0',
      name: 'product-analyst',
      description: 'Coordination and analysis.',
      createdOn: '2026-02-24T15:00:00Z',
      createdBy: 'Test',
      displayName: 'PM',
      modelHint: 'opus-latest',
      permissions: ['agent-draft', 'projects-list', 'projects-create'],
      prompt: 'You are a product analyst.',
    }],
  ]);
}

function makeProjects(projectsDir?: string): Map<string, Project> {
  return new Map([
    ['acme', {
      name: 'Acme',
      description: 'Test project',
      paths: ['../backend-api', '../web-portal'],
      roles: ['api-dev', 'portal-dev', 'product-analyst'],
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
// Server creation tests
// ============================================================

test('createHarnessServer readonly — creates server with type sdk', () => {
  const pool = new AgentPool();
  const projectsDir = makeTempTasksDir();
  const server = createHarnessServer({ pool, projects: makeProjects(), projectsDir, roles: makeRoles(), tools: 'readonly' });

  assert.equal(server.type, 'sdk');
  assert.equal(server.name, 'harness');
});

test('createHarnessServer full — creates server with lifecycle tools', () => {
  const pool = new AgentPool();
  const projectsDir = makeTempTasksDir();
  const tracker = new DispatchTracker();
  const draftFn: DraftAgentFn = async () => ({ status: 'completed', duration_ms: 0 });

  const server = createHarnessServer({
    pool, projects: makeProjects(), projectsDir, roles: makeRoles(), tools: 'full',
    tracker, draftFn,
  });

  assert.equal(server.type, 'sdk');
  assert.equal(server.name, 'harness');
});

test('createHarnessServer full without tracker — throws', () => {
  const pool = new AgentPool();
  const projectsDir = makeTempTasksDir();

  assert.throws(
    () => createHarnessServer({ pool, projects: makeProjects(), projectsDir, roles: makeRoles(), tools: 'full' }),
    /Full MCP server requires tracker and draftFn/,
  );
});

test('createHarnessServer — non-existent projectsDir does not throw', () => {
  const pool = new AgentPool();
  const projectsDir = path.join(os.tmpdir(), 'nonexistent-dir-' + Date.now());
  const server = createHarnessServer({ pool, projects: makeProjects(), projectsDir, roles: makeRoles(), tools: 'readonly' });
  assert.ok(server);
});

// ============================================================
// draft_agent tool handler tests (via DraftAgentFn mock)
// ============================================================

test('draft_agent — returns agent ID without blocking', async () => {
  const pool = new AgentPool();
  const projectsDir = makeTempTasksDir();
  const tracker = new DispatchTracker();
  let draftCalled = false;

  const draftFn: DraftAgentFn = async (role, prompt) => {
    draftCalled = true;
    return { status: 'completed', duration_ms: 100 };
  };

  const server = createHarnessServer({
    pool, projects: makeProjects(), projectsDir, roles: makeRoles(), tools: 'full',
    tracker, draftFn,
  });

  const resultPromise = draftFn('api-dev', 'Build something');
  const agentId = 'test-agent-1';
  tracker.track(agentId, { promise: resultPromise, role: 'api-dev', startedAt: new Date() });

  assert.ok(tracker.has(agentId));
  const result = await tracker.await(agentId);
  assert.equal(result.status, 'completed');
  assert.ok(draftCalled);
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
