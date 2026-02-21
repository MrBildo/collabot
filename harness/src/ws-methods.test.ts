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
import type { RoleDefinition } from './types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRole(name = 'api-dev'): RoleDefinition {
  return { name, displayName: 'API Dev', category: 'coding', prompt: '' };
}

type MockDeps = {
  deps: WsMethodDeps;
  methods: Map<string, (params: unknown) => unknown>;
  pool: AgentPool;
  getHandleTaskState: () => { called: boolean; lastMessage: InboundMessage | undefined };
};

function makeMockDeps(overrides?: { tasksDir?: string; roles?: Map<string, RoleDefinition> }): MockDeps {
  const pool = new AgentPool();
  const methods = new Map<string, (params: unknown) => unknown>();

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
    tasksDir: overrides?.tasksDir ?? os.tmpdir(),
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

function makeTempTaskDir(slug: string, manifest: object): string {
  const tasksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-methods-test-'));
  const taskDir = path.join(tasksDir, slug);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(manifest, null, 2));
  return tasksDir;
}

// ─── submit_prompt ──────────────────────────────────────────────────────────

test('submit_prompt — returns threadId immediately', () => {
  const { methods } = makeMockDeps();
  const result = call(methods, 'submit_prompt', { content: 'hello world' }) as Record<string, unknown>;

  assert.ok(typeof result['threadId'] === 'string', 'threadId should be a string');
  assert.ok((result['threadId'] as string).startsWith('ws-'), 'threadId should start with ws-');
  assert.strictEqual(result['taskSlug'], null);
});

test('submit_prompt — fires handleTask asynchronously', () => {
  const { methods, getHandleTaskState } = makeMockDeps();
  call(methods, 'submit_prompt', { content: 'do something' });

  // handleTask mock body has no awaits — runs synchronously up to completion
  const { called, lastMessage } = getHandleTaskState();
  assert.ok(called, 'handleTask should have been called');
  assert.strictEqual(lastMessage?.content, 'do something');
  assert.strictEqual(lastMessage?.source, 'ws');
});

test('submit_prompt — validates content is required', () => {
  const { methods } = makeMockDeps();

  assert.throws(
    () => call(methods, 'submit_prompt', { content: '' }),
    (err: unknown) => {
      assert.ok(err instanceof JSONRPCErrorException);
      assert.strictEqual(err.code, -32602);
      return true;
    },
  );

  assert.throws(
    () => call(methods, 'submit_prompt', {}),
    (err: unknown) => err instanceof JSONRPCErrorException && err.code === -32602,
  );
});

test('submit_prompt — validates role exists', () => {
  const { methods } = makeMockDeps();

  assert.throws(
    () => call(methods, 'submit_prompt', { content: 'hello', role: 'nonexistent-role' }),
    (err: unknown) => {
      assert.ok(err instanceof JSONRPCErrorException);
      assert.strictEqual(err.code, -32002);
      return true;
    },
  );
});

test('submit_prompt — passes taskSlug in metadata and return value', () => {
  const { methods, getHandleTaskState } = makeMockDeps();
  const result = call(methods, 'submit_prompt', { content: 'follow-up', taskSlug: 'my-task' }) as Record<string, unknown>;

  assert.strictEqual(result['taskSlug'], 'my-task');
  const { lastMessage } = getHandleTaskState();
  assert.strictEqual(lastMessage?.metadata?.['taskSlug'], 'my-task');
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
  pool.register({ id: 'agent-2', role: 'pm', taskSlug: 'task-2', startedAt: new Date(), controller: new AbortController() });

  const result = call(methods, 'list_agents', {}) as { agents: Record<string, unknown>[] };

  assert.strictEqual(result.agents.length, 2);
  for (const agent of result.agents) {
    assert.ok(!('controller' in agent), 'controller should be stripped');
    assert.ok(typeof agent['id'] === 'string');
    assert.ok(typeof agent['role'] === 'string');
    assert.ok(typeof agent['startedAt'] === 'string', 'startedAt should be ISO string');
  }
});

test('list_agents — returns empty array when pool is empty', () => {
  const { methods } = makeMockDeps();
  const result = call(methods, 'list_agents', {}) as { agents: unknown[] };
  assert.strictEqual(result.agents.length, 0);
});

// ─── list_tasks ──────────────────────────────────────────────────────────────

test('list_tasks — returns task summaries from disk', () => {
  const tasksDir = makeTempTaskDir('my-task', {
    slug: 'my-task',
    created: '2026-02-20T00:00:00.000Z',
    description: 'Test task description',
    dispatches: [{ role: 'api-dev' }, { role: 'api-dev' }],
  });

  try {
    const { methods } = makeMockDeps({ tasksDir });
    const result = call(methods, 'list_tasks', {}) as { tasks: Record<string, unknown>[] };

    assert.strictEqual(result.tasks.length, 1);
    const task = result.tasks[0]!;
    assert.strictEqual(task['slug'], 'my-task');
    assert.strictEqual(task['description'], 'Test task description');
    assert.strictEqual(task['dispatchCount'], 2);
  } finally {
    fs.rmSync(tasksDir, { recursive: true, force: true });
  }
});

test('list_tasks — returns empty array when no tasks', () => {
  const tasksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-methods-empty-'));
  try {
    const { methods } = makeMockDeps({ tasksDir });
    const result = call(methods, 'list_tasks', {}) as { tasks: unknown[] };
    assert.strictEqual(result.tasks.length, 0);
  } finally {
    fs.rmSync(tasksDir, { recursive: true, force: true });
  }
});

// ─── get_task_context ────────────────────────────────────────────────────────

test('get_task_context — returns context for existing task', () => {
  const tasksDir = makeTempTaskDir('ctx-task', {
    slug: 'ctx-task',
    created: '2026-02-20T00:00:00.000Z',
    description: 'Context test task',
    dispatches: [],
  });

  try {
    const { methods } = makeMockDeps({ tasksDir });
    const result = call(methods, 'get_task_context', { slug: 'ctx-task' }) as { context: string };

    assert.ok(typeof result.context === 'string', 'context should be a string');
    assert.ok(result.context.includes('Context test task'), 'context should include task description');
  } finally {
    fs.rmSync(tasksDir, { recursive: true, force: true });
  }
});

test('get_task_context — errors for missing task', () => {
  const tasksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-methods-missing-'));
  try {
    const { methods } = makeMockDeps({ tasksDir });

    assert.throws(
      () => call(methods, 'get_task_context', { slug: 'nonexistent' }),
      (err: unknown) => {
        assert.ok(err instanceof JSONRPCErrorException);
        assert.strictEqual(err.code, -32000);
        return true;
      },
    );
  } finally {
    fs.rmSync(tasksDir, { recursive: true, force: true });
  }
});
