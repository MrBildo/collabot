import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { selectMcpServersForRole } from './mcp.js';
import type { McpServers } from './mcp.js';
import type { RoleDefinition } from './types.js';

test('McpServer creates a server with expected shape for Agent SDK', () => {
  const server = new McpServer(
    { name: 'test-harness', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool('echo', {
    description: 'Returns the input message',
    inputSchema: { message: z.string() },
  }, async ({ message }) => ({
    content: [{ type: 'text' as const, text: `echo: ${message}` }],
  }));

  const config: McpSdkServerConfigWithInstance = {
    type: 'sdk' as const,
    name: 'test-harness',
    instance: server,
  };

  assert.equal(config.type, 'sdk');
  assert.equal(config.name, 'test-harness');
  assert.ok(config.instance instanceof McpServer);
});

test('McpServer with empty tools capability works', () => {
  const server = new McpServer(
    { name: 'empty-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  const config: McpSdkServerConfigWithInstance = {
    type: 'sdk' as const,
    name: 'empty-server',
    instance: server,
  };

  assert.equal(config.type, 'sdk');
  assert.ok(config.instance);
});

test('McpServer with multiple tools registers without error', () => {
  const server = new McpServer(
    { name: 'multi-tool', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool('tool_a', {
    description: 'Tool A',
    inputSchema: { val: z.string() },
  }, async ({ val }) => ({
    content: [{ type: 'text' as const, text: val }],
  }));

  server.registerTool('tool_b', {
    description: 'Tool B',
    inputSchema: { num: z.number() },
  }, async ({ num }) => ({
    content: [{ type: 'text' as const, text: String(num) }],
  }));

  const config: McpSdkServerConfigWithInstance = {
    type: 'sdk' as const,
    name: 'multi-tool',
    instance: server,
  };

  assert.equal(config.type, 'sdk');
  assert.ok(config.instance instanceof McpServer);
});

test('McpServer with tool using no input schema works', () => {
  const server = new McpServer(
    { name: 'no-input', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool('ping', {
    description: 'Returns pong',
    inputSchema: {},
  }, async () => ({
    content: [{ type: 'text' as const, text: 'pong' }],
  }));

  assert.ok(server instanceof McpServer);
});

test('McpServer instance is assignable to McpSdkServerConfigWithInstance', () => {
  const server = new McpServer(
    { name: 'type-check', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  const mcpServers: Record<string, McpSdkServerConfigWithInstance> = {
    harness: { type: 'sdk' as const, name: 'type-check', instance: server },
  };
  assert.ok(mcpServers.harness);
  assert.equal(mcpServers.harness.type, 'sdk');
});

// ============================================================
// Dual-audience response pattern tests
// ============================================================

test('McpServer with logging capability accepts instructions', () => {
  const server = new McpServer(
    { name: 'with-instructions', version: '1.0.0' },
    {
      capabilities: { tools: {}, logging: {} },
      instructions: 'Use tool_a to do things.',
    },
  );

  server.registerTool('tool_a', {
    title: 'Tool A',
    description: 'Does things',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => ({
    content: [
      { type: 'text' as const, text: 'Human summary', annotations: { audience: ['user' as const], priority: 0.8 } },
      { type: 'text' as const, text: '{"result":true}', annotations: { audience: ['assistant' as const], priority: 1.0 } },
    ],
    structuredContent: { result: true },
  }));

  assert.ok(server instanceof McpServer);
});

test('McpServer tool with annotations and title registers correctly', () => {
  const server = new McpServer(
    { name: 'annotated', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool('read_data', {
    title: 'Read Data',
    description: 'Reads data from the store',
    inputSchema: {
      key: z.string().describe('The key to look up'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ key }) => ({
    content: [
      { type: 'text' as const, text: `Found: ${key}`, annotations: { audience: ['user' as const], priority: 0.8 } },
      { type: 'text' as const, text: JSON.stringify({ key, value: 'test' }), annotations: { audience: ['assistant' as const], priority: 1.0 } },
    ],
    structuredContent: { key, value: 'test' },
  }));

  const config: McpSdkServerConfigWithInstance = {
    type: 'sdk' as const,
    name: 'annotated',
    instance: server,
  };
  assert.equal(config.type, 'sdk');
});

test('McpServer tool returning isError with plain text', () => {
  const server = new McpServer(
    { name: 'error-test', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool('fail', {
    description: 'Always fails',
    inputSchema: {},
  }, async () => ({
    content: [{ type: 'text' as const, text: 'Something went wrong' }],
    isError: true,
  }));

  assert.ok(server instanceof McpServer);
});

// ============================================================
// selectMcpServersForRole tests
// ============================================================

function makeMockMcpServers(): McpServers {
  const readonlyServer = new McpServer({ name: 'harness-ro', version: '1.0.0' }, { capabilities: { tools: {} } });
  const cronServer = new McpServer({ name: 'cron', version: '1.0.0' }, { capabilities: { tools: {} } });

  return {
    createFull: (_taskSlug: string, _taskDir: string, _parentProject?: string, _parentDispatchId?: string) => {
      const fullServer = new McpServer({ name: 'harness-full', version: '1.0.0' }, { capabilities: { tools: {} } });
      return { type: 'sdk' as const, name: 'harness', instance: fullServer };
    },
    readonly: { type: 'sdk' as const, name: 'harness', instance: readonlyServer },
    cron: { type: 'sdk' as const, name: 'cron', instance: cronServer },
  };
}

function makeRole(overrides?: Partial<RoleDefinition>): RoleDefinition {
  return {
    id: '01TEST_ROLE_000000000000000',
    version: '1.0.0',
    name: 'test-role',
    description: 'Test role',
    createdOn: '2026-01-01T00:00:00Z',
    createdBy: 'Test',
    displayName: 'Test',
    modelHint: 'sonnet-latest',
    prompt: 'test',
    ...overrides,
  };
}

test('selectMcpServersForRole — readonly role gets readonly server, no cron', () => {
  const servers = makeMockMcpServers();
  const role = makeRole({ permissions: [] });

  const selected = selectMcpServersForRole(role, servers, { taskSlug: 'test', taskDir: '/tmp/test' });

  assert.equal(selected.harness.name, 'harness');
  assert.equal(selected.harness, servers.readonly);
  assert.equal(selected.cron, undefined);
});

test('selectMcpServersForRole — agent-draft role gets full server + cron', () => {
  const servers = makeMockMcpServers();
  const role = makeRole({ permissions: ['agent-draft'] });

  const selected = selectMcpServersForRole(role, servers, { taskSlug: 'test', taskDir: '/tmp/test' });

  assert.notEqual(selected.harness, servers.readonly);
  assert.equal(selected.harness.type, 'sdk');
  assert.ok(selected.cron);
  assert.equal(selected.cron.name, 'cron');
});

test('selectMcpServersForRole — agent-draft role without cron server gets no cron', () => {
  const servers = makeMockMcpServers();
  delete servers.cron;
  const role = makeRole({ permissions: ['agent-draft'] });

  const selected = selectMcpServersForRole(role, servers, { taskSlug: 'test', taskDir: '/tmp/test' });

  assert.equal(selected.harness.type, 'sdk');
  assert.equal(selected.cron, undefined);
});

test('selectMcpServersForRole — role with no permissions gets readonly', () => {
  const servers = makeMockMcpServers();
  const role = makeRole(); // no permissions field

  const selected = selectMcpServersForRole(role, servers, { taskSlug: 'test', taskDir: '/tmp/test' });

  assert.equal(selected.harness, servers.readonly);
  assert.equal(selected.cron, undefined);
});

test('selectMcpServersForRole — passes parentDispatchId to createFull', () => {
  let receivedDispatchId: string | undefined;
  const servers: McpServers = {
    ...makeMockMcpServers(),
    createFull: (_ts: string, _td: string, _pp?: string, parentDispatchId?: string) => {
      receivedDispatchId = parentDispatchId;
      const s = new McpServer({ name: 'harness', version: '1.0.0' }, { capabilities: { tools: {} } });
      return { type: 'sdk' as const, name: 'harness', instance: s };
    },
  };
  const role = makeRole({ permissions: ['agent-draft'] });
  selectMcpServersForRole(role, servers, { taskSlug: 'test', taskDir: '/tmp', parentDispatchId: 'dispatch-123' });
  assert.equal(receivedDispatchId, 'dispatch-123');
});
