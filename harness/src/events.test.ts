import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getEventStore, makeEvent, renderJournalView } from './events.js';
import type { EventLog, CapturedEvent } from './types.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'events-test-'));
}

// --- makeEvent ---

test('makeEvent creates event with timestamp and type', () => {
  const event = makeEvent('dispatch_start', { role: 'ts-dev', model: 'claude-sonnet-4-6' });
  assert.strictEqual(event.type, 'dispatch_start');
  assert.ok(event.timestamp); // RFC 3339
  assert.strictEqual(event.data?.role, 'ts-dev');
  assert.strictEqual(event.data?.model, 'claude-sonnet-4-6');
});

test('makeEvent without data omits data field', () => {
  const event = makeEvent('stall');
  assert.strictEqual(event.type, 'stall');
  assert.strictEqual(event.data, undefined);
});

// --- EventStore: append + read ---

test('append creates events.json and read returns log', () => {
  const dir = tmpDir();
  const store = getEventStore();
  const event = makeEvent('dispatch_start', { role: 'ts-dev' });

  store.append(dir, 'ts-dev', 'my-task', event);

  const log = store.read(dir);
  assert.ok(log);
  assert.strictEqual(log.taskSlug, 'my-task');
  assert.strictEqual(log.role, 'ts-dev');
  assert.strictEqual(log.startedAt, event.timestamp);
  assert.strictEqual(log.events.length, 1);
  assert.deepStrictEqual(log.events[0], event);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('append accumulates events in order', () => {
  const dir = tmpDir();
  const store = getEventStore();

  store.append(dir, 'ts-dev', 'task-a', makeEvent('dispatch_start'));
  store.append(dir, 'ts-dev', 'task-a', makeEvent('text', { text: 'hello' }));
  store.append(dir, 'ts-dev', 'task-a', makeEvent('tool_use', { tool: 'Bash', target: 'npm test' }));
  store.append(dir, 'ts-dev', 'task-a', makeEvent('dispatch_end', { status: 'completed' }));

  const log = store.read(dir);
  assert.ok(log);
  assert.strictEqual(log.events.length, 4);
  assert.strictEqual(log.events[0].type, 'dispatch_start');
  assert.strictEqual(log.events[1].type, 'text');
  assert.strictEqual(log.events[2].type, 'tool_use');
  assert.strictEqual(log.events[3].type, 'dispatch_end');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('append creates task directory if it does not exist', () => {
  const base = tmpDir();
  const dir = path.join(base, 'nested', 'task-dir');
  const store = getEventStore();

  store.append(dir, 'ts-dev', 'nested-task', makeEvent('dispatch_start'));

  assert.ok(fs.existsSync(path.join(dir, 'events.json')));

  fs.rmSync(base, { recursive: true, force: true });
});

test('read returns null for non-existent directory', () => {
  const store = getEventStore();
  const result = store.read('/tmp/does-not-exist-' + Date.now());
  assert.strictEqual(result, null);
});

// --- renderJournalView ---

test('renderJournalView renders all event types', () => {
  const log: EventLog = {
    taskSlug: 'test-task',
    role: 'ts-dev',
    startedAt: '2026-02-26T14:30:00.000Z',
    events: [
      { type: 'dispatch_start', timestamp: '2026-02-26T14:30:00.000Z', data: { role: 'ts-dev', model: 'sonnet' } },
      { type: 'text', timestamp: '2026-02-26T14:30:05.000Z', data: { text: 'Working on it' } },
      { type: 'thinking', timestamp: '2026-02-26T14:30:06.000Z', data: { text: 'Let me think...' } },
      { type: 'tool_use', timestamp: '2026-02-26T14:30:10.000Z', data: { tool: 'Bash', target: 'npm test' } },
      { type: 'compaction', timestamp: '2026-02-26T14:30:15.000Z', data: { trigger: 'auto' } },
      { type: 'loop_warning', timestamp: '2026-02-26T14:30:20.000Z', data: { pattern: 'Bash::npm test', count: 3 } },
      { type: 'loop_kill', timestamp: '2026-02-26T14:30:25.000Z', data: { pattern: 'Bash::npm test', count: 5 } },
      { type: 'stall', timestamp: '2026-02-26T14:30:30.000Z' },
      { type: 'abort', timestamp: '2026-02-26T14:30:35.000Z', data: { reason: 'user request' } },
      { type: 'error', timestamp: '2026-02-26T14:30:40.000Z', data: { message: 'Something went wrong' } },
      { type: 'dispatch_end', timestamp: '2026-02-26T14:30:45.000Z', data: { status: 'completed' } },
    ] as CapturedEvent[],
  };

  const view = renderJournalView(log);

  assert.ok(view.includes('# Events: test-task'));
  assert.ok(view.includes('Role: ts-dev'));
  assert.ok(view.includes('Started: 2026-02-26T14:30:00.000Z'));
  assert.ok(view.includes('Agent dispatched (ts-dev, sonnet)'));
  assert.ok(view.includes('[agent] Working on it'));
  assert.ok(view.includes('[thinking] Let me think...'));
  assert.ok(view.includes('tool_use: Bash npm test'));
  assert.ok(view.includes('Context compacted'));
  assert.ok(view.includes('Loop warning: Bash::npm test (3x)'));
  assert.ok(view.includes('Agent killed: error loop (Bash::npm test, 5x)'));
  assert.ok(view.includes('Agent stalled'));
  assert.ok(view.includes('Agent aborted: user request'));
  assert.ok(view.includes('Error: Something went wrong'));
  assert.ok(view.includes('Agent completed'));
});

test('renderJournalView handles unknown event type gracefully', () => {
  const log: EventLog = {
    taskSlug: 'test-task',
    role: 'ts-dev',
    startedAt: '2026-02-26T14:30:00.000Z',
    events: [
      { type: 'some_future_type' as any, timestamp: '2026-02-26T14:30:00.000Z' },
    ],
  };

  const view = renderJournalView(log);
  assert.ok(view.includes('[some_future_type]'));
});
