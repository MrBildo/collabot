import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectErrorLoop, detectNonRetryable } from './monitor.js';
import type { ToolCall, ErrorTriplet } from './types.js';

function call(tool: string, target: string): ToolCall {
  return { tool, target, timestamp: Date.now() };
}

// ── Generic repeat detection ───────────────────────────────────

test('empty window returns null', () => {
  assert.strictEqual(detectErrorLoop([]), null);
});

test('all different tools returns null', () => {
  const window = [
    call('Bash', 'dotnet build'),
    call('Edit', 'src/Foo.cs'),
    call('Read', 'src/Bar.cs'),
    call('Grep', 'IFooService'),
  ];
  assert.strictEqual(detectErrorLoop(window), null);
});

test('2 repetitions returns null (below warning threshold)', () => {
  const window = [
    call('Bash', 'dotnet build'),
    call('Bash', 'dotnet build'),
  ];
  assert.strictEqual(detectErrorLoop(window), null);
});

test('3 repetitions returns warning with type genericRepeat', () => {
  const window = [
    call('Bash', 'dotnet build'),
    call('Bash', 'dotnet build'),
    call('Bash', 'dotnet build'),
  ];
  const result = detectErrorLoop(window);
  assert.ok(result !== null);
  assert.strictEqual(result.type, 'genericRepeat');
  assert.strictEqual(result.severity, 'warning');
  assert.strictEqual(result.pattern, 'Bash::dotnet build');
  assert.strictEqual(result.count, 3);
});

test('5 repetitions returns kill with type genericRepeat', () => {
  const window = [
    call('Edit', 'src/Models/Thing.cs'),
    call('Edit', 'src/Models/Thing.cs'),
    call('Edit', 'src/Models/Thing.cs'),
    call('Edit', 'src/Models/Thing.cs'),
    call('Edit', 'src/Models/Thing.cs'),
  ];
  const result = detectErrorLoop(window);
  assert.ok(result !== null);
  assert.strictEqual(result.type, 'genericRepeat');
  assert.strictEqual(result.severity, 'kill');
  assert.strictEqual(result.pattern, 'Edit::src/Models/Thing.cs');
  assert.strictEqual(result.count, 5);
});

test('mixed tools with one looping detects the loop and ignores others', () => {
  const window = [
    call('Read', 'src/Foo.cs'),
    call('Bash', 'dotnet build'),
    call('Bash', 'dotnet build'),
    call('Read', 'src/Bar.cs'),
    call('Bash', 'dotnet build'),
  ];
  const result = detectErrorLoop(window);
  assert.ok(result !== null);
  assert.strictEqual(result.type, 'genericRepeat');
  assert.strictEqual(result.pattern, 'Bash::dotnet build');
  assert.strictEqual(result.count, 3);
  assert.strictEqual(result.severity, 'warning');
});

test('alternating loop detects when either pair hits 3+', () => {
  // Edit::foo.cs × 3, Bash::dotnet build × 3 — alternating
  const window = [
    call('Edit', 'foo.cs'),
    call('Bash', 'dotnet build'),
    call('Edit', 'foo.cs'),
    call('Bash', 'dotnet build'),
    call('Edit', 'foo.cs'),
    call('Bash', 'dotnet build'),
  ];
  const result = detectErrorLoop(window);
  assert.ok(result !== null);
  // Either genericRepeat (each pattern hits 3) or pingPong (alternating 3 times)
  assert.ok(result.count >= 3);
  assert.ok(result.severity === 'warning' || result.severity === 'kill');
});

test('different targets on same tool are distinct patterns — no loop', () => {
  const window = [
    call('Bash', 'dotnet build'),
    call('Bash', 'dotnet test'),
    call('Bash', 'dotnet build'),
    call('Bash', 'dotnet test'),
  ];
  // Each pattern appears only 2 times — below genericRepeat threshold
  // Only 2 alternations — below pingPong threshold
  assert.strictEqual(detectErrorLoop(window), null);
});

test('tool with empty target uses tool name as key', () => {
  // Grep with no extractable target — key is just "Grep"
  const window = [
    call('Grep', ''),
    call('Grep', ''),
    call('Grep', ''),
  ];
  const result = detectErrorLoop(window);
  assert.ok(result !== null);
  assert.strictEqual(result.type, 'genericRepeat');
  assert.strictEqual(result.pattern, 'Grep');
  assert.strictEqual(result.count, 3);
  assert.strictEqual(result.severity, 'warning');
});

// ── Ping-pong detection ────────────────────────────────────────

test('pingPong: A→B→A→B→A→B (6 calls) → warning', () => {
  const window = [
    call('Read', 'foo.ts'),
    call('Edit', 'foo.ts'),
    call('Read', 'foo.ts'),
    call('Edit', 'foo.ts'),
    call('Read', 'foo.ts'),
    call('Edit', 'foo.ts'),
  ];
  const result = detectErrorLoop(window);
  assert.ok(result !== null);
  // genericRepeat also triggers at 3, so either type is fine
  // The important thing is that it's detected
  assert.ok(result.severity === 'warning' || result.severity === 'kill');
});

test('pingPong: A→B→A→B→A→B→A→B (8 calls) with unique targets → kill', () => {
  // Use targets that are different enough to not trigger genericRepeat at 5+
  // but still alternate perfectly
  const window = [
    call('Read', 'src/models/User.cs'),
    call('Bash', 'dotnet build --no-restore'),
    call('Read', 'src/models/User.cs'),
    call('Bash', 'dotnet build --no-restore'),
    call('Read', 'src/models/User.cs'),
    call('Bash', 'dotnet build --no-restore'),
    call('Read', 'src/models/User.cs'),
    call('Bash', 'dotnet build --no-restore'),
  ];
  const result = detectErrorLoop(window);
  assert.ok(result !== null);
  // With 4 of each, genericRepeat doesn't hit kill (needs 5).
  // But pingPong with 4 alternations should be kill.
  assert.strictEqual(result.severity, 'kill');
});

test('pingPong: A→B→A→C (broken alternation) → null', () => {
  const window = [
    call('Read', 'foo.ts'),
    call('Edit', 'foo.ts'),
    call('Read', 'foo.ts'),
    call('Edit', 'bar.ts'),  // different target breaks alternation
  ];
  assert.strictEqual(detectErrorLoop(window), null);
});

test('pingPong: A→A→A not caught as pingPong (caught by genericRepeat)', () => {
  const window = [
    call('Bash', 'dotnet build'),
    call('Bash', 'dotnet build'),
    call('Bash', 'dotnet build'),
  ];
  const result = detectErrorLoop(window);
  assert.ok(result !== null);
  assert.strictEqual(result.type, 'genericRepeat');
});

// ── Non-retryable error detection ──────────────────────────────

function triplet(tool: string, target: string, errorSnippet: string): ErrorTriplet {
  return { tool, target, errorSnippet, timestamp: Date.now() };
}

test('nonRetryable: same triplet once → null', () => {
  assert.strictEqual(
    detectNonRetryable([triplet('Bash', 'dotnet build', 'CS1234: missing semicolon')]),
    null,
  );
});

test('nonRetryable: same triplet twice → detection', () => {
  const errors = [
    triplet('Bash', 'dotnet build', 'CS1234: missing semicolon'),
    triplet('Bash', 'dotnet build', 'CS1234: missing semicolon'),
  ];
  const result = detectNonRetryable(errors);
  assert.ok(result !== null);
  assert.strictEqual(result.tool, 'Bash');
  assert.strictEqual(result.target, 'dotnet build');
  assert.strictEqual(result.count, 2);
});

test('nonRetryable: different errors for same tool+target → null', () => {
  const errors = [
    triplet('Bash', 'dotnet build', 'CS1234: missing semicolon'),
    triplet('Bash', 'dotnet build', 'CS5678: type mismatch'),
  ];
  assert.strictEqual(detectNonRetryable(errors), null);
});

test('nonRetryable: same error, different tools → null', () => {
  const errors = [
    triplet('Bash', 'dotnet build', 'CS1234: missing semicolon'),
    triplet('Edit', 'dotnet build', 'CS1234: missing semicolon'),
  ];
  assert.strictEqual(detectNonRetryable(errors), null);
});
