import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

function makeAdapter() {
  return {
    name: 'test',
    send: mock.fn(async () => {}),
    setStatus: mock.fn(async () => {}),
  };
}

function makeConfig() {
  return {
    models: { default: 'claude-sonnet-4-6' },
    pool: { maxConcurrent: 2 },
    routing: { rules: [] },
    debounce: { enabled: false, windowMs: 0 },
  };
}

function makeRoles() {
  return new Map([
    ['api-dev', {
      name: 'api-dev',
      displayName: 'API Dev',
      category: 'coding',
      cwd: '../backend-api',
      prompt: 'You are an API developer.',
    }],
  ]);
}

// --- Mock dispatch to capture content ---
let capturedContent: string | undefined;

function getCaptured(): string {
  assert.ok(capturedContent !== undefined, 'dispatch should have been called');
  return capturedContent;
}

mock.module('./dispatch.js', {
  namedExports: {
    dispatch: mock.fn(async (content: string) => {
      capturedContent = content;
      return { status: 'completed', result: 'mocked' };
    }),
  },
});

// --- Mock task.js so we control the task directory ---
let mockTaskDir: string | undefined;

mock.module('./task.js', {
  namedExports: {
    getOrCreateTask: mock.fn((_threadTs: string, _msg: string, _dir: string) => ({
      slug: 'test-task',
      taskDir: mockTaskDir!,
      threadTs: _threadTs,
      created: '2026-02-19T10:00:00.000Z',
    })),
    recordDispatch: mock.fn(() => {}),
    nextJournalFile: mock.fn(() => 'api-dev.md'),
    generateSlug: mock.fn(() => 'test-task'),
  },
});

// Dynamic import AFTER mocks are registered
const { handleTask } = await import('./core.js');

test('follow-up dispatch with prior results — content includes task history', async () => {
  const taskDir = makeTempTaskDir('test-task', {
    slug: 'test-task',
    created: '2026-02-19T10:00:00.000Z',
    threadTs: 'thread-123',
    description: 'Build the login feature',
    dispatches: [{
      role: 'api-dev',
      cwd: '../backend-api',
      model: 'claude-sonnet-4-6',
      startedAt: '2026-02-19T10:00:00.000Z',
      completedAt: '2026-02-19T10:05:00.000Z',
      status: 'completed',
      journalFile: 'api-dev.md',
      result: {
        summary: 'Added login endpoint',
        changes: ['AuthController.cs'],
      },
    }],
  });
  mockTaskDir = taskDir;
  capturedContent = undefined;

  const message = {
    id: 'msg-1',
    content: 'Now add rate limiting',
    threadId: 'thread-123',
    source: 'slack',
    role: 'api-dev',
  };

  await handleTask(message, makeAdapter(), makeRoles(), makeConfig() as any);

  const content = getCaptured();
  assert.ok(content.includes('## Task History'), 'should include Task History header');
  assert.ok(content.includes('Added login endpoint'), 'should include prior dispatch summary');
  assert.ok(content.includes('Now add rate limiting'), 'should include new message content');
  assert.ok(content.includes('---\n\nNow add rate limiting'), 'should have separator before new content');
});

test('new task (no prior dispatches) — content is NOT enriched', async () => {
  const taskDir = makeTempTaskDir('test-task-new', {
    slug: 'test-task-new',
    created: '2026-02-19T11:00:00.000Z',
    threadTs: 'thread-456',
    description: 'Brand new task',
    dispatches: [],
  });
  mockTaskDir = taskDir;
  capturedContent = undefined;

  const message = {
    id: 'msg-2',
    content: 'Do something new',
    threadId: 'thread-456',
    source: 'slack',
    role: 'api-dev',
  };

  await handleTask(message, makeAdapter(), makeRoles(), makeConfig() as any);

  const content = getCaptured();
  assert.ok(!content.includes('## Task History'), 'should NOT include Task History for new task');
  assert.equal(content, 'Do something new', 'content should be unmodified');
});

test('task with failed dispatch (no result) — content is NOT enriched', async () => {
  const taskDir = makeTempTaskDir('test-task-failed', {
    slug: 'test-task-failed',
    created: '2026-02-19T11:00:00.000Z',
    threadTs: 'thread-789',
    description: 'Task with a crash',
    dispatches: [{
      role: 'api-dev',
      cwd: '../backend-api',
      model: 'claude-sonnet-4-6',
      startedAt: '2026-02-19T10:00:00.000Z',
      completedAt: '2026-02-19T10:01:00.000Z',
      status: 'crashed',
      journalFile: 'api-dev.md',
    }],
  });
  mockTaskDir = taskDir;
  capturedContent = undefined;

  const message = {
    id: 'msg-3',
    content: 'Try again please',
    threadId: 'thread-789',
    source: 'slack',
    role: 'api-dev',
  };

  await handleTask(message, makeAdapter(), makeRoles(), makeConfig() as any);

  const content = getCaptured();
  assert.ok(!content.includes('## Task History'), 'should NOT include Task History when no dispatches have results');
  assert.equal(content, 'Try again please', 'content should be unmodified');
});
