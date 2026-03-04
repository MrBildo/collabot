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

test('runInit creates complete directory structure', () => {
  const targetDir = path.join(os.tmpdir(), `collabot-init-test-${Date.now()}`);
  try {
    runInitInDir(targetDir);

    // Core directories
    assert.ok(fs.existsSync(path.join(targetDir, 'prompts')), 'prompts/ should exist');
    assert.ok(fs.existsSync(path.join(targetDir, 'roles')), 'roles/ should exist');
    assert.ok(fs.existsSync(path.join(targetDir, 'bots')), 'bots/ should exist');
    assert.ok(fs.existsSync(path.join(targetDir, 'skills')), 'skills/ should exist');
    assert.ok(fs.existsSync(path.join(targetDir, '.projects')), '.projects/ should exist');
    assert.ok(fs.existsSync(path.join(targetDir, 'docs')), 'docs/ should exist');

    // Core files
    assert.ok(fs.existsSync(path.join(targetDir, 'config.toml')), 'config.toml should exist');
    assert.ok(fs.existsSync(path.join(targetDir, '.env')), '.env should exist');
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('runInit creates starter role that parses correctly', () => {
  const targetDir = path.join(os.tmpdir(), `collabot-init-test-${Date.now()}`);
  try {
    runInitInDir(targetDir);

    const roleContent = fs.readFileSync(path.join(targetDir, 'roles', 'researcher.md'), 'utf8');
    assert.ok(roleContent.includes('name: researcher'), 'role should have name field');
    assert.ok(roleContent.includes('model-hint: sonnet-latest'), 'role should have model-hint');
    assert.ok(roleContent.includes('displayName: Researcher'), 'role should have displayName');
    assert.ok(roleContent.startsWith('---'), 'should start with frontmatter delimiter');
    assert.ok(roleContent.indexOf('---', 3) > 3, 'should have closing frontmatter delimiter');
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('runInit creates starter bot that parses correctly', () => {
  const targetDir = path.join(os.tmpdir(), `collabot-init-test-${Date.now()}`);
  try {
    runInitInDir(targetDir);

    const botContent = fs.readFileSync(path.join(targetDir, 'bots', 'hazel.md'), 'utf8');
    assert.ok(botContent.includes('name: hazel'), 'bot should have name field');
    assert.ok(botContent.includes('displayName: Hazel'), 'bot should have displayName');
    assert.ok(botContent.startsWith('---'), 'should start with frontmatter delimiter');
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('runInit creates substantive prompts', () => {
  const targetDir = path.join(os.tmpdir(), `collabot-init-test-${Date.now()}`);
  try {
    runInitInDir(targetDir);

    const systemPrompt = fs.readFileSync(path.join(targetDir, 'prompts', 'system.md'), 'utf8');
    assert.ok(systemPrompt.includes('Collabot'), 'system prompt should mention Collabot');
    assert.ok(systemPrompt.length > 100, 'system prompt should be substantive');

    const toolsPrompt = fs.readFileSync(path.join(targetDir, 'prompts', 'tools.md'), 'utf8');
    assert.ok(toolsPrompt.includes('list_projects'), 'tools prompt should document MCP tools');
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('runInit creates instance docs', () => {
  const targetDir = path.join(os.tmpdir(), `collabot-init-test-${Date.now()}`);
  try {
    runInitInDir(targetDir);

    const docs = ['getting-started.md', 'roles.md', 'bots.md', 'projects.md'];
    for (const doc of docs) {
      const filePath = path.join(targetDir, 'docs', doc);
      assert.ok(fs.existsSync(filePath), `docs/${doc} should exist`);
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(content.length > 50, `docs/${doc} should have substantive content`);
    }
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('runInit .env template has clear sections', () => {
  const targetDir = path.join(os.tmpdir(), `collabot-init-test-${Date.now()}`);
  try {
    runInitInDir(targetDir);

    const env = fs.readFileSync(path.join(targetDir, '.env'), 'utf8');
    assert.ok(env.includes('ANTHROPIC_API_KEY'), '.env should have API key placeholder');
    assert.ok(env.includes('CLAUDE_EXECUTABLE_PATH'), '.env should have Claude path');
    assert.ok(env.includes('CLAUDE_CODE_GIT_BASH_PATH'), '.env should have git bash path');
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('runInit config.toml has routing section', () => {
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
