import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { WsAdapter } from './adapters/ws.js';
import { AgentPool } from './pool.js';
import { registerWsMethods } from './ws-methods.js';
import type { CommAdapter, InboundMessage } from './comms.js';
import type { Config } from './config.js';
import type { RoleDefinition } from './types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function collectMessages(ws: WebSocket, count: number): Promise<unknown[]> {
  return new Promise((resolve) => {
    const msgs: unknown[] = [];
    ws.on('message', (data) => {
      msgs.push(JSON.parse(data.toString()));
      if (msgs.length >= count) resolve(msgs);
    });
  });
}

function sendRpc(ws: WebSocket, method: string, params: unknown, id: number): void {
  ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
}

function makeRole(name = 'api-dev'): RoleDefinition {
  return { name, displayName: 'API Dev', category: 'coding', prompt: '' };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('integration: list_agents RPC returns empty agents list', async () => {
  const adapter = new WsAdapter({ port: 0, host: '127.0.0.1' });
  const pool = new AgentPool();

  registerWsMethods({
    wsAdapter: adapter,
    handleTask: async () => ({ status: 'completed' }),
    roles: new Map([['api-dev', makeRole()]]),
    config: {} as Config,
    pool,
    tasksDir: '/nonexistent',
  });

  await adapter.start();
  const client = await connectClient(adapter.port);

  const messagesPromise = collectMessages(client, 1);
  sendRpc(client, 'list_agents', {}, 1);
  const [response] = await messagesPromise as [any];

  assert.strictEqual(response.jsonrpc, '2.0');
  assert.strictEqual(response.id, 1);
  assert.deepStrictEqual(response.result.agents, []);

  client.terminate();
  await adapter.stop();
});

test('integration: submit_prompt fires handleTask and client receives channel_message notification', async () => {
  const adapter = new WsAdapter({ port: 0, host: '127.0.0.1' });
  const pool = new AgentPool();

  registerWsMethods({
    wsAdapter: adapter,
    handleTask: async (msg: InboundMessage, adp: CommAdapter) => {
      await adp.send({
        id: msg.id,
        channelId: msg.threadId,
        from: 'harness',
        timestamp: new Date('2026-02-20T12:00:00.000Z'),
        type: 'lifecycle',
        content: 'task started',
      });
      return { status: 'completed' };
    },
    roles: new Map([['api-dev', makeRole()]]),
    config: {} as Config,
    pool,
    tasksDir: '/nonexistent',
  });

  await adapter.start();
  const client = await connectClient(adapter.port);

  // Expect two messages: RPC response + channel_message notification
  const messagesPromise = collectMessages(client, 2);
  sendRpc(client, 'submit_prompt', { content: 'test task' }, 2);
  const messages = await messagesPromise as any[];

  const rpcResponse = messages.find((m) => m.id !== undefined);
  assert.ok(rpcResponse, 'should receive RPC response');
  assert.strictEqual(rpcResponse.id, 2);
  assert.ok(typeof rpcResponse.result.threadId === 'string', 'threadId should be a string');
  assert.ok((rpcResponse.result.threadId as string).startsWith('ws-'), 'threadId should start with ws-');

  const notification = messages.find((m) => m.method === 'channel_message');
  assert.ok(notification, 'should receive channel_message notification');
  assert.strictEqual(notification.params.content, 'task started');
  assert.strictEqual(notification.params.timestamp, '2026-02-20T12:00:00.000Z');

  client.terminate();
  await adapter.stop();
});
