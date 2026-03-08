import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listTemplates, stampAndCopyEntity, patchEnvFile } from './setup.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collabot-setup-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── listTemplates ────────────────────────────────────────────

test('listTemplates("roles") returns role templates', () => {
  const roles = listTemplates('roles');
  assert.ok(roles.length >= 4, `expected >= 4 roles, got ${roles.length}`);

  const names = roles.map((r) => r.name);
  assert.ok(names.includes('assistant'), 'should include assistant');
  assert.ok(names.includes('researcher'), 'should include researcher');
  assert.ok(names.includes('dotnet-dev'), 'should include dotnet-dev');
  assert.ok(names.includes('ts-dev'), 'should include ts-dev');
});

test('listTemplates("bots") returns bot templates', () => {
  const bots = listTemplates('bots');
  assert.ok(bots.length >= 5, `expected >= 5 bots, got ${bots.length}`);

  const names = bots.map((b) => b.name);
  assert.ok(names.includes('agent'), 'should include agent');
  assert.ok(names.includes('cheerful'), 'should include cheerful');
  assert.ok(names.includes('methodical'), 'should include methodical');
  assert.ok(names.includes('concise'), 'should include concise');
  assert.ok(names.includes('cautious'), 'should include cautious');
});

test('listTemplates returns displayName and description from frontmatter', () => {
  const roles = listTemplates('roles');
  const assistant = roles.find((r) => r.name === 'assistant');
  assert.ok(assistant);
  assert.strictEqual(assistant.displayName, 'Assistant');
  assert.ok(assistant.description.length > 0, 'should have a description');
});

// ── stampAndCopyEntity ───────────────────────────────────────

test('stampAndCopyEntity copies role with stamped frontmatter', () => {
  // Create target dirs
  fs.mkdirSync(path.join(tmpDir, 'roles'), { recursive: true });

  stampAndCopyEntity('roles', 'assistant.md', tmpDir);

  const content = fs.readFileSync(path.join(tmpDir, 'roles', 'assistant.md'), 'utf8');
  assert.ok(content.startsWith('---'), 'should start with frontmatter');
  assert.ok(content.includes('id: 01'), 'should have ULID id');
  assert.ok(content.includes('version: 1.0.0'), 'should have version');
  assert.ok(content.includes('createdOn:'), 'role should have createdOn');
  assert.ok(content.includes('createdBy: collabot setup'), 'role should have createdBy');
  assert.ok(content.includes('name: assistant'), 'should preserve original name');
});

test('stampAndCopyEntity copies bot with stamped frontmatter (no createdOn/By)', () => {
  fs.mkdirSync(path.join(tmpDir, 'bots'), { recursive: true });

  stampAndCopyEntity('bots', 'agent.md', tmpDir);

  const content = fs.readFileSync(path.join(tmpDir, 'bots', 'agent.md'), 'utf8');
  assert.ok(content.includes('id: 01'), 'should have ULID id');
  assert.ok(content.includes('version: 1.0.0'), 'should have version');
  assert.ok(!content.includes('createdOn:'), 'bot should NOT have createdOn');
  assert.ok(!content.includes('createdBy:'), 'bot should NOT have createdBy');
});

test('stampAndCopyEntity produces unique IDs for each call', () => {
  fs.mkdirSync(path.join(tmpDir, 'roles'), { recursive: true });

  stampAndCopyEntity('roles', 'assistant.md', tmpDir);
  const content1 = fs.readFileSync(path.join(tmpDir, 'roles', 'assistant.md'), 'utf8');

  // Overwrite with second stamp
  stampAndCopyEntity('roles', 'assistant.md', tmpDir);
  const content2 = fs.readFileSync(path.join(tmpDir, 'roles', 'assistant.md'), 'utf8');

  // Extract IDs
  const id1 = content1.match(/id: (01[A-Z0-9]+)/)?.[1];
  const id2 = content2.match(/id: (01[A-Z0-9]+)/)?.[1];
  assert.ok(id1, 'first file should have id');
  assert.ok(id2, 'second file should have id');
  assert.notStrictEqual(id1, id2, 'IDs should be different');
});

// ── patchEnvFile ─────────────────────────────────────────────

test('patchEnvFile sets existing key', () => {
  const envFile = path.join(tmpDir, '.env');
  fs.writeFileSync(envFile, 'ANTHROPIC_API_KEY=\nOTHER=value\n');

  patchEnvFile(envFile, 'ANTHROPIC_API_KEY', 'sk-test-123');

  const result = fs.readFileSync(envFile, 'utf8');
  assert.ok(result.includes('ANTHROPIC_API_KEY=sk-test-123'), 'should set value');
  assert.ok(result.includes('OTHER=value'), 'should preserve other keys');
});

test('patchEnvFile uncomments and sets commented key', () => {
  const envFile = path.join(tmpDir, '.env');
  fs.writeFileSync(envFile, '# GREG_BOT_TOKEN=xoxb-...\n');

  patchEnvFile(envFile, 'GREG_BOT_TOKEN', 'xoxb-real-token');

  const result = fs.readFileSync(envFile, 'utf8');
  assert.ok(result.includes('GREG_BOT_TOKEN=xoxb-real-token'), 'should uncomment and set');
  assert.ok(!result.includes('# GREG_BOT_TOKEN'), 'should not have commented version');
});

test('patchEnvFile appends new key if not present', () => {
  const envFile = path.join(tmpDir, '.env');
  fs.writeFileSync(envFile, 'EXISTING=value\n');

  patchEnvFile(envFile, 'NEW_KEY', 'new-value');

  const result = fs.readFileSync(envFile, 'utf8');
  assert.ok(result.includes('NEW_KEY=new-value'), 'should append new key');
  assert.ok(result.includes('EXISTING=value'), 'should preserve existing');
});
