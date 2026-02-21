import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { WsAdapter } from './ws.js';
import type { ChannelMessage } from '../comms.js';

function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

function makeChannelMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: 'msg-1',
    channelId: 'chan-1',
    from: 'harness',
    timestamp: new Date('2026-02-20T12:00:00.000Z'),
    type: 'lifecycle',
    content: 'test message',
    ...overrides,
  };
}

test('WsAdapter starts and accepts connections', async () => {
  const adapter = new WsAdapter({ port: 0, host: '127.0.0.1' });
  await adapter.start();

  const client = await connectClient(adapter.port);
  assert.strictEqual(client.readyState, WebSocket.OPEN);

  client.terminate();
  await adapter.stop();
});

test('send() broadcasts channel_message notification to all connected clients', async () => {
  const adapter = new WsAdapter({ port: 0, host: '127.0.0.1' });
  await adapter.start();

  const client1 = await connectClient(adapter.port);
  const client2 = await connectClient(adapter.port);

  const p1 = nextMessage(client1);
  const p2 = nextMessage(client2);

  await adapter.send(makeChannelMessage({ content: 'hello ws' }));

  const [msg1, msg2] = await Promise.all([p1, p2]) as [any, any];

  assert.strictEqual(msg1.jsonrpc, '2.0');
  assert.strictEqual(msg1.method, 'channel_message');
  assert.strictEqual(msg1.params.content, 'hello ws');
  assert.strictEqual(msg1.params.channelId, 'chan-1');
  assert.strictEqual(msg1.params.timestamp, '2026-02-20T12:00:00.000Z');

  assert.strictEqual(msg2.method, 'channel_message');
  assert.strictEqual(msg2.params.content, 'hello ws');

  client1.terminate();
  client2.terminate();
  await adapter.stop();
});

test('setStatus() broadcasts status_update notification', async () => {
  const adapter = new WsAdapter({ port: 0, host: '127.0.0.1' });
  await adapter.start();

  const client = await connectClient(adapter.port);
  const p = nextMessage(client);

  await adapter.setStatus('chan-1', 'working');

  const msg = await p as any;

  assert.strictEqual(msg.jsonrpc, '2.0');
  assert.strictEqual(msg.method, 'status_update');
  assert.strictEqual(msg.params.channelId, 'chan-1');
  assert.strictEqual(msg.params.status, 'working');

  client.terminate();
  await adapter.stop();
});

test('broadcastNotification() sends to all clients and survives one bad client', async () => {
  const adapter = new WsAdapter({ port: 0, host: '127.0.0.1' });
  await adapter.start();

  const client1 = await connectClient(adapter.port);
  const client2 = await connectClient(adapter.port);

  // Abruptly terminate client1 without waiting for full server-side cleanup
  client1.terminate();

  // Brief yield — allows close event to propagate if it will; either way the
  // broadcast must not throw and client2 must still receive the notification
  await new Promise((r) => setTimeout(r, 20));

  const p2 = nextMessage(client2);
  adapter.broadcastNotification('pool_status', { agents: [] });

  const msg = await p2 as any;

  assert.strictEqual(msg.method, 'pool_status');
  assert.deepStrictEqual(msg.params, { agents: [] });

  client2.terminate();
  await adapter.stop();
});

test('addMethod() registers RPC handler and client receives response', async () => {
  const adapter = new WsAdapter({ port: 0, host: '127.0.0.1' });
  adapter.addMethod('echo', (params: unknown) => params);
  await adapter.start();

  const client = await connectClient(adapter.port);
  const p = nextMessage(client);

  client.send(JSON.stringify({
    jsonrpc: '2.0',
    method: 'echo',
    params: { value: 42 },
    id: 1,
  }));

  const response = await p as any;

  assert.strictEqual(response.jsonrpc, '2.0');
  assert.strictEqual(response.id, 1);
  assert.deepStrictEqual(response.result, { value: 42 });

  client.terminate();
  await adapter.stop();
});

test('stop() closes server and terminates all connected clients', async () => {
  const adapter = new WsAdapter({ port: 0, host: '127.0.0.1' });
  await adapter.start();

  const client = await connectClient(adapter.port);

  const disconnected = new Promise<void>((resolve) => {
    client.once('close', () => resolve());
  });

  await adapter.stop();
  await disconnected;

  assert.strictEqual(client.readyState, WebSocket.CLOSED);
});

test('client disconnect removes it from tracking — broadcast does not error', async () => {
  const adapter = new WsAdapter({ port: 0, host: '127.0.0.1' });
  await adapter.start();

  const client = await connectClient(adapter.port);

  // Wait for server to register the disconnect
  const serverProcessed = new Promise<void>((resolve) => {
    client.once('close', () => setTimeout(resolve, 20));
  });

  client.close();
  await serverProcessed;

  // Broadcast to empty client set — must not throw
  assert.doesNotThrow(() => {
    adapter.broadcastNotification('test_event', { ping: true });
  });

  await adapter.stop();
});
