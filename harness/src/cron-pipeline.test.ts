import { test, describe, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CollabDispatchResult } from './types.js';
import type { CronHandlerContext, CronBridgeOptions } from './cron-bridge.js';
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
    loadCronJobs: mock.fn(() => []),
    parseJobFolder: mock.fn(),
  },
});

// Import after mocks are registered
const { readRunLog, buildJobHandler } = await import('./cron-bridge.js');

// ── Test Helpers ─────────────────────────────────────────────

function makeConfig(): Config {
  return {
    models: { default: 'claude-sonnet-4-6', aliases: { 'sonnet-latest': 'claude-sonnet-4-6' } },
    pool: { maxConcurrent: 0 },
    mcp: { streamTimeout: 600000 },
    defaults: { stallTimeoutSeconds: 300, dispatchTimeoutMs: 0, tokenBudget: 0, maxBudgetUsd: 0 },
    agent: { maxTurns: 0, maxBudgetUsd: 0 },
    logging: { level: 'debug' },
    cron: { enabled: true, jobsDirectory: 'cron' },
  } as Config;
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
    runsDir: trackTmpDir('cron-pipeline-runs-'),
    projectsDir: trackTmpDir('cron-pipeline-projects-'),
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

function makeTempJobDir(slug: string, files: Record<string, string>): { jobDir: string; baseDir: string } {
  const baseDir = trackTmpDir('cron-pipeline-');
  const jobDir = path.join(baseDir, slug);
  fs.mkdirSync(jobDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(jobDir, name), content, 'utf-8');
  }
  return { jobDir, baseDir };
}

// ── Suite 1: Agent job full pipeline (parseJobFolder → buildJobHandler → mock dispatch → run log) ──

describe('Agent job full pipeline', () => {
  test('buildJobHandler → collabDispatch (mocked) → run log entry', async () => {
    const { jobDir, baseDir } = makeTempJobDir('pipeline-agent', {
      'job.md': [
        '---',
        'name: pipeline-agent',
        'schedule: "every 30m"',
        'role: researcher',
        'project: my-project',
        'tokenBudget: 50000',
        'maxTurns: 10',
        '---',
        '',
        'Analyze the board and report findings.',
      ].join('\n'),
    });

    // Construct a job definition directly (parseJobFolder is mocked in this file)
    const def = {
      type: 'agent' as const,
      id: '01PIPELINE000000000000000000',
      name: 'pipeline-agent',
      slug: 'pipeline-agent',
      schedule: 'every 30m',
      enabled: true,
      singleton: true,
      role: 'researcher',
      project: 'my-project',
      prompt: 'Analyze the board and report findings.',
      tokenBudget: 50000,
      maxTurns: 10,
      jobDir,
    };

    // Step 2: buildJobHandler with mock collabDispatch
    const runsDir = path.join(baseDir, 'runs');
    const cannedResult = makeDispatchResult({
      taskSlug: 'pipeline-task-001',
      cost: { ...makeDispatchResult().cost, totalUsd: 0.12 },
    });

    mockCollabDispatchImpl = async (opts: unknown, ctx: unknown) => {
      // Verify dispatch options are passed correctly
      const o = opts as Record<string, unknown>;
      assert.equal(o.project, 'my-project');
      assert.equal(o.role, 'researcher');
      assert.equal(o.prompt, 'Analyze the board and report findings.');
      assert.equal(o.tokenBudget, 50000);
      assert.equal(o.maxTurns, 10);
      return cannedResult;
    };

    const options = makeBridgeOptions({ runsDir });
    const handler = buildJobHandler(def, options);

    // Step 3: Execute
    await handler();

    // Step 4: Verify run log
    const entries = readRunLog(runsDir, 'pipeline-agent', 10);
    assert.equal(entries.length, 1, 'should have one run log entry');

    const entry = entries[0]!;
    assert.equal(entry.status, 'completed');
    assert.equal(entry.dispatchCount, 1);
    assert.equal(entry.totalCostUsd, 0.12);
    assert.deepStrictEqual(entry.taskSlugs, ['pipeline-task-001']);
    assert.ok(entry.duration_ms >= 0, 'duration should be non-negative');
    assert.ok(entry.runAt, 'runAt should be set');
  });

  test('agent job failure writes failed run log entry with error', async () => {
    const def = {
      type: 'agent' as const,
      id: '01AGENTFAIL00000000000000000',
      name: 'failing-agent',
      slug: 'failing-agent',
      schedule: 'every 60m',
      enabled: true,
      singleton: true,
      role: 'researcher',
      project: 'my-project',
      prompt: 'This will fail.',
      jobDir: '/tmp/failing-agent',
    };

    mockCollabDispatchImpl = async () => {
      throw new Error('SDK connection refused');
    };

    const options = makeBridgeOptions();
    const handler = buildJobHandler(def, options);

    await assert.rejects(handler, { message: 'SDK connection refused' });

    const entries = readRunLog(options.runsDir, 'failing-agent', 10);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.status, 'failed');
    assert.equal(entries[0]!.dispatchCount, 0);
    assert.equal(entries[0]!.totalCostUsd, 0);
    assert.equal(entries[0]!.error, 'SDK connection refused');
  });

  test('agent job with bot parameter passes bot to dispatch', async () => {
    const def = {
      type: 'agent' as const,
      id: '01AGENTBOT00000000000000000',
      name: 'bot-agent',
      slug: 'bot-agent',
      schedule: 'every 60m',
      enabled: true,
      singleton: true,
      bot: 'greg',
      role: 'developer',
      project: 'collabot',
      prompt: 'Fix the bug.',
      jobDir: '/tmp/bot-agent',
    };

    let capturedBot: string | undefined;
    mockCollabDispatchImpl = async (opts: unknown) => {
      capturedBot = (opts as Record<string, unknown>).bot as string;
      return makeDispatchResult();
    };

    const options = makeBridgeOptions();
    const handler = buildJobHandler(def, options);
    await handler();

    assert.equal(capturedBot, 'greg', 'bot should be passed through to collabDispatch');
  });
});

// ── Suite 2: Handler job with mock Collaboard API (board-watcher pattern) ──

describe('handler job pipeline with mock fetch and dispatch', () => {
  // Tests the handler job pipeline (buildJobHandler + CronHandlerContext + dispatch + run log)
  // using board-watcher-like logic as the scenario. Does not test the actual template handler.
  //
  // The board-watcher handler makes fetch() calls to a Collaboard API and
  // conditionally dispatches agents. We simulate the handler inline (same
  // logic as the template) and mock fetch + collabDispatch.

  function makeBoardWatcherHandler(
    boards: Array<{ slug: string; project: string }>,
    fetchResponses: Map<string, { ok: boolean; status: number; body: unknown }>,
  ): (ctx: CronHandlerContext) => Promise<void> {
    return async (ctx: CronHandlerContext) => {
      if (!boards || boards.length === 0) {
        ctx.log.warn('board-watcher: no boards configured');
        return;
      }

      const since = ctx.lastRunAt?.toISOString()
        ?? new Date(Date.now() - 86400000).toISOString();

      for (const board of boards) {
        const authKey = ctx.config.projectEnv(board.project).COLLABOARD_AUTH_KEY;
        if (!authKey) {
          ctx.log.warn({ board: board.slug, project: board.project }, 'no COLLABOARD_AUTH_KEY');
          continue;
        }

        const mockResponse = fetchResponses.get(board.slug);
        if (!mockResponse) continue;

        if (!mockResponse.ok) {
          ctx.log.error({ board: board.slug, status: mockResponse.status }, 'board API error');
          continue;
        }

        const cards = mockResponse.body as Array<{ number: number; laneName: string; name: string }>;

        if (cards.length === 0) {
          ctx.log.info({ board: board.slug }, 'clean — skipping');
          continue;
        }

        await ctx.dispatch({
          project: board.project,
          role: ctx.job.role ?? 'researcher',
          prompt: [
            `Board "${board.slug}" has ${cards.length} cards with new activity since ${since}.`,
            '',
            cards.map(c => `- #${c.number} (${c.laneName}): ${c.name}`).join('\n'),
            '',
            'Review each card and take appropriate action.',
          ].join('\n'),
        });
      }
    };
  }

  test('clean board results in zero dispatches and completed run log', async () => {
    const boards = [{ slug: 'test-board', project: 'test-project' }];
    const fetchResponses = new Map([
      ['test-board', { ok: true, status: 200, body: [] }],
    ]);

    const handlerFn = makeBoardWatcherHandler(boards, fetchResponses);

    const def = {
      type: 'handler' as const,
      id: '01BOARDCLEAN000000000000000',
      name: 'board-watcher-clean',
      slug: 'board-watcher-clean',
      schedule: '*/30 9-17 * * MON-FRI',
      enabled: true,
      singleton: true,
      role: 'researcher',
      handlerPath: '/tmp/board-watcher/handler.ts',
      settings: { boards },
      jobDir: '/tmp/board-watcher',
    };

    const projectsDir = trackTmpDir('bw-proj-');
    // Create project env with auth key
    const projDir = path.join(projectsDir, 'test-project');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, '.agent.env'), 'COLLABOARD_AUTH_KEY=test-key-123\n', 'utf-8');

    mockLoadHandlerImpl = async () => handlerFn;

    const options = makeBridgeOptions({
      projectsDir,
      getLastRunAt: () => '2026-03-20T10:00:00.000Z',
    });

    const handler = buildJobHandler(def, options);
    await handler();

    const entries = readRunLog(options.runsDir, def.name, 10);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.status, 'completed');
    assert.equal(entries[0]!.dispatchCount, 0, 'clean board should trigger zero dispatches');
    assert.equal(entries[0]!.totalCostUsd, 0);
    assert.deepStrictEqual(entries[0]!.taskSlugs, []);
  });

  test('dirty board dispatches agent with pre-filtered card context', async () => {
    const boards = [{ slug: 'active-board', project: 'active-project' }];
    const dirtyCards = [
      { number: 42, laneName: 'In Progress', name: 'Implement cron system' },
      { number: 43, laneName: 'Review', name: 'Fix dispatch bug' },
    ];
    const fetchResponses = new Map([
      ['active-board', { ok: true, status: 200, body: dirtyCards }],
    ]);

    const handlerFn = makeBoardWatcherHandler(boards, fetchResponses);

    const def = {
      type: 'handler' as const,
      id: '01BOARDDIRTY000000000000000',
      name: 'board-watcher-dirty',
      slug: 'board-watcher-dirty',
      schedule: '*/30 9-17 * * MON-FRI',
      enabled: true,
      singleton: true,
      role: 'researcher',
      handlerPath: '/tmp/board-watcher/handler.ts',
      settings: { boards },
      jobDir: '/tmp/board-watcher',
    };

    const projectsDir = trackTmpDir('bw-proj-');
    const projDir = path.join(projectsDir, 'active-project');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, '.agent.env'), 'COLLABOARD_AUTH_KEY=active-key\n', 'utf-8');

    const cannedResult = makeDispatchResult({
      taskSlug: 'board-task-001',
      cost: { ...makeDispatchResult().cost, totalUsd: 0.08 },
    });

    let capturedPrompt: string | undefined;
    let capturedProject: string | undefined;
    mockCollabDispatchImpl = async (opts: unknown) => {
      const o = opts as Record<string, unknown>;
      capturedPrompt = o.prompt as string;
      capturedProject = o.project as string;
      return cannedResult;
    };

    mockLoadHandlerImpl = async () => handlerFn;

    const options = makeBridgeOptions({
      projectsDir,
      getLastRunAt: () => '2026-03-20T10:00:00.000Z',
    });

    const handler = buildJobHandler(def, options);
    await handler();

    // Verify dispatch was called with card context
    assert.ok(capturedPrompt, 'dispatch should have been called');
    assert.ok(capturedPrompt.includes('active-board'), 'prompt should reference the board slug');
    assert.ok(capturedPrompt.includes('2 cards'), 'prompt should include card count');
    assert.ok(capturedPrompt.includes('#42'), 'prompt should include card numbers');
    assert.ok(capturedPrompt.includes('#43'), 'prompt should include card numbers');
    assert.ok(capturedPrompt.includes('In Progress'), 'prompt should include lane names');
    assert.ok(capturedPrompt.includes('Implement cron system'), 'prompt should include card names');
    assert.equal(capturedProject, 'active-project');

    // Verify run log
    const entries = readRunLog(options.runsDir, def.name, 10);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.status, 'completed');
    assert.equal(entries[0]!.dispatchCount, 1);
    assert.equal(entries[0]!.totalCostUsd, 0.08);
    assert.deepStrictEqual(entries[0]!.taskSlugs, ['board-task-001']);
  });

  test('board with no auth key is skipped gracefully', async () => {
    const boards = [{ slug: 'no-auth-board', project: 'noauth-project' }];
    const fetchResponses = new Map([
      ['no-auth-board', { ok: true, status: 200, body: [{ number: 1, laneName: 'Ready', name: 'Test' }] }],
    ]);

    const handlerFn = makeBoardWatcherHandler(boards, fetchResponses);

    const def = {
      type: 'handler' as const,
      id: '01BOARDNOAUTH0000000000000',
      name: 'board-watcher-noauth',
      slug: 'board-watcher-noauth',
      schedule: 'every 60m',
      enabled: true,
      singleton: true,
      handlerPath: '/tmp/handler.ts',
      settings: { boards },
      jobDir: '/tmp/noauth',
    };

    // No .agent.env file for this project
    const projectsDir = trackTmpDir('bw-proj-');

    mockLoadHandlerImpl = async () => handlerFn;
    mockCollabDispatchImpl = async () => {
      throw new Error('dispatch should not be called');
    };

    const options = makeBridgeOptions({ projectsDir });
    const handler = buildJobHandler(def, options);
    await handler();

    const entries = readRunLog(options.runsDir, def.name, 10);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.status, 'completed');
    assert.equal(entries[0]!.dispatchCount, 0, 'no dispatches when auth key is missing');
  });

  test('board API error is handled gracefully without dispatch', async () => {
    const boards = [{ slug: 'error-board', project: 'error-project' }];
    const fetchResponses = new Map([
      ['error-board', { ok: false, status: 500, body: null }],
    ]);

    const handlerFn = makeBoardWatcherHandler(boards, fetchResponses);

    const def = {
      type: 'handler' as const,
      id: '01BOARDERROR000000000000000',
      name: 'board-watcher-error',
      slug: 'board-watcher-error',
      schedule: 'every 60m',
      enabled: true,
      singleton: true,
      handlerPath: '/tmp/handler.ts',
      settings: { boards },
      jobDir: '/tmp/error',
    };

    const projectsDir = trackTmpDir('bw-proj-');
    const projDir = path.join(projectsDir, 'error-project');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, '.agent.env'), 'COLLABOARD_AUTH_KEY=err-key\n', 'utf-8');

    mockLoadHandlerImpl = async () => handlerFn;
    mockCollabDispatchImpl = async () => {
      throw new Error('dispatch should not be called for API errors');
    };

    const options = makeBridgeOptions({ projectsDir });
    const handler = buildJobHandler(def, options);
    await handler();

    const entries = readRunLog(options.runsDir, def.name, 10);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.status, 'completed');
    assert.equal(entries[0]!.dispatchCount, 0);
  });

  test('multi-board scenario: one clean, one dirty', async () => {
    const boards = [
      { slug: 'clean-board', project: 'proj-a' },
      { slug: 'dirty-board', project: 'proj-b' },
    ];
    const fetchResponses = new Map([
      ['clean-board', { ok: true, status: 200, body: [] }],
      ['dirty-board', { ok: true, status: 200, body: [
        { number: 10, laneName: 'Triage', name: 'New bug report' },
      ]}],
    ]);

    const handlerFn = makeBoardWatcherHandler(boards, fetchResponses);

    const def = {
      type: 'handler' as const,
      id: '01BOARDMULTI000000000000000',
      name: 'board-watcher-multi',
      slug: 'board-watcher-multi',
      schedule: 'every 30m',
      enabled: true,
      singleton: true,
      role: 'researcher',
      handlerPath: '/tmp/handler.ts',
      settings: { boards },
      jobDir: '/tmp/multi',
    };

    const projectsDir = trackTmpDir('bw-proj-');
    for (const proj of ['proj-a', 'proj-b']) {
      const projDir = path.join(projectsDir, proj);
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(path.join(projDir, '.agent.env'), `COLLABOARD_AUTH_KEY=key-${proj}\n`, 'utf-8');
    }

    const cannedResult = makeDispatchResult({ taskSlug: 'multi-task' });
    let dispatchCount = 0;
    mockCollabDispatchImpl = async () => {
      dispatchCount++;
      return cannedResult;
    };

    mockLoadHandlerImpl = async () => handlerFn;

    const options = makeBridgeOptions({ projectsDir });
    const handler = buildJobHandler(def, options);
    await handler();

    assert.equal(dispatchCount, 1, 'only dirty board should trigger dispatch');

    const entries = readRunLog(options.runsDir, def.name, 10);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.status, 'completed');
    assert.equal(entries[0]!.dispatchCount, 1);
  });

  test('empty boards config results in early return with no dispatches', async () => {
    const handlerFn = makeBoardWatcherHandler([], new Map());

    const def = {
      type: 'handler' as const,
      id: '01BOARDEMPTY000000000000000',
      name: 'board-watcher-empty',
      slug: 'board-watcher-empty',
      schedule: 'every 60m',
      enabled: true,
      singleton: true,
      handlerPath: '/tmp/handler.ts',
      settings: {},
      jobDir: '/tmp/empty',
    };

    mockLoadHandlerImpl = async () => handlerFn;

    const options = makeBridgeOptions();
    const handler = buildJobHandler(def, options);
    await handler();

    const entries = readRunLog(options.runsDir, def.name, 10);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.status, 'completed');
    assert.equal(entries[0]!.dispatchCount, 0);
  });
});
