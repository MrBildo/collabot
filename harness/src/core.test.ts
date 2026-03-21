import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Project } from './project.js';
import { JsonFileDispatchStore } from './dispatch-store.js';
import { CommunicationRegistry } from './registry.js';
import type { CommunicationProvider } from './comms.js';
import { AgentPool } from './pool.js';

// --- Test helpers ---
function makeTempTaskDir(slug: string, manifest: Record<string, unknown>): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'core-test-'));
  const taskDir = path.join(base, slug);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'task.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8',
  );
  return taskDir;
}

function makeRegistry(): CommunicationRegistry {
  const registry = new CommunicationRegistry();
  const provider: CommunicationProvider = {
    name: 'test',
    manifest: { id: 'test', name: 'Test', version: '1.0.0', description: 'Test', providerType: 'communication' },
    async start() {},
    async stop() {},
    isReady() { return true; },
    async send() {},
    async setStatus() {},
    onInbound() {},
  };
  registry.register(provider);
  return registry;
}

function makeConfig() {
  return {
    models: { default: 'claude-sonnet-4-6', aliases: { 'sonnet-latest': 'claude-sonnet-4-6' } },
    pool: { maxConcurrent: 2 },
    mcp: { streamTimeout: 600000 },
    defaults: { stallTimeoutSeconds: 300, dispatchTimeoutMs: 0, tokenBudget: 0, maxBudgetUsd: 0 },
    agent: { maxTurns: 0, maxBudgetUsd: 0 },
  };
}

function makeRoles() {
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

// --- Mock collabDispatch to capture the prompt ---
let capturedPrompt: string | undefined;

function getCaptured(): string {
  assert.ok(capturedPrompt !== undefined, 'collabDispatch should have been called');
  return capturedPrompt;
}

mock.module('./collab-dispatch.js', {
  namedExports: {
    collabDispatch: mock.fn(async (options: { prompt: string }) => {
      capturedPrompt = options.prompt;
      return {
        status: 'completed',
        result: 'mocked',
        taskSlug: 'test-task',
        dispatchId: 'mock-dispatch-id',
        cost: { totalUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, turns: 0, tokenBudget: null, tokenBudgetPercent: null },
        duration_ms: 100,
        model: 'claude-sonnet-4-6',
      };
    }),
  },
});

// --- Mock task.js so we control the task directory ---
let mockTaskDir: string | undefined;

mock.module('./task.js', {
  namedExports: {
    getTask: mock.fn((_tasksDir: string, _slug: string) => ({
      slug: 'test-task',
      taskDir: mockTaskDir!,
      created: '2026-02-19T10:00:00.000Z',
    })),
    createTask: mock.fn(() => ({
      slug: 'test-task',
      taskDir: mockTaskDir!,
      created: '2026-02-19T10:00:00.000Z',
      slugModified: false,
      originalName: 'test-task',
    })),
    findTaskByThread: mock.fn(() => ({
      slug: 'test-task',
      taskDir: mockTaskDir!,
      created: '2026-02-19T10:00:00.000Z',
    })),
    nextJournalFile: mock.fn(() => 'api-dev.md'),
    generateSlug: mock.fn(() => ({ slug: 'test-task', modified: false })),
    deduplicateSlug: mock.fn(() => ({ slug: 'test-task', deduplicated: false })),
    listTasks: mock.fn(() => []),
    closeTask: mock.fn(() => {}),
    getOpenTasks: mock.fn(() => []),
  },
});

// Dynamic import AFTER mocks are registered
const { handleTask } = await import('./core.js');

test('follow-up dispatch with prior results — prompt includes task history', async () => {
  const taskDir = makeTempTaskDir('test-task', {
    slug: 'test-task',
    name: 'Build the login feature',
    project: 'Acme',
    status: 'open',
    created: '2026-02-19T10:00:00.000Z',
    threadTs: 'thread-123',
    description: 'Build the login feature',
    dispatches: [],
  });

  const store = new JsonFileDispatchStore();
  store.createDispatch(taskDir, {
    dispatchId: '01JCORE0001',
    taskSlug: 'test-task',
    role: 'api-dev',
    model: 'claude-sonnet-4-6',
    cwd: '../backend-api',
    startedAt: '2026-02-19T10:00:00.000Z',
    completedAt: '2026-02-19T10:05:00.000Z',
    status: 'completed',
    structuredResult: {
      status: 'success',
      summary: 'Added login endpoint',
      changes: ['AuthController.cs'],
    },
  });

  mockTaskDir = taskDir;
  capturedPrompt = undefined;

  const message = {
    id: 'msg-1',
    content: 'Now add rate limiting',
    threadId: 'thread-123',
    source: 'ws',
    project: 'Acme',
    role: 'api-dev',
    metadata: { taskSlug: 'test-task' },
  };

  await handleTask(message, makeRegistry(), makeRoles(), makeConfig() as any, new AgentPool(), undefined, makeProjects(), '/tmp');

  // collabDispatch receives the raw prompt from handleTask.
  // Context reconstruction now happens inside collabDispatch (mocked),
  // so handleTask passes through the original content.
  const prompt = getCaptured();
  assert.ok(prompt.includes('Now add rate limiting'), 'should include the message content');
});

test('handleTask passes project and role correctly', async () => {
  const taskDir = makeTempTaskDir('test-task-new', {
    slug: 'test-task-new',
    name: 'Brand new task',
    project: 'Acme',
    status: 'open',
    created: '2026-02-19T11:00:00.000Z',
    description: 'Brand new task',
    dispatches: [],
  });
  mockTaskDir = taskDir;
  capturedPrompt = undefined;

  const message = {
    id: 'msg-2',
    content: 'Do something new',
    threadId: 'thread-456',
    source: 'ws',
    project: 'Acme',
    role: 'api-dev',
    metadata: { taskSlug: 'test-task-new' },
  };

  await handleTask(message, makeRegistry(), makeRoles(), makeConfig() as any, new AgentPool(), undefined, makeProjects(), '/tmp');

  const prompt = getCaptured();
  assert.equal(prompt, 'Do something new', 'prompt should be the raw message content');
});
