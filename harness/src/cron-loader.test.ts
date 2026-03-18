import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseJobFolder } from './cron-loader.js';

function makeTempJobDir(slug: string, files: Record<string, string>): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-loader-test-'));
  const jobDir = path.join(base, slug);
  fs.mkdirSync(jobDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(jobDir, name), content, 'utf-8');
  }
  return jobDir;
}

describe('parseJobFolder', () => {
  test('parses a simple agent job', () => {
    const jobDir = makeTempJobDir('research-check', {
      'job.md': [
        '---',
        'name: research-check',
        'schedule: "0 9 * * MON-FRI"',
        'role: researcher',
        'project: research-lab',
        '---',
        '',
        'Check the Research Lab board for new cards.',
      ].join('\n'),
    });

    const job = parseJobFolder(jobDir, 'research-check');

    assert.equal(job.type, 'agent');
    assert.equal(job.name, 'research-check');
    assert.equal(job.slug, 'research-check');
    assert.equal(job.schedule, '0 9 * * MON-FRI');
    assert.equal(job.enabled, true);
    assert.equal(job.singleton, true);
    if (job.type === 'agent') {
      assert.equal(job.role, 'researcher');
      assert.equal(job.project, 'research-lab');
      assert.equal(job.prompt, 'Check the Research Lab board for new cards.');
    }
    assert.ok(job.id.length === 26, 'should auto-generate ULID id');
  });

  test('parses agent job with explicit id and constraints', () => {
    const jobDir = makeTempJobDir('standup', {
      'job.md': [
        '---',
        'id: 01KM1GXPS3Q0AGB45YRTE6T1YT',
        'name: collabot-standup',
        'schedule: "0 9 * * MON-FRI"',
        'bot: hazel',
        'role: researcher',
        'project: lobby',
        'tokenBudget: 100000',
        'maxTurns: 5',
        '---',
        '',
        'Generate a daily standup report.',
      ].join('\n'),
    });

    const job = parseJobFolder(jobDir, 'standup');

    assert.equal(job.type, 'agent');
    assert.equal(job.id, '01KM1GXPS3Q0AGB45YRTE6T1YT');
    assert.equal(job.bot, 'hazel');
    if (job.type === 'agent') {
      assert.equal(job.tokenBudget, 100000);
      assert.equal(job.maxTurns, 5);
    }
  });

  test('parses a handler job with settings.toml', () => {
    const jobDir = makeTempJobDir('board-watcher', {
      'job.md': [
        '---',
        'name: board-watcher',
        'schedule: "*/30 9-17 * * MON-FRI"',
        'handler: true',
        'role: researcher',
        'singleton: true',
        '---',
      ].join('\n'),
      'handler.ts': 'export default async function(ctx: any) { /* noop */ }',
      'settings.toml': [
        '[[boards]]',
        'slug = "research-lab"',
        'project = "research-lab"',
        '',
        '[[boards]]',
        'slug = "collabot"',
        'project = "lobby"',
      ].join('\n'),
    });

    const job = parseJobFolder(jobDir, 'board-watcher');

    assert.equal(job.type, 'handler');
    assert.equal(job.name, 'board-watcher');
    assert.equal(job.schedule, '*/30 9-17 * * MON-FRI');
    assert.equal(job.singleton, true);
    if (job.type === 'handler') {
      assert.ok(job.handlerPath.endsWith('handler.ts'));
      assert.ok(Array.isArray((job.settings as Record<string, unknown>).boards));
      const boards = (job.settings as Record<string, unknown>).boards as Array<Record<string, string>>;
      assert.equal(boards.length, 2);
      assert.equal(boards[0]!.slug, 'research-lab');
    }
  });

  test('rejects handler job without handler.ts', () => {
    const jobDir = makeTempJobDir('bad-handler', {
      'job.md': [
        '---',
        'name: bad-handler',
        'schedule: "0 * * * *"',
        'handler: true',
        '---',
      ].join('\n'),
    });

    assert.throws(
      () => parseJobFolder(jobDir, 'bad-handler'),
      /handler.ts not found/,
    );
  });

  test('rejects agent job without prompt body', () => {
    const jobDir = makeTempJobDir('no-prompt', {
      'job.md': [
        '---',
        'name: no-prompt',
        'schedule: "0 * * * *"',
        'role: researcher',
        'project: lobby',
        '---',
      ].join('\n'),
    });

    assert.throws(
      () => parseJobFolder(jobDir, 'no-prompt'),
      /agent job must have a prompt body/,
    );
  });

  test('rejects agent job without required role', () => {
    const jobDir = makeTempJobDir('no-role', {
      'job.md': [
        '---',
        'name: no-role',
        'schedule: "0 * * * *"',
        'project: lobby',
        '---',
        '',
        'Do something.',
      ].join('\n'),
    });

    assert.throws(
      () => parseJobFolder(jobDir, 'no-role'),
      /invalid agent job frontmatter/,
    );
  });

  test('defaults enabled=true and singleton=true', () => {
    const jobDir = makeTempJobDir('defaults', {
      'job.md': [
        '---',
        'name: defaults-test',
        'schedule: "0 * * * *"',
        'role: researcher',
        'project: lobby',
        '---',
        '',
        'Test defaults.',
      ].join('\n'),
    });

    const job = parseJobFolder(jobDir, 'defaults');
    assert.equal(job.enabled, true);
    assert.equal(job.singleton, true);
  });

  test('disabled job parses correctly', () => {
    const jobDir = makeTempJobDir('disabled', {
      'job.md': [
        '---',
        'name: disabled-job',
        'schedule: "0 * * * *"',
        'role: researcher',
        'project: lobby',
        'enabled: false',
        '---',
        '',
        'I am disabled.',
      ].join('\n'),
    });

    const job = parseJobFolder(jobDir, 'disabled');
    assert.equal(job.enabled, false);
  });

  test('rejects invalid settings.toml', () => {
    const jobDir = makeTempJobDir('bad-settings', {
      'job.md': [
        '---',
        'name: bad-settings',
        'schedule: "0 * * * *"',
        'handler: true',
        '---',
      ].join('\n'),
      'handler.ts': 'export default async function() {}',
      'settings.toml': 'this is not valid toml {{{{',
    });

    assert.throws(
      () => parseJobFolder(jobDir, 'bad-settings'),
      /failed to parse/,
    );
  });
});
