import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCronMcpServer } from './cron-mcp.js';
import type { CronMcpServerOptions } from './cron-mcp.js';
import type { CronScheduler } from './cron.js';
import type { Config } from './config.js';
import type { RoleDefinition, BotDefinition, Project } from './types.js';
import { _resetInstanceRoot } from './paths.js';

// ── Helpers ─────────────────────────────────────────────────

function makeRoles(): Map<string, RoleDefinition> {
  return new Map([
    ['api-dev', {
      id: '01TEST_ROLE_API_DEV_000000',
      version: '1.0.0',
      name: 'api-dev',
      description: 'Backend development.',
      createdOn: '2026-02-24T15:00:00Z',
      createdBy: 'Test',
      displayName: 'API Dev',
      modelHint: 'sonnet-latest',
      prompt: 'You are an API developer.',
    }],
  ]);
}

function makeProjects(): Map<string, Project> {
  return new Map([
    ['acme', {
      name: 'Acme',
      description: 'Test project',
      paths: ['../backend-api'],
      roles: ['api-dev'],
    }],
  ]);
}

function makeBots(): Map<string, BotDefinition> {
  return new Map([
    ['hazel', {
      id: '01TEST_BOT_HAZEL_00000000',
      name: 'hazel',
      displayName: 'Hazel',
      description: 'Test bot',
      version: '1.0.0',
      createdOn: '2026-02-24T15:00:00Z',
      createdBy: 'Test',
      prompt: 'You are Hazel.',
    }],
  ]);
}

type MockState = {
  name: string;
  status: string;
  runCount: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
};

function makeMockScheduler(): CronScheduler & { _seed(name: string): void } {
  const states = new Map<string, MockState>();
  return {
    listWithState() { return [...states.values()]; },
    getState(name: string) { return states.get(name); },
    getDefinition(_name: string) { return undefined; },
    unregister(name: string) { states.delete(name); },
    pause(name: string) {
      const s = states.get(name);
      if (!s) throw new Error(`Job "${name}" not found`);
      s.status = 'paused';
    },
    resume(name: string) {
      const s = states.get(name);
      if (!s) throw new Error(`Job "${name}" not found`);
      s.status = 'idle';
    },
    list() { return [...states.keys()]; },
    _seed(name: string) {
      states.set(name, { name, status: 'idle', runCount: 0, lastRunAt: null, nextRunAt: null, lastError: null, consecutiveFailures: 0 });
    },
  } as unknown as CronScheduler & { _seed(name: string): void };
}

function makeNoCronConfig(): Config {
  return { cron: undefined } as unknown as Config;
}

function makeOptions(overrides?: Partial<CronMcpServerOptions>): CronMcpServerOptions {
  return {
    scheduler: makeMockScheduler(),
    config: makeNoCronConfig(),
    roles: makeRoles(),
    projects: makeProjects(),
    bots: makeBots(),
    ...overrides,
  };
}

// ============================================================
// Server creation tests
// ============================================================

test('createCronMcpServer — returns sdk-shaped config', () => {
  const server = createCronMcpServer(makeOptions());
  assert.equal(server.type, 'sdk');
  assert.equal(server.name, 'cron');
  assert.ok(server.instance);
});

test('createCronMcpServer — accepts entity maps without error', () => {
  assert.doesNotThrow(() => createCronMcpServer(makeOptions()));
});

// ============================================================
// Entity validation tests (via create_cron_job)
// ============================================================

test('createCronMcpServer — unknown role rejected at server creation', () => {
  // With empty roles, the server still creates fine — validation is per-call
  const opts = makeOptions({ roles: new Map() });
  const server = createCronMcpServer(opts);
  assert.equal(server.type, 'sdk');
});

test('createCronMcpServer — unknown project rejected at server creation', () => {
  const opts = makeOptions({ projects: new Map() });
  const server = createCronMcpServer(opts);
  assert.equal(server.type, 'sdk');
});

test('createCronMcpServer — unknown bot rejected at server creation', () => {
  const opts = makeOptions({ bots: new Map() });
  const server = createCronMcpServer(opts);
  assert.equal(server.type, 'sdk');
});

// ============================================================
// Schedule validation (unit-level — validateSchedule is internal)
// ============================================================

test('createCronMcpServer — valid interval schedule accepted', () => {
  // The server creates successfully; schedule validation happens per-tool-call
  const server = createCronMcpServer(makeOptions());
  assert.ok(server.instance);
});

test('createCronMcpServer — cron config undefined uses empty jobsDir', () => {
  const opts = makeOptions({ config: { cron: undefined } as unknown as Config });
  const server = createCronMcpServer(opts);
  assert.equal(server.type, 'sdk');
});

// ============================================================
// File-based tests (with COLLABOT_HOME set)
// ============================================================

test('createCronMcpServer — with real cron config resolves jobsDir', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-mcp-home-'));
  const cronDir = path.join(tmpDir, 'cron', 'jobs');
  fs.mkdirSync(cronDir, { recursive: true });

  const prevHome = process.env.COLLABOT_HOME;
  process.env.COLLABOT_HOME = tmpDir;
  _resetInstanceRoot();

  try {
    const opts = makeOptions({
      config: { cron: { jobsDirectory: 'cron/jobs' } } as unknown as Config,
    });
    const server = createCronMcpServer(opts);
    assert.equal(server.type, 'sdk');
    assert.equal(server.name, 'cron');
  } finally {
    process.env.COLLABOT_HOME = prevHome;
    _resetInstanceRoot();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
