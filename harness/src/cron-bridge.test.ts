import { test, describe, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CollabDispatchResult } from './types.js';
import type { CronHandlerContext, CronBridgeOptions } from './cron-bridge.js';
import type { HandlerJobDefinition } from './cron-loader.js';
import type { Config } from './config.js';
import { AgentPool } from './pool.js';

// Track temp dirs for cleanup
const tempDirs: string[] = [];
function trackTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Mocks ────────────────────────────────────────────────────
// Mock collabDispatch — returns canned results controllable per test
let mockCollabDispatchImpl: (...args: unknown[]) => Promise<CollabDispatchResult>;

mock.module('./collab-dispatch.js', {
  namedExports: {
    collabDispatch: mock.fn((...args: unknown[]) => mockCollabDispatchImpl(...args)),
  },
});

// Mock loadHandler — returns a controllable handler function per test
let mockLoadHandlerImpl: (handlerPath: string) => Promise<(ctx: unknown) => Promise<void>>;

mock.module('./cron-loader.js', {
  namedExports: {
    loadHandler: mock.fn((handlerPath: string) => mockLoadHandlerImpl(handlerPath)),
    // Re-export the types/functions the bridge also imports from cron-loader
    loadCronJobs: mock.fn(() => []),
    parseJobFolder: mock.fn(),
  },
});

// Import after mocks are registered
const { readRunLog, buildJobHandler } = await import('./cron-bridge.js');
type RunLogEntry = import('./cron-bridge.js').RunLogEntry;

// ── Test Helpers ─────────────────────────────────────────────

function makeConfig(): Config {
  return {
    models: { default: 'claude-sonnet-4-6', aliases: { 'sonnet-latest': 'claude-sonnet-4-6' } },
    pool: { maxConcurrent: 0 },
    mcp: { streamTimeout: 600000 },
    defaults: { stallTimeoutSeconds: 300, dispatchTimeoutMs: 0, tokenBudget: 0, maxBudgetUsd: 0 },
    agent: { maxTurns: 0, maxBudgetUsd: 0 },
    logging: { level: 'debug' },
    routing: { default: 'product-analyst', rules: [] },
    cron: { enabled: true, jobsDirectory: 'cron' },
  } as Config;
}

function makeHandlerDef(overrides?: Partial<HandlerJobDefinition>): HandlerJobDefinition {
  return {
    type: 'handler',
    id: '01HANDLER000000000000000000',
    name: 'test-handler',
    slug: 'test-handler',
    schedule: 'every 60m',
    enabled: true,
    singleton: true,
    bot: 'test-bot',
    handlerPath: '/tmp/fake-handler.ts',
    settings: { refreshInterval: 300, targets: ['alpha', 'beta'] },
    jobDir: '/tmp/test-handler',
    ...overrides,
  };
}

function makeBridgeOptions(overrides?: Partial<CronBridgeOptions>): CronBridgeOptions {
  return {
    ctx: {
      config: makeConfig(),
      roles: new Map(),
      bots: new Map(),
      projects: new Map(),
      projectsDir: '/tmp/.projects',
      pool: new AgentPool(),
    },
    runsDir: trackTmpDir('cron-runs-'),
    projectsDir: trackTmpDir('cron-projects-'),
    ...overrides,
  };
}

function makeDispatchResult(overrides?: Partial<CollabDispatchResult>): CollabDispatchResult {
  return {
    status: 'completed',
    taskSlug: 'task-abc',
    dispatchId: 'DISPATCH001',
    cost: {
      totalUsd: 0.05,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      turns: 3,
      tokenBudget: null,
      tokenBudgetPercent: null,
    },
    duration_ms: 5000,
    model: 'claude-sonnet-4-6',
    ...overrides,
  };
}

// ── Existing Tests ───────────────────────────────────────────

describe('Run log persistence', () => {
  test('readRunLog returns empty array when no log exists', () => {
    const tmpDir = trackTmpDir('cron-bridge-');
    const entries = readRunLog(tmpDir, 'nonexistent', 10);
    assert.deepStrictEqual(entries, []);
  });

  test('readRunLog reads JSONL entries', () => {
    const tmpDir = trackTmpDir('cron-bridge-');
    const entry1: RunLogEntry = {
      runAt: '2026-03-18T10:00:00.000Z',
      duration_ms: 5000,
      status: 'completed',
      dispatchCount: 1,
      totalCostUsd: 0.05,
      taskSlugs: ['task-1'],
    };
    const entry2: RunLogEntry = {
      runAt: '2026-03-18T11:00:00.000Z',
      duration_ms: 3000,
      status: 'failed',
      dispatchCount: 0,
      totalCostUsd: 0,
      taskSlugs: [],
      error: 'timeout',
    };

    const logPath = path.join(tmpDir, 'test-job.jsonl');
    fs.writeFileSync(logPath, JSON.stringify(entry1) + '\n' + JSON.stringify(entry2) + '\n', 'utf-8');

    const entries = readRunLog(tmpDir, 'test-job', 10);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.status, 'completed');
    assert.equal(entries[1]!.status, 'failed');
    assert.equal(entries[1]!.error, 'timeout');
  });

  test('readRunLog respects limit', () => {
    const tmpDir = trackTmpDir('cron-bridge-');
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(JSON.stringify({
        runAt: `2026-03-18T${String(i).padStart(2, '0')}:00:00.000Z`,
        duration_ms: 1000,
        status: 'completed',
        dispatchCount: 1,
        totalCostUsd: 0.01,
        taskSlugs: [`task-${i}`],
      }));
    }

    const logPath = path.join(tmpDir, 'many-runs.jsonl');
    fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf-8');

    const entries = readRunLog(tmpDir, 'many-runs', 3);
    assert.equal(entries.length, 3);
    // Should return the LAST 3 entries
    assert.ok(entries[0]!.taskSlugs[0]!.includes('7'));
  });

  test('readRunLog handles malformed lines gracefully', () => {
    const tmpDir = trackTmpDir('cron-bridge-');
    const logPath = path.join(tmpDir, 'bad-lines.jsonl');
    fs.writeFileSync(logPath, [
      JSON.stringify({ runAt: '2026-03-18T10:00:00Z', duration_ms: 1000, status: 'completed', dispatchCount: 1, totalCostUsd: 0, taskSlugs: [] }),
      'this is not json',
      JSON.stringify({ runAt: '2026-03-18T11:00:00Z', duration_ms: 2000, status: 'completed', dispatchCount: 1, totalCostUsd: 0, taskSlugs: [] }),
    ].join('\n') + '\n', 'utf-8');

    const entries = readRunLog(tmpDir, 'bad-lines', 10);
    assert.equal(entries.length, 2, 'should skip malformed lines');
  });
});

describe('CronBridgeOptions.getLastRunAt', () => {
  test('buildJobHandler accepts getLastRunAt callback', async () => {
    let getLastRunAtCalled = false;
    const options = makeBridgeOptions({
      getLastRunAt: (_name: string) => {
        getLastRunAtCalled = true;
        return '2026-03-18T10:00:00.000Z';
      },
    });

    const handler = buildJobHandler({
      type: 'agent',
      id: '01TEST00000000000000000000',
      name: 'test',
      slug: 'test',
      schedule: 'every 60m',
      enabled: true,
      singleton: true,
      role: 'researcher',
      project: 'lobby',
      prompt: 'Test.',
      jobDir: '/tmp/test',
    }, options);

    assert.equal(typeof handler, 'function', 'buildJobHandler should return a function');
    assert.equal(getLastRunAtCalled, false, 'callback should not be called at build time');
  });
});

// ── Suite 1: Handler Job Execution Path ──────────────────────

describe('Handler job execution path', () => {
  test('CronHandlerContext is correctly assembled with all properties', async () => {
    let capturedCtx: CronHandlerContext | undefined;
    const def = makeHandlerDef({
      settings: { refreshInterval: 300, targets: ['alpha', 'beta'] },
    });
    const config = makeConfig();
    const options = makeBridgeOptions({
      ctx: {
        config,
        roles: new Map(),
        bots: new Map(),
        projects: new Map(),
        projectsDir: '/tmp/.projects',
        pool: new AgentPool(),
      },
      getLastRunAt: (name: string) => {
        assert.equal(name, def.name);
        return '2026-03-19T08:00:00.000Z';
      },
    });

    mockLoadHandlerImpl = async (_handlerPath: string) => {
      return async (ctx: unknown) => {
        capturedCtx = ctx as CronHandlerContext;
      };
    };

    const handler = buildJobHandler(def, options);
    await handler();

    assert.ok(capturedCtx, 'handler should have been called with context');

    // ctx.config.job contains settings from job definition
    assert.deepStrictEqual(capturedCtx.config.job, { refreshInterval: 300, targets: ['alpha', 'beta'] });

    // ctx.config.harness is the global Config object
    assert.equal(capturedCtx.config.harness, config);

    // ctx.job matches the definition
    assert.equal(capturedCtx.job, def);
    assert.equal(capturedCtx.job.name, 'test-handler');
    assert.equal(capturedCtx.job.type, 'handler');

    // ctx.lastRunAt is populated from getLastRunAt
    assert.ok(capturedCtx.lastRunAt instanceof Date);
    assert.equal(capturedCtx.lastRunAt!.toISOString(), '2026-03-19T08:00:00.000Z');

    // ctx.signal is an AbortSignal
    assert.ok(capturedCtx.signal instanceof AbortSignal);
    assert.equal(capturedCtx.signal.aborted, false);

    // ctx.log is a logger instance
    assert.ok(capturedCtx.log !== undefined);
    assert.equal(typeof capturedCtx.log.info, 'function');
    assert.equal(typeof capturedCtx.log.error, 'function');

    // ctx.dispatch is a function
    assert.equal(typeof capturedCtx.dispatch, 'function');

    // ctx.getRunLog is a function
    assert.equal(typeof capturedCtx.getRunLog, 'function');
  });

  test('lastRunAt is null when scheduler has no state', async () => {
    let capturedCtx: CronHandlerContext | undefined;
    const def = makeHandlerDef();
    const options = makeBridgeOptions(); // no getLastRunAt provided

    mockLoadHandlerImpl = async () => {
      return async (ctx: unknown) => {
        capturedCtx = ctx as CronHandlerContext;
      };
    };

    const handler = buildJobHandler(def, options);
    await handler();

    assert.ok(capturedCtx, 'handler should have been called');
    assert.equal(capturedCtx.lastRunAt, null, 'lastRunAt should be null when no scheduler state');
  });

  test('handler function is called with the context', async () => {
    let handlerCalled = false;
    const def = makeHandlerDef();
    const options = makeBridgeOptions();

    mockLoadHandlerImpl = async () => {
      return async (_ctx: unknown) => {
        handlerCalled = true;
      };
    };

    const handler = buildJobHandler(def, options);
    await handler();

    assert.ok(handlerCalled, 'the handler function must be invoked');
  });

  test('loadHandler is called with the correct handlerPath', async () => {
    let capturedHandlerPath: string | undefined;
    const def = makeHandlerDef({ handlerPath: '/custom/path/handler.ts' });
    const options = makeBridgeOptions();

    mockLoadHandlerImpl = async (handlerPath: string) => {
      capturedHandlerPath = handlerPath;
      return async () => {};
    };

    const handler = buildJobHandler(def, options);
    await handler();

    assert.equal(capturedHandlerPath, '/custom/path/handler.ts');
  });

  test('ctx.dispatch calls collabDispatch and returns the result', async () => {
    let capturedCtx: CronHandlerContext | undefined;
    const cannedResult = makeDispatchResult({ taskSlug: 'dispatch-test-task' });
    const def = makeHandlerDef({ bot: 'my-bot', tokenBudget: 5000, maxTurns: 10, maxBudgetUsd: 1.5 });
    const options = makeBridgeOptions();

    let capturedDispatchOpts: Record<string, unknown> | undefined;
    mockCollabDispatchImpl = async (opts: unknown) => {
      capturedDispatchOpts = opts as Record<string, unknown>;
      return cannedResult;
    };
    mockLoadHandlerImpl = async () => {
      return async (ctx: unknown) => {
        capturedCtx = ctx as CronHandlerContext;
        const result = await capturedCtx.dispatch({
          project: 'my-project',
          role: 'researcher',
          prompt: 'Analyze data',
        });
        assert.equal(result, cannedResult);
      };
    };

    const handler = buildJobHandler(def, options);
    await handler();

    assert.ok(capturedCtx, 'handler must have been called');

    // Verify constraint forwarding from job definition to collabDispatch
    assert.ok(capturedDispatchOpts, 'collabDispatch should have been called');
    assert.equal(capturedDispatchOpts.bot, 'my-bot', 'bot should be forwarded from job definition');
    assert.equal(capturedDispatchOpts.tokenBudget, 5000, 'tokenBudget should be forwarded from job definition');
    assert.equal(capturedDispatchOpts.maxTurns, 10, 'maxTurns should be forwarded from job definition');
    assert.equal(capturedDispatchOpts.maxBudgetUsd, 1.5, 'maxBudgetUsd should be forwarded from job definition');
  });

  test('completed handler run writes a run log entry', async () => {
    const def = makeHandlerDef();
    const options = makeBridgeOptions();

    mockLoadHandlerImpl = async () => {
      return async () => {
        // handler completes with no dispatches
      };
    };

    const handler = buildJobHandler(def, options);
    await handler();

    const entries = readRunLog(options.runsDir, def.name, 10);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.status, 'completed');
    assert.equal(entries[0]!.dispatchCount, 0);
    assert.equal(entries[0]!.totalCostUsd, 0);
    assert.deepStrictEqual(entries[0]!.taskSlugs, []);
  });
});

// ── Suite 2: ConfigResolver ──────────────────────────────────

describe('ConfigResolver', () => {
  test('ctx.config.harness returns the Config object', async () => {
    let capturedCtx: CronHandlerContext | undefined;
    const config = makeConfig();
    const def = makeHandlerDef();
    const options = makeBridgeOptions({
      ctx: {
        config,
        roles: new Map(),
        bots: new Map(),
        projects: new Map(),
        projectsDir: '/tmp/.projects',
        pool: new AgentPool(),
      },
    });

    mockLoadHandlerImpl = async () => {
      return async (ctx: unknown) => {
        capturedCtx = ctx as CronHandlerContext;
      };
    };

    const handler = buildJobHandler(def, options);
    await handler();

    assert.ok(capturedCtx);
    assert.equal(capturedCtx.config.harness, config, 'harness config should be the same object reference');
    assert.equal(capturedCtx.config.harness.models.default, 'claude-sonnet-4-6');
  });

  test('ctx.config.job returns parsed settings from definition', async () => {
    let capturedCtx: CronHandlerContext | undefined;
    const settings = { apiEndpoint: 'https://api.example.com', retryCount: 3, tags: ['a', 'b'] };
    const def = makeHandlerDef({ settings });
    const options = makeBridgeOptions();

    mockLoadHandlerImpl = async () => {
      return async (ctx: unknown) => {
        capturedCtx = ctx as CronHandlerContext;
      };
    };

    const handler = buildJobHandler(def, options);
    await handler();

    assert.ok(capturedCtx);
    assert.deepStrictEqual(capturedCtx.config.job, settings);
    assert.equal(capturedCtx.config.job.apiEndpoint, 'https://api.example.com');
    assert.equal(capturedCtx.config.job.retryCount, 3);
  });

  test('ctx.config.job returns empty object when no settings', async () => {
    let capturedCtx: CronHandlerContext | undefined;
    const def = makeHandlerDef({ settings: {} });
    const options = makeBridgeOptions();

    mockLoadHandlerImpl = async () => {
      return async (ctx: unknown) => {
        capturedCtx = ctx as CronHandlerContext;
      };
    };

    const handler = buildJobHandler(def, options);
    await handler();

    assert.ok(capturedCtx);
    assert.deepStrictEqual(capturedCtx.config.job, {});
  });

  test('ctx.config.projectEnv reads .agents.env from the project path', async () => {
    let capturedCtx: CronHandlerContext | undefined;
    const projectsDir = trackTmpDir('cron-projenv-');

    // Create a fake project's .agents.env
    const projectDir = path.join(projectsDir, 'myproject');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.agents.env'), [
      '# Comment line',
      'API_KEY=secret123',
      'DB_HOST=localhost',
      '',
      'PORT=3000',
    ].join('\n'), 'utf-8');

    const def = makeHandlerDef();
    const options = makeBridgeOptions({ projectsDir });

    mockLoadHandlerImpl = async () => {
      return async (ctx: unknown) => {
        capturedCtx = ctx as CronHandlerContext;
      };
    };

    const handler = buildJobHandler(def, options);
    await handler();

    assert.ok(capturedCtx);
    const env = capturedCtx.config.projectEnv('MyProject'); // case-insensitive via toLowerCase
    assert.equal(env.API_KEY, 'secret123');
    assert.equal(env.DB_HOST, 'localhost');
    assert.equal(env.PORT, '3000');
    assert.equal(env['# Comment line'], undefined, 'comments should be skipped');
  });

  test('ctx.config.projectEnv returns empty object for nonexistent project', async () => {
    let capturedCtx: CronHandlerContext | undefined;
    const projectsDir = trackTmpDir('cron-projenv-');
    const def = makeHandlerDef();
    const options = makeBridgeOptions({ projectsDir });

    mockLoadHandlerImpl = async () => {
      return async (ctx: unknown) => {
        capturedCtx = ctx as CronHandlerContext;
      };
    };

    const handler = buildJobHandler(def, options);
    await handler();

    assert.ok(capturedCtx);
    const env = capturedCtx.config.projectEnv('nonexistent-project');
    assert.deepStrictEqual(env, {});
  });

  test('ctx.config.projectEnv skips lines without equals sign', async () => {
    let capturedCtx: CronHandlerContext | undefined;
    const projectsDir = trackTmpDir('cron-projenv-');
    const projectDir = path.join(projectsDir, 'edgecase');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.agents.env'), [
      'VALID_KEY=value',
      'no-equals-here',
      'ANOTHER=works',
    ].join('\n'), 'utf-8');

    const def = makeHandlerDef();
    const options = makeBridgeOptions({ projectsDir });

    mockLoadHandlerImpl = async () => {
      return async (ctx: unknown) => {
        capturedCtx = ctx as CronHandlerContext;
      };
    };

    const handler = buildJobHandler(def, options);
    await handler();

    assert.ok(capturedCtx);
    const env = capturedCtx.config.projectEnv('edgecase');
    assert.equal(env.VALID_KEY, 'value');
    assert.equal(env.ANOTHER, 'works');
    assert.equal(Object.keys(env).length, 2, 'lines without = should be skipped');
  });
});

// ── Suite 3: Handler with Fan-out ────────────────────────────

describe('Handler with fan-out dispatches', () => {
  test('multiple dispatches accumulate correct run log entry', async () => {
    const result1 = makeDispatchResult({ taskSlug: 'fan-task-1', cost: { ...makeDispatchResult().cost, totalUsd: 0.10 } });
    const result2 = makeDispatchResult({ taskSlug: 'fan-task-2', cost: { ...makeDispatchResult().cost, totalUsd: 0.25 } });
    const result3 = makeDispatchResult({ taskSlug: 'fan-task-3', cost: { ...makeDispatchResult().cost, totalUsd: 0.15 } });

    let callCount = 0;
    mockCollabDispatchImpl = async () => {
      callCount++;
      if (callCount === 1) return result1;
      if (callCount === 2) return result2;
      return result3;
    };

    const def = makeHandlerDef();
    const options = makeBridgeOptions();

    mockLoadHandlerImpl = async () => {
      return async (ctx: unknown) => {
        const hCtx = ctx as CronHandlerContext;
        await hCtx.dispatch({ project: 'proj-a', role: 'researcher', prompt: 'Task 1' });
        await hCtx.dispatch({ project: 'proj-b', role: 'developer', prompt: 'Task 2' });
        await hCtx.dispatch({ project: 'proj-c', role: 'analyst', prompt: 'Task 3' });
      };
    };

    const handler = buildJobHandler(def, options);
    await handler();

    const entries = readRunLog(options.runsDir, def.name, 10);
    assert.equal(entries.length, 1, 'should have exactly one run log entry');

    const entry = entries[0]!;
    assert.equal(entry.status, 'completed');
    assert.equal(entry.dispatchCount, 3, 'dispatchCount should reflect all 3 dispatches');
    assert.equal(entry.totalCostUsd, 0.5, 'totalCostUsd should be 0.10 + 0.25 + 0.15 = 0.50');
    assert.deepStrictEqual(entry.taskSlugs, ['fan-task-1', 'fan-task-2', 'fan-task-3']);
  });

  test('zero dispatches results in empty aggregation', async () => {
    const def = makeHandlerDef();
    const options = makeBridgeOptions();

    mockLoadHandlerImpl = async () => {
      return async () => {
        // handler does no dispatches
      };
    };

    const handler = buildJobHandler(def, options);
    await handler();

    const entries = readRunLog(options.runsDir, def.name, 10);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.dispatchCount, 0);
    assert.equal(entries[0]!.totalCostUsd, 0);
    assert.deepStrictEqual(entries[0]!.taskSlugs, []);
  });

  test('single dispatch results in correct aggregation', async () => {
    const cannedResult = makeDispatchResult({
      taskSlug: 'single-task',
      cost: { ...makeDispatchResult().cost, totalUsd: 0.42 },
    });

    mockCollabDispatchImpl = async () => cannedResult;

    const def = makeHandlerDef();
    const options = makeBridgeOptions();

    mockLoadHandlerImpl = async () => {
      return async (ctx: unknown) => {
        const hCtx = ctx as CronHandlerContext;
        await hCtx.dispatch({ project: 'proj', role: 'dev', prompt: 'Do work' });
      };
    };

    const handler = buildJobHandler(def, options);
    await handler();

    const entries = readRunLog(options.runsDir, def.name, 10);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.dispatchCount, 1);
    assert.equal(entries[0]!.totalCostUsd, 0.42);
    assert.deepStrictEqual(entries[0]!.taskSlugs, ['single-task']);
  });

  test('failed handler still records partial dispatch data in run log', async () => {
    const result1 = makeDispatchResult({ taskSlug: 'partial-1', cost: { ...makeDispatchResult().cost, totalUsd: 0.08 } });

    let callCount = 0;
    mockCollabDispatchImpl = async () => {
      callCount++;
      return result1;
    };

    const def = makeHandlerDef();
    const options = makeBridgeOptions();

    mockLoadHandlerImpl = async () => {
      return async (ctx: unknown) => {
        const hCtx = ctx as CronHandlerContext;
        await hCtx.dispatch({ project: 'proj', role: 'dev', prompt: 'First task' });
        throw new Error('handler crashed mid-execution');
      };
    };

    const handler = buildJobHandler(def, options);
    await assert.rejects(handler, { message: 'handler crashed mid-execution' });

    const entries = readRunLog(options.runsDir, def.name, 10);
    assert.equal(entries.length, 1);

    const entry = entries[0]!;
    assert.equal(entry.status, 'failed');
    assert.equal(entry.dispatchCount, 1, 'should record the one dispatch that succeeded');
    assert.equal(entry.totalCostUsd, 0.08);
    assert.deepStrictEqual(entry.taskSlugs, ['partial-1']);
    assert.equal(entry.error, 'handler crashed mid-execution');
  });
});
