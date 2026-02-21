import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getOrCreateTask, recordDispatch, generateSlug, nextJournalFile } from './task.js';
import type { DispatchRecord } from './task.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'task-test-'));
}

function readManifest(taskDir: string) {
  return JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf-8'));
}

// ── Description field ───────────────────────────────────────────

test('getOrCreateTask stores description in task.json', () => {
  const tasksDir = makeTempDir();
  const task = getOrCreateTask('thread-1', 'Build the login feature', tasksDir);
  const manifest = readManifest(task.taskDir);
  assert.strictEqual(manifest.description, 'Build the login feature');
});

test('getOrCreateTask returns existing task without overwriting description', () => {
  const tasksDir = makeTempDir();
  const task1 = getOrCreateTask('thread-1', 'Build the login feature', tasksDir);
  const task2 = getOrCreateTask('thread-1', 'Different message in same thread', tasksDir);
  assert.strictEqual(task1.slug, task2.slug);
  const manifest = readManifest(task2.taskDir);
  assert.strictEqual(manifest.description, 'Build the login feature');
});

// ── Result persistence ──────────────────────────────────────────

test('recordDispatch with result persists full result in task.json', () => {
  const tasksDir = makeTempDir();
  const task = getOrCreateTask('thread-2', 'Add user settings', tasksDir);

  const dispatch: DispatchRecord = {
    role: 'api-dev',
    cwd: '../backend-api',
    model: 'claude-sonnet-4-6',
    startedAt: '2026-02-19T10:00:00.000Z',
    completedAt: '2026-02-19T10:05:00.000Z',
    status: 'completed',
    journalFile: 'api-dev.md',
    result: {
      summary: 'Added user settings endpoint',
      changes: ['src/Controllers/SettingsController.cs', 'src/Models/UserSettings.cs'],
      issues: ['Migration needed for new table'],
      questions: ['Should settings be per-device or per-account?'],
    },
  };

  recordDispatch(task.taskDir, dispatch);
  const manifest = readManifest(task.taskDir);

  assert.strictEqual(manifest.dispatches.length, 1);
  const recorded = manifest.dispatches[0];
  assert.strictEqual(recorded.role, 'api-dev');
  assert.strictEqual(recorded.completedAt, '2026-02-19T10:05:00.000Z');
  assert.strictEqual(recorded.result.summary, 'Added user settings endpoint');
  assert.deepStrictEqual(recorded.result.changes, ['src/Controllers/SettingsController.cs', 'src/Models/UserSettings.cs']);
  assert.deepStrictEqual(recorded.result.issues, ['Migration needed for new table']);
  assert.deepStrictEqual(recorded.result.questions, ['Should settings be per-device or per-account?']);
});

test('recordDispatch without result — result absent in task.json', () => {
  const tasksDir = makeTempDir();
  const task = getOrCreateTask('thread-3', 'Fix bug', tasksDir);

  const dispatch: DispatchRecord = {
    role: 'api-dev',
    cwd: '../backend-api',
    model: 'claude-sonnet-4-6',
    startedAt: '2026-02-19T10:00:00.000Z',
    completedAt: '2026-02-19T10:01:00.000Z',
    status: 'crashed',
    journalFile: 'api-dev.md',
  };

  recordDispatch(task.taskDir, dispatch);
  const manifest = readManifest(task.taskDir);

  assert.strictEqual(manifest.dispatches.length, 1);
  assert.strictEqual(manifest.dispatches[0].result, undefined);
  assert.strictEqual(manifest.dispatches[0].status, 'crashed');
});

test('multiple dispatches accumulate in task.json', () => {
  const tasksDir = makeTempDir();
  const task = getOrCreateTask('thread-4', 'Multi-step task', tasksDir);

  recordDispatch(task.taskDir, {
    role: 'api-dev',
    cwd: '../backend-api',
    model: 'claude-sonnet-4-6',
    startedAt: '2026-02-19T10:00:00.000Z',
    completedAt: '2026-02-19T10:05:00.000Z',
    status: 'completed',
    journalFile: 'api-dev.md',
    result: { summary: 'API done' },
  });

  recordDispatch(task.taskDir, {
    role: 'portal-dev',
    cwd: '../web-portal',
    model: 'claude-sonnet-4-6',
    startedAt: '2026-02-19T10:06:00.000Z',
    completedAt: '2026-02-19T10:10:00.000Z',
    status: 'completed',
    journalFile: 'portal-dev.md',
    result: { summary: 'Portal done' },
  });

  const manifest = readManifest(task.taskDir);
  assert.strictEqual(manifest.dispatches.length, 2);
  assert.strictEqual(manifest.dispatches[0].result.summary, 'API done');
  assert.strictEqual(manifest.dispatches[1].result.summary, 'Portal done');
});

// ── Slug generation ─────────────────────────────────────────────

test('generateSlug produces stable format', () => {
  const slug = generateSlug('Build the login feature for users');
  // Should contain meaningful words (stripped: build, the, for)
  assert.ok(slug.includes('login'));
  assert.ok(slug.includes('feature'));
  // Should have timestamp suffix
  assert.match(slug, /\d{4}-\d{4}$/);
});

// ── nextJournalFile ─────────────────────────────────────────────

test('nextJournalFile returns base name when no journals exist', () => {
  const dir = makeTempDir();
  assert.strictEqual(nextJournalFile(dir, 'api-dev'), 'api-dev.md');
});

test('nextJournalFile increments when base exists', () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'api-dev.md'), '', 'utf-8');
  assert.strictEqual(nextJournalFile(dir, 'api-dev'), 'api-dev-2.md');
});
