import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInit } from './init.js';

// runInit reads COLLABOT_HOME to resolve target
function runInitInDir(targetDir: string): void {
  const prevHome = process.env.COLLABOT_HOME;
  process.env.COLLABOT_HOME = targetDir;

  // Mock process.exit to prevent test runner from dying
  const exitMock = mock.fn((_code?: number) => { throw new Error('process.exit called'); });
  const originalExit = process.exit;
  process.exit = exitMock as unknown as typeof process.exit;

  // Suppress console output during tests
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};

  try {
    runInit();
  } finally {
    process.env.COLLABOT_HOME = prevHome;
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
  }
}

// ── Directory structure ──────────────────────────────────────

test('runInit creates expected directories', () => {
  const targetDir = path.join(os.tmpdir(), `collabot-init-test-${Date.now()}`);
  try {
    runInitInDir(targetDir);

    // Directories that SHOULD exist
    assert.ok(fs.existsSync(path.join(targetDir, 'prompts')), 'prompts/ should exist');
    assert.ok(fs.existsSync(path.join(targetDir, 'roles')), 'roles/ should exist');
    assert.ok(fs.existsSync(path.join(targetDir, 'bots')), 'bots/ should exist');
    assert.ok(fs.existsSync(path.join(targetDir, '.projects')), '.projects/ should exist');

    // Directories that should NOT exist
    assert.ok(!fs.existsSync(path.join(targetDir, 'skills')), 'skills/ should not exist');
    assert.ok(!fs.existsSync(path.join(targetDir, 'docs')), 'docs/ should not exist');
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('runInit creates expected files', () => {
  const targetDir = path.join(os.tmpdir(), `collabot-init-test-${Date.now()}`);
  try {
    runInitInDir(targetDir);

    // Files that SHOULD exist
    assert.ok(fs.existsSync(path.join(targetDir, 'config.toml')), 'config.toml should exist');
    assert.ok(fs.existsSync(path.join(targetDir, '.env')), '.env should exist');
    assert.ok(fs.existsSync(path.join(targetDir, 'prompts', 'system.md')), 'prompts/system.md should exist');

    // Files that should NOT exist (no starter role/bot/tools.md)
    assert.ok(!fs.existsSync(path.join(targetDir, 'prompts', 'tools.md')), 'prompts/tools.md should not exist');
    const roleFiles = fs.readdirSync(path.join(targetDir, 'roles'));
    assert.strictEqual(roleFiles.length, 0, 'roles/ should be empty');
    const botFiles = fs.readdirSync(path.join(targetDir, 'bots'));
    assert.strictEqual(botFiles.length, 0, 'bots/ should be empty');
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('runInit .env contains ANTHROPIC_API_KEY', () => {
  const targetDir = path.join(os.tmpdir(), `collabot-init-test-${Date.now()}`);
  try {
    runInitInDir(targetDir);

    const env = fs.readFileSync(path.join(targetDir, '.env'), 'utf8');
    assert.ok(env.includes('ANTHROPIC_API_KEY'), '.env should have API key placeholder');
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('runInit config.toml has routing, models, and ws sections', () => {
  const targetDir = path.join(os.tmpdir(), `collabot-init-test-${Date.now()}`);
  try {
    runInitInDir(targetDir);

    const config = fs.readFileSync(path.join(targetDir, 'config.toml'), 'utf8');
    assert.ok(config.includes('[routing]'), 'config should have routing section');
    assert.ok(config.includes('[models]'), 'config should have models section');
    assert.ok(config.includes('[ws]'), 'config should have ws section');
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('runInit system.md mentions Collabot', () => {
  const targetDir = path.join(os.tmpdir(), `collabot-init-test-${Date.now()}`);
  try {
    runInitInDir(targetDir);

    const systemPrompt = fs.readFileSync(path.join(targetDir, 'prompts', 'system.md'), 'utf8');
    assert.ok(systemPrompt.includes('Collabot'), 'system prompt should mention Collabot');
    assert.ok(systemPrompt.length > 100, 'system prompt should be substantive');
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});
