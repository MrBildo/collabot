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
import type { RoleDefinition, DispatchResult, Project } from './types.js';

// --- Helpers ---

function makeTempProjectsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'integ-test-'));
}

function createTask(projectsDir: string, projectName: string, slug: string, manifest: Record<string, unknown>): string {
  const taskDir = path.join(projectsDir, projectName.toLowerCase(), 'tasks', slug);
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
      prompt: 'You are an API developer.',
    }],
    ['product-analyst', {
      name: 'product-analyst',
      displayName: 'PM',
      category: 'conversational',
      prompt: 'You are a product analyst.',
    }],
  ]);
}

function makeProjects(): Map<string, Project> {
  return new Map([
    ['acme', {
      name: 'Acme',
      description: 'Test project',
      paths: ['../backend-api'],
      roles: ['api-dev', 'product-analyst'],
    }],
  ]);
}

// ============================================================
// Full integration flow: draft → list_agents → await → get_task_context
// ============================================================

test('integration: draft_agent → list → await → get_task_context (full flow)', async () => {
  const pool = new AgentPool();
  const projectsDir = makeTempProjectsDir();
  const tracker = new DispatchTracker();

  // Create a pre-existing task with history
  const taskDir = createTask(projectsDir, 'acme', 'existing-task', {
    slug: 'existing-task',
    name: 'Integration test task',
    project: 'Acme',
    status: 'open',
    created: '2026-02-20T10:00:00Z',
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

  // Mock draftFn
  let draftCalledWith: { role: string; prompt: string } | undefined;
  const draftFn: DraftAgentFn = async (role, prompt, opts) => {
    draftCalledWith = { role, prompt };
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      status: 'completed',
      structuredResult: { status: 'success', summary: 'Mock agent completed' },
      cost: 0.05,
      duration_ms: 50,
    };
  };

  const roles = makeRoles();
  const server = createHarnessServer({
    pool, projects: makeProjects(), projectsDir, roles, tools: 'full',
    tracker, draftFn,
    parentProject: 'Acme',
  });

  assert.equal(server.type, 'sdk');

  // Step 1: Simulate draft_agent
  const agentId = 'test-agent-integ';
  const dispatchPromise = draftFn('api-dev', 'Build a new endpoint', {
    taskSlug: 'existing-task',
    taskDir,
    cwd: '../backend-api',
  });
  tracker.track(agentId, {
    promise: dispatchPromise,
    role: 'api-dev',
    startedAt: new Date(),
    taskDir,
    cwd: '../backend-api',
  });

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

  // Step 3: Await the agent result
  const result = await tracker.await(agentId);
  assert.equal(result.status, 'completed');
  assert.equal(result.structuredResult?.summary, 'Mock agent completed');

  tracker.delete(agentId);
  pool.release(agentId);

  // Step 4: Verify draftFn was called correctly
  assert.ok(draftCalledWith);
  assert.equal(draftCalledWith.role, 'api-dev');

  // Step 5: Verify get_task_context returns history
  const { buildTaskContext } = await import('./context.js');
  const context = buildTaskContext(taskDir);
  assert.ok(context.includes('## Task History'));
  assert.ok(context.includes('Built the endpoint'));
});

// ============================================================
// Access control: role category determines server type
// ============================================================

test('integration: coding role gets readonly, conversational gets full', () => {
  const roles = makeRoles();

  const config = {
    mcp: { fullAccessCategories: ['conversational'] },
  };

  const apiDevRole = roles.get('api-dev')!;
  const isFullApiDev = config.mcp.fullAccessCategories.includes(apiDevRole.category);
  assert.equal(isFullApiDev, false);

  const pmRole = roles.get('product-analyst')!;
  const isFullPm = config.mcp.fullAccessCategories.includes(pmRole.category);
  assert.equal(isFullPm, true);
});

// ============================================================
// Kill flow
// ============================================================

test('integration: kill_agent aborts via pool and cleans tracker', async () => {
  const pool = new AgentPool();
  const tracker = new DispatchTracker();

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

  assert.equal(pool.size, 1);
  assert.ok(tracker.has(agentId));
  assert.equal(controller.signal.aborted, false);

  pool.kill(agentId);
  tracker.delete(agentId);

  assert.equal(pool.size, 0);
  assert.equal(tracker.has(agentId), false);
  assert.equal(controller.signal.aborted, true);

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

  const [r1, r2] = await Promise.all([
    tracker.await('agent-1'),
    tracker.await('agent-2'),
  ]);

  assert.equal(r1.structuredResult?.summary, 'Agent 1 done');
  assert.equal(r2.structuredResult?.summary, 'Agent 2 done');
});

// ============================================================
// Readonly server creation
// ============================================================

test('integration: readonly server creation succeeds without tracker/draftFn', () => {
  const pool = new AgentPool();
  const projectsDir = makeTempProjectsDir();

  const server = createHarnessServer({ pool, projects: makeProjects(), projectsDir, roles: makeRoles(), tools: 'readonly' });
  assert.equal(server.type, 'sdk');
});

test('integration: full server creation requires tracker and draftFn', () => {
  const pool = new AgentPool();
  const projectsDir = makeTempProjectsDir();

  assert.throws(
    () => createHarnessServer({ pool, projects: makeProjects(), projectsDir, roles: makeRoles(), tools: 'full' }),
    /Full MCP server requires tracker and draftFn/,
  );
});
