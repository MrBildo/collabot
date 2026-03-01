import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonFileDispatchStore } from './dispatch-store.js';
import type { DispatchEnvelope, CapturedEvent } from './types.js';

let tmpDir: string;
let taskDir: string;
let store: JsonFileDispatchStore;

function makeEnvelope(overrides?: Partial<DispatchEnvelope>): DispatchEnvelope {
  return {
    dispatchId: '01JTEST0001',
    taskSlug: 'test-task',
    role: 'ts-dev',
    model: 'claude-sonnet-4-6',
    cwd: '/projects/test',
    startedAt: '2026-03-01T10:00:00.000Z',
    status: 'running',
    ...overrides,
  };
}

function makeEvent(overrides?: Partial<CapturedEvent>): CapturedEvent {
  return {
    id: '01JEVT0001',
    type: 'agent:text',
    timestamp: '2026-03-01T10:00:01.000Z',
    data: { text: 'Hello world' },
    ...overrides,
  };
}

function writeTaskManifest(dir: string): void {
  const manifest = {
    slug: 'test-task',
    name: 'Test Task',
    project: 'test-project',
    status: 'open',
    created: '2026-03-01T09:00:00.000Z',
    dispatches: [],
  };
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

function readManifest(dir: string): { dispatches: Array<{ dispatchId: string; [key: string]: unknown }>;[key: string]: unknown } {
  return JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-store-test-'));
  taskDir = path.join(tmpDir, 'test-task');
  fs.mkdirSync(taskDir, { recursive: true });
  writeTaskManifest(taskDir);
  store = new JsonFileDispatchStore();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── createDispatch ──────────────────────────────────────────────

test('createDispatch creates dispatch file with correct envelope', () => {
  const envelope = makeEnvelope();
  store.createDispatch(taskDir, envelope);

  const filePath = path.join(taskDir, 'dispatches', `${envelope.dispatchId}.json`);
  assert.ok(fs.existsSync(filePath), 'dispatch file should exist');

  const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.strictEqual(content.dispatchId, envelope.dispatchId);
  assert.strictEqual(content.taskSlug, 'test-task');
  assert.strictEqual(content.role, 'ts-dev');
  assert.strictEqual(content.status, 'running');
  assert.deepStrictEqual(content.events, []);
});

test('createDispatch adds entry to task.json dispatch index', () => {
  const envelope = makeEnvelope();
  store.createDispatch(taskDir, envelope);

  const manifest = readManifest(taskDir);
  assert.strictEqual(manifest.dispatches.length, 1);
  assert.strictEqual(manifest.dispatches[0].dispatchId, envelope.dispatchId);
  assert.strictEqual(manifest.dispatches[0].role, 'ts-dev');
  assert.strictEqual(manifest.dispatches[0].status, 'running');
});

test('createDispatch creates dispatches/ directory if missing', () => {
  const dispatchDir = path.join(taskDir, 'dispatches');
  assert.ok(!fs.existsSync(dispatchDir), 'dispatches/ should not exist yet');

  store.createDispatch(taskDir, makeEnvelope());

  assert.ok(fs.existsSync(dispatchDir), 'dispatches/ should now exist');
});

// ── appendEvent ─────────────────────────────────────────────────

test('appendEvent adds event to dispatch file', () => {
  const envelope = makeEnvelope();
  store.createDispatch(taskDir, envelope);

  const event = makeEvent();
  store.appendEvent(taskDir, envelope.dispatchId, event);

  const filePath = path.join(taskDir, 'dispatches', `${envelope.dispatchId}.json`);
  const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.strictEqual(content.events.length, 1);
  assert.strictEqual(content.events[0].id, event.id);
  assert.strictEqual(content.events[0].type, 'agent:text');
});

test('appendEvent accumulates multiple events', () => {
  const envelope = makeEnvelope();
  store.createDispatch(taskDir, envelope);

  store.appendEvent(taskDir, envelope.dispatchId, makeEvent({ id: '01JEVT0001', type: 'agent:text' }));
  store.appendEvent(taskDir, envelope.dispatchId, makeEvent({ id: '01JEVT0002', type: 'agent:thinking' }));
  store.appendEvent(taskDir, envelope.dispatchId, makeEvent({ id: '01JEVT0003', type: 'agent:tool_call' }));

  const events = store.getDispatchEvents(taskDir, envelope.dispatchId);
  assert.strictEqual(events.length, 3);
  assert.strictEqual(events[0].id, '01JEVT0001');
  assert.strictEqual(events[1].id, '01JEVT0002');
  assert.strictEqual(events[2].id, '01JEVT0003');
});

test('appendEvent is a no-op for missing dispatch', () => {
  store.appendEvent(taskDir, 'nonexistent', makeEvent());
  // Should not throw, just silently ignore
});

// ── updateDispatch ──────────────────────────────────────────────

test('updateDispatch updates envelope fields', () => {
  const envelope = makeEnvelope();
  store.createDispatch(taskDir, envelope);

  store.updateDispatch(taskDir, envelope.dispatchId, {
    status: 'completed',
    completedAt: '2026-03-01T10:05:00.000Z',
    cost: 0.08,
  });

  const updated = store.getDispatchEnvelope(taskDir, envelope.dispatchId);
  assert.ok(updated);
  assert.strictEqual(updated.status, 'completed');
  assert.strictEqual(updated.completedAt, '2026-03-01T10:05:00.000Z');
  assert.strictEqual(updated.cost, 0.08);
  // Original fields preserved
  assert.strictEqual(updated.role, 'ts-dev');
  assert.strictEqual(updated.model, 'claude-sonnet-4-6');
});

test('updateDispatch preserves events', () => {
  const envelope = makeEnvelope();
  store.createDispatch(taskDir, envelope);
  store.appendEvent(taskDir, envelope.dispatchId, makeEvent());

  store.updateDispatch(taskDir, envelope.dispatchId, { status: 'completed' });

  const events = store.getDispatchEvents(taskDir, envelope.dispatchId);
  assert.strictEqual(events.length, 1);
});

test('updateDispatch updates task.json index entry', () => {
  const envelope = makeEnvelope();
  store.createDispatch(taskDir, envelope);

  store.updateDispatch(taskDir, envelope.dispatchId, {
    status: 'completed',
    cost: 0.12,
  });

  const manifest = readManifest(taskDir);
  assert.strictEqual(manifest.dispatches[0].status, 'completed');
  assert.strictEqual(manifest.dispatches[0].cost, 0.12);
});

test('updateDispatch cannot overwrite dispatchId', () => {
  const envelope = makeEnvelope();
  store.createDispatch(taskDir, envelope);

  store.updateDispatch(taskDir, envelope.dispatchId, {
    dispatchId: 'HIJACKED',
  } as Partial<DispatchEnvelope>);

  const result = store.getDispatchEnvelope(taskDir, envelope.dispatchId);
  assert.ok(result);
  assert.strictEqual(result.dispatchId, envelope.dispatchId);
});

test('updateDispatch is a no-op for missing dispatch', () => {
  store.updateDispatch(taskDir, 'nonexistent', { status: 'completed' });
  // Should not throw
});

// ── getDispatchEnvelopes ────────────────────────────────────────

test('getDispatchEnvelopes returns empty array when no dispatches', () => {
  const result = store.getDispatchEnvelopes(taskDir);
  assert.deepStrictEqual(result, []);
});

test('getDispatchEnvelopes returns all envelopes without events', () => {
  store.createDispatch(taskDir, makeEnvelope({ dispatchId: '01JTEST0001' }));
  store.createDispatch(taskDir, makeEnvelope({ dispatchId: '01JTEST0002', role: 'dotnet-dev' }));

  store.appendEvent(taskDir, '01JTEST0001', makeEvent());

  const envelopes = store.getDispatchEnvelopes(taskDir);
  assert.strictEqual(envelopes.length, 2);
  // Envelopes should not contain events
  for (const env of envelopes) {
    assert.strictEqual((env as unknown as Record<string, unknown>).events, undefined);
  }
});

// ── getDispatchEnvelope ─────────────────────────────────────────

test('getDispatchEnvelope returns null for missing dispatch', () => {
  assert.strictEqual(store.getDispatchEnvelope(taskDir, 'nonexistent'), null);
});

test('getDispatchEnvelope returns envelope without events', () => {
  store.createDispatch(taskDir, makeEnvelope());
  store.appendEvent(taskDir, '01JTEST0001', makeEvent());

  const envelope = store.getDispatchEnvelope(taskDir, '01JTEST0001');
  assert.ok(envelope);
  assert.strictEqual(envelope.dispatchId, '01JTEST0001');
  assert.strictEqual((envelope as unknown as Record<string, unknown>).events, undefined);
});

// ── getDispatchEvents ───────────────────────────────────────────

test('getDispatchEvents returns empty array for missing dispatch', () => {
  assert.deepStrictEqual(store.getDispatchEvents(taskDir, 'nonexistent'), []);
});

test('getDispatchEvents returns all events in order', () => {
  store.createDispatch(taskDir, makeEnvelope());

  const events = [
    makeEvent({ id: '01JEVT0001', type: 'session:init', timestamp: '2026-03-01T10:00:00.000Z' }),
    makeEvent({ id: '01JEVT0002', type: 'agent:text', timestamp: '2026-03-01T10:00:01.000Z' }),
    makeEvent({ id: '01JEVT0003', type: 'agent:tool_call', timestamp: '2026-03-01T10:00:02.000Z' }),
  ];
  for (const event of events) {
    store.appendEvent(taskDir, '01JTEST0001', event);
  }

  const result = store.getDispatchEvents(taskDir, '01JTEST0001');
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0].type, 'session:init');
  assert.strictEqual(result[1].type, 'agent:text');
  assert.strictEqual(result[2].type, 'agent:tool_call');
});

// ── getRecentEvents ─────────────────────────────────────────────

test('getRecentEvents returns last N events', () => {
  store.createDispatch(taskDir, makeEnvelope());

  for (let i = 1; i <= 5; i++) {
    store.appendEvent(taskDir, '01JTEST0001', makeEvent({
      id: `01JEVT000${i}`,
      type: 'agent:text',
      data: { text: `message ${i}` },
    }));
  }

  const recent = store.getRecentEvents(taskDir, '01JTEST0001', 2);
  assert.strictEqual(recent.length, 2);
  assert.deepStrictEqual(recent[0].data, { text: 'message 4' });
  assert.deepStrictEqual(recent[1].data, { text: 'message 5' });
});

test('getRecentEvents returns all events when count exceeds total', () => {
  store.createDispatch(taskDir, makeEnvelope());
  store.appendEvent(taskDir, '01JTEST0001', makeEvent());

  const recent = store.getRecentEvents(taskDir, '01JTEST0001', 10);
  assert.strictEqual(recent.length, 1);
});

test('getRecentEvents returns empty array for missing dispatch', () => {
  assert.deepStrictEqual(store.getRecentEvents(taskDir, 'nonexistent', 5), []);
});

// ── Multiple dispatches ─────────────────────────────────────────

test('multiple dispatches maintain separate event streams', () => {
  store.createDispatch(taskDir, makeEnvelope({ dispatchId: '01JTEST0001' }));
  store.createDispatch(taskDir, makeEnvelope({ dispatchId: '01JTEST0002', role: 'dotnet-dev' }));

  store.appendEvent(taskDir, '01JTEST0001', makeEvent({ id: '01JEVT0001', data: { text: 'from ts-dev' } }));
  store.appendEvent(taskDir, '01JTEST0002', makeEvent({ id: '01JEVT0002', data: { text: 'from dotnet-dev' } }));
  store.appendEvent(taskDir, '01JTEST0001', makeEvent({ id: '01JEVT0003', data: { text: 'from ts-dev again' } }));

  assert.strictEqual(store.getDispatchEvents(taskDir, '01JTEST0001').length, 2);
  assert.strictEqual(store.getDispatchEvents(taskDir, '01JTEST0002').length, 1);
});

test('task.json index tracks all dispatches', () => {
  store.createDispatch(taskDir, makeEnvelope({ dispatchId: '01JTEST0001' }));
  store.createDispatch(taskDir, makeEnvelope({ dispatchId: '01JTEST0002', role: 'dotnet-dev' }));

  const manifest = readManifest(taskDir);
  assert.strictEqual(manifest.dispatches.length, 2);
  assert.strictEqual(manifest.dispatches[0].dispatchId, '01JTEST0001');
  assert.strictEqual(manifest.dispatches[1].dispatchId, '01JTEST0002');
});

// ── Parent-child relationships ──────────────────────────────────

test('parentDispatchId is stored in envelope and index', () => {
  store.createDispatch(taskDir, makeEnvelope({ dispatchId: '01JPARENT' }));
  store.createDispatch(taskDir, makeEnvelope({
    dispatchId: '01JCHILD1',
    role: 'ts-dev',
    parentDispatchId: '01JPARENT',
  }));

  const envelope = store.getDispatchEnvelope(taskDir, '01JCHILD1');
  assert.ok(envelope);
  assert.strictEqual(envelope.parentDispatchId, '01JPARENT');

  const manifest = readManifest(taskDir);
  const childEntry = manifest.dispatches.find((d) => d.dispatchId === '01JCHILD1');
  assert.ok(childEntry);
  assert.strictEqual(childEntry.parentDispatchId, '01JPARENT');
});

// ── Corrupt/missing file handling ───────────────────────────────

test('graceful handling when dispatches/ directory does not exist', () => {
  assert.deepStrictEqual(store.getDispatchEnvelopes(taskDir), []);
  assert.strictEqual(store.getDispatchEnvelope(taskDir, 'any'), null);
  assert.deepStrictEqual(store.getDispatchEvents(taskDir, 'any'), []);
});

test('graceful handling when task.json is missing', () => {
  fs.unlinkSync(path.join(taskDir, 'task.json'));

  // createDispatch should still create the dispatch file
  store.createDispatch(taskDir, makeEnvelope());

  const filePath = path.join(taskDir, 'dispatches', '01JTEST0001.json');
  assert.ok(fs.existsSync(filePath), 'dispatch file should exist even without task.json');
});

test('corrupt dispatch file is skipped in getDispatchEnvelopes', () => {
  store.createDispatch(taskDir, makeEnvelope({ dispatchId: '01JGOOD' }));

  // Write corrupt file
  const dir = path.join(taskDir, 'dispatches');
  fs.writeFileSync(path.join(dir, '01JBAD.json'), 'not valid json', 'utf8');

  const envelopes = store.getDispatchEnvelopes(taskDir);
  assert.strictEqual(envelopes.length, 1);
  assert.strictEqual(envelopes[0].dispatchId, '01JGOOD');
});

// ── structuredResult caching ────────────────────────────────────

test('updateDispatch stores structuredResult on envelope', () => {
  store.createDispatch(taskDir, makeEnvelope());

  store.updateDispatch(taskDir, '01JTEST0001', {
    status: 'completed',
    structuredResult: {
      status: 'success',
      summary: 'All done',
      changes: ['src/foo.ts'],
    },
  });

  const envelope = store.getDispatchEnvelope(taskDir, '01JTEST0001');
  assert.ok(envelope);
  assert.ok(envelope.structuredResult);
  assert.strictEqual(envelope.structuredResult.status, 'success');
  assert.strictEqual(envelope.structuredResult.summary, 'All done');
});
