import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

test('createSdkMcpServer creates a server with type "sdk"', () => {
  const server = createSdkMcpServer({
    name: 'test-harness',
    version: '1.0.0',
    tools: [
      tool('echo', 'Returns the input message', { message: z.string() },
        async ({ message }) => ({
          content: [{ type: 'text' as const, text: `echo: ${message}` }],
        }),
      ),
    ],
  });

  assert.equal(server.type, 'sdk');
  assert.equal(server.name, 'test-harness');
  assert.ok('instance' in server, 'server should have an instance property');
});

test('tool handler can be invoked directly and returns expected result', async () => {
  const echoTool = tool('echo', 'Returns the input message', { message: z.string() },
    async ({ message }) => ({
      content: [{ type: 'text' as const, text: `echo: ${message}` }],
    }),
  );

  // Invoke the handler directly
  const result = await echoTool.handler({ message: 'hello world' }, undefined);
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content.length, 1);

  const textBlock = result.content[0];
  assert.ok(textBlock && 'text' in textBlock);
  assert.equal((textBlock as { type: 'text'; text: string }).text, 'echo: hello world');
});

test('server config is assignable to McpSdkServerConfigWithInstance', () => {
  const server: McpSdkServerConfigWithInstance = createSdkMcpServer({
    name: 'type-check',
    tools: [],
  });

  // Verify the shape matches what dispatch expects for mcpServers
  const mcpServers: Record<string, McpSdkServerConfigWithInstance> = {
    harness: server,
  };
  assert.ok(mcpServers.harness);
  assert.equal(mcpServers.harness.type, 'sdk');
});

test('tool with empty schema works', async () => {
  const noInputTool = tool('ping', 'Returns pong', {},
    async () => ({
      content: [{ type: 'text' as const, text: 'pong' }],
    }),
  );

  const result = await noInputTool.handler({}, undefined);
  assert.equal((result.content[0] as { text: string }).text, 'pong');
});

test('multiple tools can be registered on one server', () => {
  const server = createSdkMcpServer({
    name: 'multi-tool',
    tools: [
      tool('tool_a', 'Tool A', { val: z.string() },
        async ({ val }) => ({ content: [{ type: 'text' as const, text: val }] }),
      ),
      tool('tool_b', 'Tool B', { num: z.number() },
        async ({ num }) => ({ content: [{ type: 'text' as const, text: String(num) }] }),
      ),
    ],
  });

  assert.equal(server.type, 'sdk');
  assert.ok(server.instance);
});
