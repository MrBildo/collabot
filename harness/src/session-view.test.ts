import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { renderSessionView } from './session-view.js';
import { JsonFileDispatchStore } from './dispatch-store.js';
import type { DispatchEnvelope, CapturedEvent } from './types.js';

const store = new JsonFileDispatchStore();
const tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-view-test-'));
  const taskDir = path.join(dir, 'test-task');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({
    slug: 'test-task',
    name: 'Test Task',
    project: 'test-project',
    status: 'open',
    created: '2026-03-01T09:00:00.000Z',
    dispatches: [],
  }, null, 2) + '\n', 'utf8');
  tmpDirs.push(dir);
  return taskDir;
}

function makeEnvelope(overrides?: Partial<DispatchEnvelope>): DispatchEnvelope {
  return {
    dispatchId: '01JSVIEW001',
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

afterEach(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
});

// ── Basic rendering ─────────────────────────────────────────────

test('returns null for missing dispatch', () => {
  const taskDir = makeTempDir();
  const result = renderSessionView(taskDir, 'nonexistent');
  assert.strictEqual(result, null);
});

test('renders header with role, dispatchId, model, and start time', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope({
    dispatchId: '01JSVIEW001',
    role: 'ts-dev',
    model: 'claude-sonnet-4-6',
    startedAt: '2026-03-01T10:00:00.000Z',
  }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  assert.ok(view.includes('## Session: ts-dev (01JSVIEW001)'));
  assert.ok(view.includes('Model: claude-sonnet-4-6'));
  assert.ok(view.includes('Started: 10:00:00'));
});

test('renders cost in header when available', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope({ cost: 0.08 }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  assert.ok(view.includes('Cost: $0.08'));
});

test('empty dispatch (no events) — renders header only', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope());

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  assert.ok(view.includes('## Session: ts-dev'));
  // Should have header but no event lines beyond the blank line
  const lines = view.split('\n').filter((l) => l.trim() !== '');
  assert.strictEqual(lines.length, 2); // header + model line
});

// ── Event type rendering ────────────────────────────────────────

test('renders agent:text event', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope());
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    type: 'agent:text',
    timestamp: '2026-03-01T10:00:01.000Z',
    data: { text: 'I will analyze the code' },
  }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  assert.ok(view.includes('10:00:01 [text] I will analyze the code'));
});

test('renders agent:thinking event', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope());
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    type: 'agent:thinking',
    timestamp: '2026-03-01T10:00:01.000Z',
    data: { text: 'Let me think about this...' },
  }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  assert.ok(view.includes('10:00:01 [thinking] Let me think about this...'));
});

test('renders agent:tool_call event', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope());
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    type: 'agent:tool_call',
    timestamp: '2026-03-01T10:00:05.000Z',
    data: { tool: 'Read', target: 'src/router.ts', toolCallId: 'tc001' },
  }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  assert.ok(view.includes('10:00:05 [tool] Read src/router.ts'));
});

test('renders agent:tool_result event', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope());
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    type: 'agent:tool_result',
    timestamp: '2026-03-01T10:00:06.000Z',
    data: { tool: 'Read', status: 'completed', durationMs: 45, toolCallId: 'tc001' },
  }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  assert.ok(view.includes('10:00:06 [result] Read completed (45ms)'));
});

test('renders session:init event', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope());
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    type: 'session:init',
    timestamp: '2026-03-01T10:00:00.000Z',
    data: {},
  }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  assert.ok(view.includes('10:00:00 [init] Session initialized'));
});

test('renders session:complete event', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope());
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    type: 'session:complete',
    timestamp: '2026-03-01T10:02:33.000Z',
    data: { status: 'Success', cost: 0.08, inputTokens: 45000, outputTokens: 3200, numTurns: 8 },
  }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  assert.ok(view.includes('10:02:33 [complete] Success'));
  assert.ok(view.includes('$0.08'));
  assert.ok(view.includes('45.0K input'));
  assert.ok(view.includes('3.2K output'));
  assert.ok(view.includes('8 turns'));
});

test('renders session:compaction event', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope());
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    type: 'session:compaction',
    timestamp: '2026-03-01T10:01:30.000Z',
  }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  assert.ok(view.includes('10:01:30 [compaction] Context compacted'));
});

test('renders harness:loop_warning event', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope());
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    type: 'harness:loop_warning',
    timestamp: '2026-03-01T10:01:00.000Z',
    data: { pattern: 'Read::foo.ts repeated 5x' },
  }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  assert.ok(view.includes('10:01:00 [loop_warning] Read::foo.ts repeated 5x'));
});

test('renders harness:loop_kill event', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope());
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    type: 'harness:loop_kill',
    timestamp: '2026-03-01T10:01:30.000Z',
    data: { pattern: 'Read::foo.ts ↔ Edit::foo.ts' },
  }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  assert.ok(view.includes('[loop_kill]'));
});

test('renders harness:stall event', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope());
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    type: 'harness:stall',
    timestamp: '2026-03-01T10:02:00.000Z',
  }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  assert.ok(view.includes('[stall] Inactivity timeout'));
});

test('renders harness:abort event', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope());
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    type: 'harness:abort',
    timestamp: '2026-03-01T10:02:00.000Z',
  }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  assert.ok(view.includes('[abort] Agent aborted'));
});

test('renders harness:error event', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope());
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    type: 'harness:error',
    timestamp: '2026-03-01T10:02:00.000Z',
    data: { message: 'Unexpected SDK failure' },
  }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  assert.ok(view.includes('[error] Unexpected SDK failure'));
});

test('renders user:message event', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope());
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    type: 'user:message',
    timestamp: '2026-03-01T10:01:00.000Z',
    data: { text: 'Can you also fix the tests?' },
  }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  assert.ok(view.includes('[user] Can you also fix the tests?'));
});

test('renders system:files_persisted event', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope());
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    type: 'system:files_persisted',
    timestamp: '2026-03-01T10:01:00.000Z',
  }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  assert.ok(view.includes('[system] Files persisted'));
});

test('renders session:rate_limit event', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope());
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    type: 'session:rate_limit',
    timestamp: '2026-03-01T10:01:00.000Z',
  }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  assert.ok(view.includes('[rate_limit] Rate limited'));
});

test('renders session:status event', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope());
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    type: 'session:status',
    timestamp: '2026-03-01T10:01:00.000Z',
    data: { status: 'Agent is working' },
  }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  assert.ok(view.includes('[status] Agent is working'));
});

// ── Chronological ordering ──────────────────────────────────────

test('events rendered in chronological order', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope());

  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    id: '01JEVT0001',
    type: 'session:init',
    timestamp: '2026-03-01T10:00:00.000Z',
  }));
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    id: '01JEVT0002',
    type: 'agent:thinking',
    timestamp: '2026-03-01T10:00:01.000Z',
    data: { text: 'Let me think...' },
  }));
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    id: '01JEVT0003',
    type: 'agent:tool_call',
    timestamp: '2026-03-01T10:00:05.000Z',
    data: { tool: 'Read', target: 'src/index.ts' },
  }));
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    id: '01JEVT0004',
    type: 'agent:text',
    timestamp: '2026-03-01T10:00:06.000Z',
    data: { text: 'Here is the analysis' },
  }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  const lines = view.split('\n').filter((l) => l.match(/^\d{2}:\d{2}:\d{2}/));
  assert.strictEqual(lines.length, 4);
  assert.ok(lines[0].includes('[init]'));
  assert.ok(lines[1].includes('[thinking]'));
  assert.ok(lines[2].includes('[tool]'));
  assert.ok(lines[3].includes('[text]'));
});

// ── Text truncation ─────────────────────────────────────────────

test('long text is truncated', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope());
  const longText = 'A'.repeat(200);
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    type: 'agent:text',
    data: { text: longText },
  }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  assert.ok(view.includes('...'));
  // The truncated line should be shorter than the full text
  const textLine = view.split('\n').find((l) => l.includes('[text]'))!;
  assert.ok(textLine.length < 200);
});

test('multiline text is collapsed to single line', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope());
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    type: 'agent:text',
    data: { text: 'Line 1\nLine 2\nLine 3' },
  }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  const textLine = view.split('\n').find((l) => l.includes('[text]'))!;
  assert.ok(textLine.includes('Line 1 Line 2 Line 3'));
});

// ── Token formatting ────────────────────────────────────────────

test('tokens under 1000 shown as raw number', () => {
  const taskDir = makeTempDir();
  store.createDispatch(taskDir, makeEnvelope());
  store.appendEvent(taskDir, '01JSVIEW001', makeEvent({
    type: 'session:complete',
    timestamp: '2026-03-01T10:02:33.000Z',
    data: { status: 'Success', inputTokens: 500, outputTokens: 200 },
  }));

  const view = renderSessionView(taskDir, '01JSVIEW001')!;
  assert.ok(view.includes('500 input'));
  assert.ok(view.includes('200 output'));
});
