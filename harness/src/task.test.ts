import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTask, findTaskByThread, getTask, listTasks, closeTask, recordDispatch, generateSlug, deduplicateSlug, nextJournalFile } from './task.js';
import type { DispatchRecord, TaskManifest } from './task.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'task-test-'));
}

function readManifest(taskDir: string): TaskManifest {
  return JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf-8'));
}

// ── createTask ──────────────────────────────────────────────────

test('createTask creates manifest with all fields', () => {
  const tasksDir = makeTempDir();
  const task = createTask(tasksDir, {
    name: 'Build the login feature',
    project: 'acme',
    description: 'Full login feature with OAuth',
  });
  const manifest = readManifest(task.taskDir);
  assert.strictEqual(manifest.name, 'Build the login feature');
  assert.strictEqual(manifest.project, 'acme');
  assert.strictEqual(manifest.description, 'Full login feature with OAuth');
  assert.strictEqual(manifest.status, 'open');
  assert.ok(manifest.created);
  assert.deepStrictEqual(manifest.dispatches, []);
});

test('createTask with threadId stores it in manifest', () => {
  const tasksDir = makeTempDir();
  const task = createTask(tasksDir, {
    name: 'Draft session task',
    project: 'research',
    threadId: 'thread-123',
  });
  const manifest = readManifest(task.taskDir);
  assert.strictEqual(manifest.threadTs, 'thread-123');
});

// ── findTaskByThread ────────────────────────────────────────────

test('findTaskByThread returns existing task', () => {
  const tasksDir = makeTempDir();
  const original = createTask(tasksDir, {
    name: 'Some task',
    project: 'acme',
    threadId: 'thread-abc',
  });
  const found = findTaskByThread(tasksDir, 'thread-abc');
  assert.ok(found);
  assert.strictEqual(found.slug, original.slug);
});

test('findTaskByThread returns null for unknown thread', () => {
  const tasksDir = makeTempDir();
  createTask(tasksDir, { name: 'A task', project: 'acme', threadId: 'thread-1' });
  const found = findTaskByThread(tasksDir, 'thread-nonexistent');
  assert.strictEqual(found, null);
});

test('findTaskByThread returns null when tasks dir does not exist', () => {
  const found = findTaskByThread('/nonexistent/path', 'thread-1');
  assert.strictEqual(found, null);
});

// ── getTask ─────────────────────────────────────────────────────

test('getTask returns existing task by slug', () => {
  const tasksDir = makeTempDir();
  const original = createTask(tasksDir, { name: 'Test task', project: 'acme' });
  const task = getTask(tasksDir, original.slug);
  assert.strictEqual(task.slug, original.slug);
});

test('getTask throws for non-existent slug', () => {
  const tasksDir = makeTempDir();
  assert.throws(
    () => getTask(tasksDir, 'nonexistent-slug'),
    /not found/,
  );
});

// ── listTasks ───────────────────────────────────────────────────

test('listTasks returns all tasks', () => {
  const tasksDir = makeTempDir();
  createTask(tasksDir, { name: 'Task 1', project: 'acme' });
  createTask(tasksDir, { name: 'Task 2', project: 'acme' });
  const tasks = listTasks(tasksDir);
  assert.strictEqual(tasks.length, 2);
  assert.ok(tasks.every(t => t.status === 'open'));
});

test('listTasks returns empty for non-existent dir', () => {
  const tasks = listTasks('/nonexistent');
  assert.strictEqual(tasks.length, 0);
});

// ── closeTask ───────────────────────────────────────────────────

test('closeTask sets status to closed', () => {
  const tasksDir = makeTempDir();
  const task = createTask(tasksDir, { name: 'To close', project: 'acme' });
  closeTask(tasksDir, task.slug);
  const manifest = readManifest(task.taskDir);
  assert.strictEqual(manifest.status, 'closed');
});

test('closeTask throws for non-existent task', () => {
  const tasksDir = makeTempDir();
  assert.throws(
    () => closeTask(tasksDir, 'nonexistent'),
    /not found/,
  );
});

// ── recordDispatch ──────────────────────────────────────────────

test('recordDispatch with result persists full result', () => {
  const tasksDir = makeTempDir();
  const task = createTask(tasksDir, { name: 'Add user settings', project: 'acme' });

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
      changes: ['src/Controllers/SettingsController.cs'],
      issues: ['Migration needed'],
      questions: ['Per-device or per-account?'],
    },
  };

  recordDispatch(task.taskDir, dispatch);
  const manifest = readManifest(task.taskDir);

  assert.strictEqual(manifest.dispatches.length, 1);
  const recorded = manifest.dispatches[0]!;
  assert.strictEqual(recorded.role, 'api-dev');
  assert.strictEqual(recorded.result!.summary, 'Added user settings endpoint');
});

test('multiple dispatches accumulate', () => {
  const tasksDir = makeTempDir();
  const task = createTask(tasksDir, { name: 'Multi-step', project: 'acme' });

  recordDispatch(task.taskDir, {
    role: 'api-dev', cwd: '../api', model: 'claude-sonnet-4-6',
    startedAt: '2026-02-19T10:00:00.000Z', completedAt: '2026-02-19T10:05:00.000Z',
    status: 'completed', journalFile: 'api-dev.md',
    result: { summary: 'API done' },
  });

  recordDispatch(task.taskDir, {
    role: 'portal-dev', cwd: '../portal', model: 'claude-sonnet-4-6',
    startedAt: '2026-02-19T10:06:00.000Z', completedAt: '2026-02-19T10:10:00.000Z',
    status: 'completed', journalFile: 'portal-dev.md',
    result: { summary: 'Portal done' },
  });

  const manifest = readManifest(task.taskDir);
  assert.strictEqual(manifest.dispatches.length, 2);
});

// ── Slug generation ─────────────────────────────────────────────

test('generateSlug preserves valid slug names', () => {
  const result = generateSlug('test-task');
  assert.strictEqual(result.slug, 'test-task');
  assert.strictEqual(result.modified, false);
});

test('generateSlug preserves simple alphanumeric names', () => {
  const result = generateSlug('deploy');
  assert.strictEqual(result.slug, 'deploy');
  assert.strictEqual(result.modified, false);
});

test('generateSlug trims trailing hyphens without reporting modification', () => {
  const result = generateSlug('new-task-');
  assert.strictEqual(result.slug, 'new-task');
  assert.strictEqual(result.modified, false);
});

test('generateSlug trims leading hyphens without reporting modification', () => {
  const result = generateSlug('-my-task');
  assert.strictEqual(result.slug, 'my-task');
  assert.strictEqual(result.modified, false);
});

test('generateSlug lowercases without reporting modification', () => {
  const result = generateSlug('My-Task');
  assert.strictEqual(result.slug, 'my-task');
  assert.strictEqual(result.modified, false);
});

test('generateSlug normalizes natural language names', () => {
  const result = generateSlug('Build the login feature for users');
  assert.ok(result.slug.includes('login'));
  assert.ok(result.slug.includes('feature'));
  assert.strictEqual(result.modified, true);
});

test('generateSlug normalizes names with spaces', () => {
  const result = generateSlug('My Task Name');
  assert.strictEqual(result.modified, true);
  assert.ok(!result.slug.includes(' '));
  assert.match(result.slug, /^[a-z0-9-]+$/);
});

test('generateSlug handles empty-ish names', () => {
  const result = generateSlug('the a an');
  assert.strictEqual(result.slug, 'task');
  assert.strictEqual(result.modified, true);
});

// ── Slug deduplication ──────────────────────────────────────────

test('deduplicateSlug returns base when no collision', () => {
  const dir = makeTempDir();
  const result = deduplicateSlug(dir, 'test-task');
  assert.strictEqual(result.slug, 'test-task');
  assert.strictEqual(result.deduplicated, false);
});

test('deduplicateSlug appends -2 on collision', () => {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, 'test-task'));
  const result = deduplicateSlug(dir, 'test-task');
  assert.strictEqual(result.slug, 'test-task-2');
  assert.strictEqual(result.deduplicated, true);
});

test('deduplicateSlug increments past existing suffixes', () => {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, 'test-task'));
  fs.mkdirSync(path.join(dir, 'test-task-2'));
  const result = deduplicateSlug(dir, 'test-task');
  assert.strictEqual(result.slug, 'test-task-3');
  assert.strictEqual(result.deduplicated, true);
});

test('createTask returns slugModified false for valid slug name', () => {
  const tasksDir = makeTempDir();
  const task = createTask(tasksDir, { name: 'my-task', project: 'acme' });
  assert.strictEqual(task.slug, 'my-task');
  assert.strictEqual(task.slugModified, false);
});

test('createTask returns slugModified true for normalized name', () => {
  const tasksDir = makeTempDir();
  const task = createTask(tasksDir, { name: 'Build the login feature', project: 'acme' });
  assert.strictEqual(task.slugModified, true);
});

test('createTask deduplicates on collision', () => {
  const tasksDir = makeTempDir();
  const first = createTask(tasksDir, { name: 'my-task', project: 'acme' });
  const second = createTask(tasksDir, { name: 'my-task', project: 'acme' });
  assert.strictEqual(first.slug, 'my-task');
  assert.strictEqual(second.slug, 'my-task-2');
  assert.strictEqual(second.slugModified, true);
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
