import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildTaskContext } from './context.js';
import { JsonFileDispatchStore } from './dispatch-store.js';
import type { DispatchEnvelope } from './types.js';

const store = new JsonFileDispatchStore();
const tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-test-'));
  tmpDirs.push(dir);
  return dir;
}

function writeManifest(taskDir: string, manifest: Record<string, unknown>): void {
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(manifest, null, 2), 'utf-8');
}

function makeEnvelope(overrides?: Partial<DispatchEnvelope>): DispatchEnvelope {
  return {
    dispatchId: '01JCTX0001',
    taskSlug: 'test-task',
    role: 'ts-dev',
    model: 'claude-sonnet-4-6',
    cwd: '/projects/test',
    startedAt: '2026-02-19T10:00:00.000Z',
    status: 'running',
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
});

test('empty task (no dispatches) — returns context with original request only', () => {
  const taskDir = makeTempDir();
  writeManifest(taskDir, {
    slug: 'test-task',
    created: '2026-02-19T10:00:00.000Z',
    description: 'Build the login feature',
    dispatches: [],
  });

  const context = buildTaskContext(taskDir);
  assert.ok(context.includes('## Task History'));
  assert.ok(context.includes('### Original Request'));
  assert.ok(context.includes('Build the login feature'));
  assert.ok(!context.includes('### Previous Work'));
});

test('one completed dispatch with full result — properly formatted', () => {
  const taskDir = makeTempDir();
  writeManifest(taskDir, {
    slug: 'test-task',
    created: '2026-02-19T10:00:00.000Z',
    description: 'Build the login feature',
    dispatches: [],
  });

  store.createDispatch(taskDir, makeEnvelope({
    dispatchId: '01JCTX0001',
    role: 'api-dev',
    status: 'completed',
    startedAt: '2026-02-19T10:00:00.000Z',
    completedAt: '2026-02-19T10:05:00.000Z',
    structuredResult: {
      status: 'success',
      summary: 'Added login endpoint',
      changes: ['src/Controllers/AuthController.cs', 'src/Services/AuthService.cs'],
      issues: ['Need to add rate limiting'],
      questions: ['Should we use JWT or session cookies?'],
    },
  }));

  const context = buildTaskContext(taskDir);
  assert.ok(context.includes('### Previous Work'));
  assert.ok(context.includes('**api-dev** (completed)'));
  assert.ok(context.includes('Summary: Added login endpoint'));
  assert.ok(context.includes('- src/Controllers/AuthController.cs'));
  assert.ok(context.includes('- src/Services/AuthService.cs'));
  assert.ok(context.includes('- Need to add rate limiting'));
  assert.ok(context.includes('- Should we use JWT or session cookies?'));
});

test('multiple dispatches in chronological order — all included', () => {
  const taskDir = makeTempDir();
  writeManifest(taskDir, {
    slug: 'test-task',
    created: '2026-02-19T10:00:00.000Z',
    description: 'Build the login feature',
    dispatches: [],
  });

  store.createDispatch(taskDir, makeEnvelope({
    dispatchId: '01JCTX0002',
    role: 'portal-dev',
    status: 'completed',
    startedAt: '2026-02-19T10:06:00.000Z',
    completedAt: '2026-02-19T10:10:00.000Z',
    structuredResult: { status: 'success', summary: 'Built login form' },
  }));

  store.createDispatch(taskDir, makeEnvelope({
    dispatchId: '01JCTX0001',
    role: 'api-dev',
    status: 'completed',
    startedAt: '2026-02-19T10:00:00.000Z',
    completedAt: '2026-02-19T10:05:00.000Z',
    structuredResult: { status: 'success', summary: 'Added login endpoint' },
  }));

  const context = buildTaskContext(taskDir);
  // api-dev should appear before portal-dev (chronological by startedAt)
  const apiIdx = context.indexOf('**api-dev**');
  const portalIdx = context.indexOf('**portal-dev**');
  assert.ok(apiIdx > -1);
  assert.ok(portalIdx > -1);
  assert.ok(apiIdx < portalIdx, 'api-dev should appear before portal-dev (chronological order)');
});

test('crashed dispatch without result — skipped', () => {
  const taskDir = makeTempDir();
  writeManifest(taskDir, {
    slug: 'test-task',
    created: '2026-02-19T10:00:00.000Z',
    description: 'Build something',
    dispatches: [],
  });

  store.createDispatch(taskDir, makeEnvelope({
    dispatchId: '01JCTX0001',
    role: 'api-dev',
    status: 'crashed',
    startedAt: '2026-02-19T10:00:00.000Z',
    completedAt: '2026-02-19T10:01:00.000Z',
    // no structuredResult — crashed before producing output
  }));

  const context = buildTaskContext(taskDir);
  assert.ok(!context.includes('### Previous Work'));
  assert.ok(!context.includes('api-dev'));
});

test('aborted dispatch WITH result — included, status shown', () => {
  const taskDir = makeTempDir();
  writeManifest(taskDir, {
    slug: 'test-task',
    created: '2026-02-19T10:00:00.000Z',
    description: 'Build something',
    dispatches: [],
  });

  store.createDispatch(taskDir, makeEnvelope({
    dispatchId: '01JCTX0001',
    role: 'api-dev',
    status: 'aborted',
    startedAt: '2026-02-19T10:00:00.000Z',
    completedAt: '2026-02-19T10:01:00.000Z',
    structuredResult: {
      status: 'failed',
      summary: 'Could not complete — schema was wrong',
      issues: ['Database schema does not match expected model'],
    },
  }));

  const context = buildTaskContext(taskDir);
  assert.ok(context.includes('**api-dev** (aborted)'));
  assert.ok(context.includes('Summary: Could not complete'));
  assert.ok(context.includes('- Database schema does not match expected model'));
});

test('dispatch with questions — questions section present', () => {
  const taskDir = makeTempDir();
  writeManifest(taskDir, {
    slug: 'test-task',
    created: '2026-02-19T10:00:00.000Z',
    description: 'Build something',
    dispatches: [],
  });

  store.createDispatch(taskDir, makeEnvelope({
    dispatchId: '01JCTX0001',
    role: 'api-dev',
    status: 'completed',
    startedAt: '2026-02-19T10:00:00.000Z',
    completedAt: '2026-02-19T10:05:00.000Z',
    structuredResult: {
      status: 'partial',
      summary: 'Partially done',
      questions: ['What authentication method?', 'Should passwords expire?'],
    },
  }));

  const context = buildTaskContext(taskDir);
  assert.ok(context.includes('Questions:'));
  assert.ok(context.includes('- What authentication method?'));
  assert.ok(context.includes('- Should passwords expire?'));
});

test('dispatch with only summary (no changes/issues) — no empty sections', () => {
  const taskDir = makeTempDir();
  writeManifest(taskDir, {
    slug: 'test-task',
    created: '2026-02-19T10:00:00.000Z',
    description: 'Build something',
    dispatches: [],
  });

  store.createDispatch(taskDir, makeEnvelope({
    dispatchId: '01JCTX0001',
    role: 'api-dev',
    status: 'completed',
    startedAt: '2026-02-19T10:00:00.000Z',
    completedAt: '2026-02-19T10:05:00.000Z',
    structuredResult: {
      status: 'success',
      summary: 'All good, simple change',
    },
  }));

  const context = buildTaskContext(taskDir);
  assert.ok(context.includes('Summary: All good, simple change'));
  assert.ok(!context.includes('Changes:'));
  assert.ok(!context.includes('Issues:'));
  assert.ok(!context.includes('Questions:'));
});

test('falls back to task name when description is absent', () => {
  const taskDir = makeTempDir();
  writeManifest(taskDir, {
    slug: 'test-task',
    name: 'My Task Name',
    created: '2026-02-19T10:00:00.000Z',
    dispatches: [],
  });

  const context = buildTaskContext(taskDir);
  assert.ok(context.includes('My Task Name'));
});
