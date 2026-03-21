import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readRunLog } from './cron-bridge.js';
import type { RunLogEntry } from './cron-bridge.js';

describe('Run log persistence', () => {
  test('readRunLog returns empty array when no log exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-bridge-'));
    const entries = readRunLog(tmpDir, 'nonexistent', 10);
    assert.deepStrictEqual(entries, []);
  });

  test('readRunLog reads JSONL entries', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-bridge-'));
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-bridge-'));
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-bridge-'));
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
    // Verify the bridge options type accepts the callback.
    // The actual invocation happens inside the handler closure (which calls collabDispatch),
    // so we verify the contract at the type/wiring level.
    const { buildJobHandler } = await import('./cron-bridge.js');
    const { AgentPool } = await import('./pool.js');

    let getLastRunAtCalled = false;
    const options = {
      ctx: {
        config: {} as any,
        roles: new Map(),
        bots: new Map(),
        projects: new Map(),
        projectsDir: '/tmp',
        pool: new AgentPool(),
      },
      runsDir: '/tmp/runs',
      projectsDir: '/tmp/.projects',
      getLastRunAt: (name: string) => {
        getLastRunAtCalled = true;
        return '2026-03-18T10:00:00.000Z';
      },
    };

    // Building the handler should succeed (the callback is stored, not called yet)
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
    // getLastRunAt is only called when the handler fires (which requires collabDispatch),
    // so we just verify the callback was accepted without error.
    assert.equal(getLastRunAtCalled, false, 'callback should not be called at build time');
  });
});
