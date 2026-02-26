import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import { AgentPool } from './pool.js';
import { registerWsMethods, type WsMethodDeps } from './ws-methods.js';
import type { WsAdapter } from './adapters/ws.js';
import type { InboundMessage } from './comms.js';
import type { Config } from './config.js';
import type { RoleDefinition, Project } from './types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRole(name = 'api-dev'): RoleDefinition {
  return {
    id: '01HXYZ01234567890ABCDEFGH',
    version: '1.0.0',
    name,
    description: 'Test role.',
    createdOn: '2026-02-24T15:00:00Z',
    createdBy: 'Test',
    displayName: 'API Dev',
    modelHint: 'sonnet-latest',
    prompt: '',
  };
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

type MockDeps = {
  deps: WsMethodDeps;
  methods: Map<string, (params: unknown) => unknown>;
  pool: AgentPool;
  getHandleTaskState: () => { called: boolean; lastMessage: InboundMessage | undefined };
};

function makeMockDeps(overrides?: { projectsDir?: string; roles?: Map<string, RoleDefinition> }): MockDeps {
  const pool = new AgentPool();
  const methods = new Map<string, (params: unknown) => unknown>();
  const projectsDir = overrides?.projectsDir ?? os.tmpdir();

  const mockWsAdapter = {
    name: 'ws-mock',
    addMethod(name: string, handler: (params: unknown) => unknown) {
      methods.set(name, handler);
    },
    async send() {},
    async setStatus() {},
    broadcastNotification() {},
  } as unknown as WsAdapter;

  let handleTaskCalled = false;
  let lastMessage: InboundMessage | undefined;

  const deps: WsMethodDeps = {
    wsAdapter: mockWsAdapter,
    handleTask: async (msg) => {
      handleTaskCalled = true;
      lastMessage = msg;
      return { status: 'completed' };
    },
    roles: overrides?.roles ?? new Map([['api-dev', makeRole()]]),
    config: {} as Config,
    pool,
    projects: makeProjects(),
    projectsDir,
  };

  registerWsMethods(deps);

  return {
    deps,
    methods,
    pool,
    getHandleTaskState: () => ({ called: handleTaskCalled, lastMessage }),
  };
}

function call(methods: Map<string, (params: unknown) => unknown>, method: string, params: unknown = {}) {
  const handler = methods.get(method);
  assert.ok(handler, `method "${method}" not registered`);
  return handler(params);
}

function makeTempProjectDir(projectName: string, taskSlug: string, manifest: object): string {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-methods-test-'));
  const tasksDir = path.join(projectsDir, projectName.toLowerCase(), 'tasks', taskSlug);
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, 'task.json'), JSON.stringify(manifest, null, 2));
  return projectsDir;
}

// ─── list_projects ──────────────────────────────────────────────────────────

test('list_projects — returns loaded projects', () => {
  const { methods } = makeMockDeps();
  const result = call(methods, 'list_projects', {}) as { projects: Record<string, unknown>[] };
  assert.strictEqual(result.projects.length, 1);
  assert.strictEqual(result.projects[0]!['name'], 'Acme');
});

// ─── submit_prompt ──────────────────────────────────────────────────────────

test('submit_prompt — returns threadId immediately', () => {
  const { methods } = makeMockDeps();
  const result = call(methods, 'submit_prompt', { content: 'hello world', project: 'Acme' }) as Record<string, unknown>;

  assert.ok(typeof result['threadId'] === 'string', 'threadId should be a string');
  assert.ok((result['threadId'] as string).startsWith('ws-'), 'threadId should start with ws-');
  assert.strictEqual(result['taskSlug'], null);
});

test('submit_prompt — fires handleTask asynchronously', () => {
  const { methods, getHandleTaskState } = makeMockDeps();
  call(methods, 'submit_prompt', { content: 'do something', project: 'Acme' });

  const { called, lastMessage } = getHandleTaskState();
  assert.ok(called, 'handleTask should have been called');
  assert.strictEqual(lastMessage?.content, 'do something');
  assert.strictEqual(lastMessage?.source, 'ws');
  assert.strictEqual(lastMessage?.project, 'Acme');
});

test('submit_prompt — validates content is required', () => {
  const { methods } = makeMockDeps();

  assert.throws(
    () => call(methods, 'submit_prompt', { content: '', project: 'Acme' }),
    (err: unknown) => {
      assert.ok(err instanceof JSONRPCErrorException);
      assert.strictEqual(err.code, -32602);
      return true;
    },
  );
});

test('submit_prompt — validates role exists', () => {
  const { methods } = makeMockDeps();

  assert.throws(
    () => call(methods, 'submit_prompt', { content: 'hello', role: 'nonexistent-role', project: 'Acme' }),
    (err: unknown) => {
      assert.ok(err instanceof JSONRPCErrorException);
      assert.strictEqual(err.code, -32002);
      return true;
    },
  );
});

test('submit_prompt — requires project for autonomous dispatch', () => {
  const { methods } = makeMockDeps();

  assert.throws(
    () => call(methods, 'submit_prompt', { content: 'hello' }),
    (err: unknown) => {
      assert.ok(err instanceof JSONRPCErrorException);
      assert.strictEqual(err.code, -32602);
      return true;
    },
  );
});

test('submit_prompt — validates project exists', () => {
  const { methods } = makeMockDeps();

  assert.throws(
    () => call(methods, 'submit_prompt', { content: 'hello', project: 'nonexistent' }),
    (err: unknown) => {
      assert.ok(err instanceof JSONRPCErrorException);
      assert.strictEqual(err.code, -32006);
      return true;
    },
  );
});

// ─── create_task ────────────────────────────────────────────────────────────

test('create_task — creates task in project', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-create-task-'));
  const projDir = path.join(projectsDir, 'acme');
  fs.mkdirSync(projDir, { recursive: true });

  const { methods } = makeMockDeps({ projectsDir });
  const result = call(methods, 'create_task', { project: 'Acme', name: 'Test task' }) as Record<string, unknown>;

  assert.ok(typeof result['slug'] === 'string');
  assert.ok(typeof result['taskDir'] === 'string');
});

test('create_task — validates project required', () => {
  const { methods } = makeMockDeps();

  assert.throws(
    () => call(methods, 'create_task', { name: 'Test' }),
    (err: unknown) => err instanceof JSONRPCErrorException && err.code === -32602,
  );
});

// ─── close_task ─────────────────────────────────────────────────────────────

test('close_task — errors for nonexistent task', () => {
  const { methods } = makeMockDeps();

  assert.throws(
    () => call(methods, 'close_task', { project: 'Acme', slug: 'nonexistent' }),
    (err: unknown) => err instanceof JSONRPCErrorException && err.code === -32000,
  );
});

// ─── kill_agent ─────────────────────────────────────────────────────────────

test('kill_agent — kills existing agent', () => {
  const { methods, pool } = makeMockDeps();
  pool.register({ id: 'agent-1', role: 'api-dev', taskSlug: 'task-1', startedAt: new Date(), controller: new AbortController() });

  assert.strictEqual(pool.size, 1);
  const result = call(methods, 'kill_agent', { agentId: 'agent-1' }) as Record<string, unknown>;

  assert.strictEqual(result['success'], true);
  assert.strictEqual(pool.size, 0);
});

test('kill_agent — errors for unknown agent', () => {
  const { methods } = makeMockDeps();

  assert.throws(
    () => call(methods, 'kill_agent', { agentId: 'bogus-id' }),
    (err: unknown) => {
      assert.ok(err instanceof JSONRPCErrorException);
      assert.strictEqual(err.code, -32001);
      return true;
    },
  );
});

// ─── list_agents ─────────────────────────────────────────────────────────────

test('list_agents — returns safe JSON (no controller field)', () => {
  const { methods, pool } = makeMockDeps();
  pool.register({ id: 'agent-1', role: 'api-dev', taskSlug: 'task-1', startedAt: new Date(), controller: new AbortController() });

  const result = call(methods, 'list_agents', {}) as { agents: Record<string, unknown>[] };

  assert.strictEqual(result.agents.length, 1);
  for (const agent of result.agents) {
    assert.ok(!('controller' in agent), 'controller should be stripped');
    assert.ok(typeof agent['id'] === 'string');
  }
});

// ─── list_tasks ──────────────────────────────────────────────────────────────

test('list_tasks — requires project param', () => {
  const { methods } = makeMockDeps();

  assert.throws(
    () => call(methods, 'list_tasks', {}),
    (err: unknown) => err instanceof JSONRPCErrorException && err.code === -32602,
  );
});

test('list_tasks — returns tasks from project dir', () => {
  const projectsDir = makeTempProjectDir('acme', 'my-task', {
    slug: 'my-task',
    name: 'Test task',
    project: 'Acme',
    status: 'open',
    created: '2026-02-20T00:00:00.000Z',
    description: 'Test task description',
    dispatches: [],
  });

  try {
    const { methods } = makeMockDeps({ projectsDir });
    const result = call(methods, 'list_tasks', { project: 'Acme' }) as { tasks: Record<string, unknown>[] };

    assert.strictEqual(result.tasks.length, 1);
    assert.strictEqual(result.tasks[0]!['slug'], 'my-task');
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

// ─── get_task_context ────────────────────────────────────────────────────────

test('get_task_context — returns context for existing task', () => {
  const projectsDir = makeTempProjectDir('acme', 'ctx-task', {
    slug: 'ctx-task',
    name: 'Context test task',
    project: 'Acme',
    status: 'open',
    created: '2026-02-20T00:00:00.000Z',
    description: 'Context test task',
    dispatches: [],
  });

  try {
    const { methods } = makeMockDeps({ projectsDir });
    const result = call(methods, 'get_task_context', { slug: 'ctx-task', project: 'Acme' }) as { context: string };

    assert.ok(typeof result.context === 'string');
    assert.ok(result.context.includes('Context test task'));
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('get_task_context — errors for missing task', () => {
  const { methods } = makeMockDeps();

  assert.throws(
    () => call(methods, 'get_task_context', { slug: 'nonexistent', project: 'Acme' }),
    (err: unknown) => {
      assert.ok(err instanceof JSONRPCErrorException);
      assert.strictEqual(err.code, -32000);
      return true;
    },
  );
});

test('get_task_context — requires project', () => {
  const { methods } = makeMockDeps();

  assert.throws(
    () => call(methods, 'get_task_context', { slug: 'my-task' }),
    (err: unknown) => err instanceof JSONRPCErrorException && err.code === -32602,
  );
});
