import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BotMessageQueue } from './bot-queue.js';

function makeMsg(botName: string, content: string) {
  return { botName, content, metadata: {} };
}

test('BotMessageQueue processes message immediately when not busy', async () => {
  const queue = new BotMessageQueue();
  const processed: string[] = [];

  queue.setHandler(async (msg) => {
    processed.push(msg.content);
  });

  queue.enqueue(makeMsg('hazel', 'hello'));

  // Allow async processing to complete
  await new Promise((r) => setTimeout(r, 10));

  assert.deepStrictEqual(processed, ['hello']);
  assert.strictEqual(queue.isBusy('hazel'), false);
});

test('BotMessageQueue assigns id and enqueuedAt', async () => {
  const queue = new BotMessageQueue();
  let received: { id: string; enqueuedAt: string } | undefined;

  queue.setHandler(async (msg) => {
    received = msg;
  });

  queue.enqueue(makeMsg('hazel', 'test'));
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(received);
  assert.ok(received!.id.length === 26, 'id should be a ULID (26 chars)');
  assert.ok(received!.enqueuedAt);
});

test('BotMessageQueue queues messages when bot is busy (FIFO)', async () => {
  const queue = new BotMessageQueue();
  const processed: string[] = [];

  queue.setHandler(async (msg) => {
    await new Promise((r) => setTimeout(r, 30));
    processed.push(msg.content);
  });

  queue.enqueue(makeMsg('hazel', 'first'));
  queue.enqueue(makeMsg('hazel', 'second'));
  queue.enqueue(makeMsg('hazel', 'third'));

  assert.strictEqual(queue.isBusy('hazel'), true);
  assert.strictEqual(queue.queueDepth('hazel'), 2);

  // Wait for all to process
  await new Promise((r) => setTimeout(r, 150));

  assert.deepStrictEqual(processed, ['first', 'second', 'third']);
  assert.strictEqual(queue.isBusy('hazel'), false);
  assert.strictEqual(queue.queueDepth('hazel'), 0);
});

test('BotMessageQueue isolates per-bot queues', async () => {
  const queue = new BotMessageQueue();
  const processed: string[] = [];

  queue.setHandler(async (msg) => {
    await new Promise((r) => setTimeout(r, 20));
    processed.push(`${msg.botName}:${msg.content}`);
  });

  queue.enqueue(makeMsg('hazel', 'h1'));
  queue.enqueue(makeMsg('greg', 'g1'));

  // Both should start immediately (different bots)
  assert.strictEqual(queue.isBusy('hazel'), true);
  assert.strictEqual(queue.isBusy('greg'), true);

  await new Promise((r) => setTimeout(r, 50));

  assert.ok(processed.includes('hazel:h1'));
  assert.ok(processed.includes('greg:g1'));
});

test('BotMessageQueue handles handler errors gracefully', async () => {
  const queue = new BotMessageQueue();
  const processed: string[] = [];
  let callCount = 0;

  queue.setHandler(async (msg) => {
    callCount++;
    if (callCount === 1) throw new Error('boom');
    processed.push(msg.content);
  });

  queue.enqueue(makeMsg('hazel', 'will-fail'));
  queue.enqueue(makeMsg('hazel', 'will-succeed'));

  await new Promise((r) => setTimeout(r, 50));

  // Second message should still process despite first error
  assert.deepStrictEqual(processed, ['will-succeed']);
  assert.strictEqual(queue.isBusy('hazel'), false);
});

test('BotMessageQueue drops messages when no handler set', async () => {
  const queue = new BotMessageQueue();

  // Should not throw
  queue.enqueue(makeMsg('hazel', 'dropped'));

  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(queue.isBusy('hazel'), false);
});

test('BotMessageQueue reports correct queueDepth', () => {
  const queue = new BotMessageQueue();

  // Block processing by making handler slow
  queue.setHandler(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });

  assert.strictEqual(queue.queueDepth('hazel'), 0);

  queue.enqueue(makeMsg('hazel', 'a'));
  assert.strictEqual(queue.queueDepth('hazel'), 0); // first processes immediately

  queue.enqueue(makeMsg('hazel', 'b'));
  assert.strictEqual(queue.queueDepth('hazel'), 1);

  queue.enqueue(makeMsg('hazel', 'c'));
  assert.strictEqual(queue.queueDepth('hazel'), 2);
});
