import fs from 'node:fs';
import path from 'node:path';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import type { WsAdapter } from './adapters/ws.js';
import type { CommAdapter, InboundMessage } from './comms.js';
import type { AgentPool } from './pool.js';
import type { Config } from './config.js';
import type { RoleDefinition, DispatchResult } from './types.js';
import type { McpServers } from './core.js';
import { buildTaskContext } from './context.js';
import { logger } from './logger.js';

const WS_ERROR_TASK_NOT_FOUND = -32000;
const WS_ERROR_AGENT_NOT_FOUND = -32001;
const WS_ERROR_ROLE_NOT_FOUND = -32002;

export type WsMethodDeps = {
  wsAdapter: WsAdapter;
  handleTask: (
    message: InboundMessage,
    adapter: CommAdapter,
    roles: Map<string, RoleDefinition>,
    config: Config,
    pool?: AgentPool,
    mcpServers?: McpServers,
  ) => Promise<DispatchResult>;
  roles: Map<string, RoleDefinition>;
  config: Config;
  pool: AgentPool;
  tasksDir: string;  // absolute path to .agents/tasks/
  mcpServers?: McpServers;
};

function listTasks(tasksDir: string): Array<{ slug: string; created: string; description: string; dispatchCount: number }> {
  if (!fs.existsSync(tasksDir)) return [];
  const entries = fs.readdirSync(tasksDir, { withFileTypes: true }).filter(d => d.isDirectory());
  const tasks = [];
  for (const entry of entries) {
    const manifestPath = path.join(tasksDir, entry.name, 'task.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      tasks.push({
        slug: manifest.slug,
        created: manifest.created,
        description: manifest.description,
        dispatchCount: manifest.dispatches.length,
      });
    } catch { /* skip corrupt */ }
  }
  return tasks;
}

export function registerWsMethods(deps: WsMethodDeps): void {

  // submit_prompt — fire-and-forget dispatch, returns threadId immediately
  deps.wsAdapter.addMethod('submit_prompt', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const content = p['content'];
    const role = p['role'] as string | undefined;
    const taskSlug = p['taskSlug'] as string | undefined;

    if (typeof content !== 'string' || content.trim() === '') {
      throw new JSONRPCErrorException('content is required and must be a non-empty string', -32602);
    }

    if (role !== undefined && !deps.roles.has(role)) {
      throw new JSONRPCErrorException(`Role "${role}" not found`, WS_ERROR_ROLE_NOT_FOUND);
    }

    const threadId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const message: InboundMessage = {
      id: threadId,
      content,
      threadId,
      source: 'ws',
      role,
      metadata: { taskSlug },
    };

    deps.handleTask(message, deps.wsAdapter, deps.roles, deps.config, deps.pool, deps.mcpServers)
      .catch((err: unknown) => {
        logger.error({ err }, 'ws submit_prompt: handleTask error');
      });

    return { threadId, taskSlug: taskSlug ?? null };
  });

  // kill_agent — abort a running agent
  deps.wsAdapter.addMethod('kill_agent', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const agentId = p['agentId'];

    if (typeof agentId !== 'string') {
      throw new JSONRPCErrorException('agentId must be a string', -32602);
    }

    const exists = deps.pool.list().some(a => a.id === agentId);
    if (!exists) {
      throw new JSONRPCErrorException(`Agent "${agentId}" not found`, WS_ERROR_AGENT_NOT_FOUND);
    }

    deps.pool.kill(agentId);
    return { success: true, message: 'Agent killed' };
  });

  // list_agents — strip AbortController before returning
  deps.wsAdapter.addMethod('list_agents', (_params: unknown) => {
    const agents = deps.pool.list().map(a => ({
      id: a.id,
      role: a.role,
      taskSlug: a.taskSlug,
      startedAt: a.startedAt.toISOString(),
    }));
    return { agents };
  });

  // list_tasks — read task directories from disk
  deps.wsAdapter.addMethod('list_tasks', (_params: unknown) => {
    const tasks = listTasks(deps.tasksDir);
    return { tasks };
  });

  // get_task_context — build context from task history
  deps.wsAdapter.addMethod('get_task_context', (params: unknown) => {
    const p = params as Record<string, unknown>;
    const slug = p['slug'];

    if (typeof slug !== 'string') {
      throw new JSONRPCErrorException('slug must be a string', -32602);
    }

    const taskDir = path.join(deps.tasksDir, slug);
    const manifestPath = path.join(taskDir, 'task.json');
    if (!fs.existsSync(manifestPath)) {
      throw new JSONRPCErrorException(`Task "${slug}" not found`, WS_ERROR_TASK_NOT_FOUND);
    }

    const context = buildTaskContext(taskDir);
    return { context };
  });
}
