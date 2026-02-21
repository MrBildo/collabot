import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Debouncer } from './debounce.js';

test('single item flushes after delay', async () => {
  const debouncer = new Debouncer<string>(50);
  const flushed: { items: string[]; metadata?: Record<string, unknown> }[] = [];

  debouncer.debounce('key1', 'hello', (items, metadata) => {
    flushed.push({ items, metadata });
  });

  assert.strictEqual(flushed.length, 0);
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(flushed.length, 1);
  assert.deepStrictEqual(flushed[0]?.items, ['hello']);
});

test('multiple items accumulate and flush together', async () => {
  const debouncer = new Debouncer<string>(50);
  const flushed: { items: string[]; metadata?: Record<string, unknown> }[] = [];

  const flush = (items: string[], metadata?: Record<string, unknown>) => {
    flushed.push({ items, metadata });
  };

  debouncer.debounce('key1', 'one', flush, { first: true });
  await new Promise((r) => setTimeout(r, 20));
  debouncer.debounce('key1', 'two', flush);
  await new Promise((r) => setTimeout(r, 20));
  debouncer.debounce('key1', 'three', flush);

  assert.strictEqual(flushed.length, 0);
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(flushed.length, 1);
  assert.deepStrictEqual(flushed[0]?.items, ['one', 'two', 'three']);
  // Metadata from first call is preserved
  assert.deepStrictEqual(flushed[0]?.metadata, { first: true });
});

test('different keys are independent', async () => {
  const debouncer = new Debouncer<string>(50);
  const flushed: { key: string; items: string[] }[] = [];

  debouncer.debounce('a', 'a1', (items) => { flushed.push({ key: 'a', items }); });
  debouncer.debounce('b', 'b1', (items) => { flushed.push({ key: 'b', items }); });

  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(flushed.length, 2);
  const aFlush = flushed.find((f) => f.key === 'a');
  const bFlush = flushed.find((f) => f.key === 'b');
  assert.deepStrictEqual(aFlush?.items, ['a1']);
  assert.deepStrictEqual(bFlush?.items, ['b1']);
});

test('timer resets on new item', async () => {
  const debouncer = new Debouncer<string>(60);
  const flushed: string[][] = [];

  const flush = (items: string[]) => { flushed.push(items); };

  debouncer.debounce('key1', 'first', flush);
  await new Promise((r) => setTimeout(r, 40));
  // Timer hasn't fired yet, add another item (resets timer)
  debouncer.debounce('key1', 'second', flush);
  await new Promise((r) => setTimeout(r, 40));
  // Still hasn't fired (only 40ms since reset)
  assert.strictEqual(flushed.length, 0);
  await new Promise((r) => setTimeout(r, 40));
  // Now it should have fired (80ms since last reset)
  assert.strictEqual(flushed.length, 1);
  assert.deepStrictEqual(flushed[0], ['first', 'second']);
});

test('has() returns true for pending key', () => {
  const debouncer = new Debouncer<string>(1000);
  assert.strictEqual(debouncer.has('key1'), false);
  debouncer.debounce('key1', 'item', () => {});
  assert.strictEqual(debouncer.has('key1'), true);
});
