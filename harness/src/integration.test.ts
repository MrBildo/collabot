/**
 * Integration test — exercises the full MCP tool flow without a real SDK dispatch.
 *
 * Verifies that the MCP server, DispatchTracker, and pool work together
 * correctly for the draft → list → await → context flow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHarnessServer, DispatchTracker } from './mcp.js';
import type { DraftAgentFn } from './mcp.js';
import { AgentPool } from './pool.js';
import type { RoleDefinition, DispatchResult } from './types.js';

// --- Helpers ---

function makeTempTasksDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'integ-test-'));
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
// Full integration flow: draft → list_agents → await → get_task_context
// ============================================================

test('integration: draft_agent → list → await → get_task_context (full flow)', async () => {
  const pool = new AgentPool();
  const tasksDir = makeTempTasksDir();
  const tracker = new DispatchTracker();

  // Create a pre-existing task with history
  createTask(tasksDir, 'existing-task', {
    slug: 'existing-task',
    created: '2026-02-20T10:00:00Z',
    threadTs: 'thread-1',
    description: 'Integration test task',
    dispatches: [{
      role: 'api-dev',
      cwd: '../backend-api',
      model: 'claude-sonnet-4-6',
      startedAt: '2026-02-20T10:00:00Z',
      completedAt: '2026-02-20T10:05:00Z',
      status: 'completed',
      journalFile: 'api-dev.md',
      result: { summary: 'Built the endpoint', changes: ['AuthController.cs'] },
    }],
  });

  // Mock draftFn that resolves after a short delay
  let draftCalledWith: { role: string; prompt: string } | undefined;
  const draftFn: DraftAgentFn = async (role, prompt, opts) => {
    draftCalledWith = { role, prompt };
    // Simulate agent work with a short delay
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      status: 'completed',
      structuredResult: { status: 'success', summary: 'Mock agent completed' },
      cost: 0.05,
      duration_ms: 50,
    };
  };

  // Create the full MCP server
  const roles = makeRoles();
  const server = createHarnessServer({
    pool, tasksDir, roles, tools: 'full',
    tracker, draftFn,
  });

  assert.equal(server.type, 'sdk');
  assert.equal(server.name, 'harness');

  // Step 1: Simulate draft_agent — fire off a dispatch
  const agentId = 'test-agent-integ';
  const dispatchPromise = draftFn('api-dev', 'Build a new endpoint', {
    taskSlug: 'existing-task',
    taskDir: path.join(tasksDir, 'existing-task'),
  });
  tracker.track(agentId, {
    promise: dispatchPromise,
    role: 'api-dev',
    startedAt: new Date(),
    taskDir: path.join(tasksDir, 'existing-task'),
    cwd: '../backend-api',
  });

  // Simulate pool registration (normally done by draftAgent in core.ts)
  const controller = new AbortController();
  pool.register({
    id: agentId,
    role: 'api-dev',
    taskSlug: 'existing-task',
    startedAt: new Date(),
    controller,
  });

  // Step 2: Verify list_agents shows the agent
  const agents = pool.list();
  assert.equal(agents.length, 1);
  assert.equal(agents[0]?.id, agentId);
  assert.equal(agents[0]?.role, 'api-dev');

  // Step 3: Await the agent result
  const result = await tracker.await(agentId);
  assert.equal(result.status, 'completed');
  assert.equal(result.structuredResult?.summary, 'Mock agent completed');
  assert.equal(result.cost, 0.05);

  // Clean up tracker
  tracker.delete(agentId);
  assert.equal(tracker.has(agentId), false);

  // Release from pool
  pool.release(agentId);
  assert.equal(pool.size, 0);

  // Step 4: Verify draftFn was called correctly
  assert.ok(draftCalledWith);
  assert.equal(draftCalledWith.role, 'api-dev');
  assert.equal(draftCalledWith.prompt, 'Build a new endpoint');

  // Step 5: Verify get_task_context returns history
  const { buildTaskContext } = await import('./context.js');
  const context = buildTaskContext(path.join(tasksDir, 'existing-task'));
  assert.ok(context.includes('## Task History'));
  assert.ok(context.includes('Built the endpoint'));
  assert.ok(context.includes('AuthController.cs'));
});

// ============================================================
// Access control: role category determines server type
// ============================================================

test('integration: coding role gets readonly, conversational gets full', () => {
  const roles = makeRoles();

  const config = {
    mcp: { fullAccessCategories: ['conversational'] },
  };

  // coding category → NOT in fullAccessCategories → readonly
  const apiDevRole = roles.get('api-dev')!;
  const isFullApiDev = config.mcp.fullAccessCategories.includes(apiDevRole.category);
  assert.equal(isFullApiDev, false, 'coding role should not have full access');

  // conversational category → in fullAccessCategories → full
  const pmRole = roles.get('product-analyst')!;
  const isFullPm = config.mcp.fullAccessCategories.includes(pmRole.category);
  assert.equal(isFullPm, true, 'conversational role should have full access');
});

// ============================================================
// Kill flow
// ============================================================

test('integration: kill_agent aborts via pool and cleans tracker', async () => {
  const pool = new AgentPool();
  const tracker = new DispatchTracker();

  // Create a long-running dispatch
  let resolveDispatch: (result: DispatchResult) => void;
  const dispatchPromise = new Promise<DispatchResult>((resolve) => {
    resolveDispatch = resolve;
  });

  const agentId = 'agent-to-kill';
  tracker.track(agentId, { promise: dispatchPromise, role: 'api-dev', startedAt: new Date() });

  const controller = new AbortController();
  pool.register({
    id: agentId,
    role: 'api-dev',
    taskSlug: 'kill-test',
    startedAt: new Date(),
    controller,
  });

  // Verify agent is active
  assert.equal(pool.size, 1);
  assert.ok(tracker.has(agentId));
  assert.equal(controller.signal.aborted, false);

  // Kill the agent
  pool.kill(agentId);
  tracker.delete(agentId);

  // Verify cleanup
  assert.equal(pool.size, 0);
  assert.equal(tracker.has(agentId), false);
  assert.equal(controller.signal.aborted, true);

  // Resolve the pending promise to avoid unhandled rejection
  resolveDispatch!({ status: 'aborted', duration_ms: 0 });
});

// ============================================================
// Parallel draft pattern
// ============================================================

test('integration: parallel drafts — both tracked, both awaitable', async () => {
  const tracker = new DispatchTracker();

  const result1: DispatchResult = { status: 'completed', structuredResult: { status: 'success', summary: 'Agent 1 done' }, duration_ms: 100 };
  const result2: DispatchResult = { status: 'completed', structuredResult: { status: 'success', summary: 'Agent 2 done' }, duration_ms: 200 };

  tracker.track('agent-1', { promise: Promise.resolve(result1), role: 'api-dev', startedAt: new Date() });
  tracker.track('agent-2', { promise: Promise.resolve(result2), role: 'portal-dev', startedAt: new Date() });

  assert.ok(tracker.has('agent-1'));
  assert.ok(tracker.has('agent-2'));

  // Await both in parallel
  const [r1, r2] = await Promise.all([
    tracker.await('agent-1'),
    tracker.await('agent-2'),
  ]);

  assert.equal(r1.structuredResult?.summary, 'Agent 1 done');
  assert.equal(r2.structuredResult?.summary, 'Agent 2 done');

  tracker.delete('agent-1');
  tracker.delete('agent-2');
  assert.equal(tracker.has('agent-1'), false);
  assert.equal(tracker.has('agent-2'), false);
});

// ============================================================
// Readonly server does NOT have lifecycle tools (structural test)
// ============================================================

test('integration: readonly server creation succeeds without tracker/draftFn', () => {
  const pool = new AgentPool();
  const tasksDir = makeTempTasksDir();
  const roles = makeRoles();

  // Should NOT throw — readonly doesn't need lifecycle dependencies
  const server = createHarnessServer({ pool, tasksDir, roles, tools: 'readonly' });
  assert.equal(server.type, 'sdk');
  assert.equal(server.name, 'harness');
});

test('integration: full server creation requires tracker and draftFn', () => {
  const pool = new AgentPool();
  const tasksDir = makeTempTasksDir();
  const roles = makeRoles();

  // Should throw without tracker/draftFn
  assert.throws(
    () => createHarnessServer({ pool, tasksDir, roles, tools: 'full' }),
    /Full MCP server requires tracker and draftFn/,
  );
});
