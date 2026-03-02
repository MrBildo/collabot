import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadBots } from './bots.js';
import { scaffoldEntity, validateEntityFrontmatter } from './entity-tools.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collabot-bots-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const VALID_BOT = `---
id: 01JNQR0000HAZEL000000SEED0
version: 1.0.0
name: hazel
description: A friendly research assistant.
displayName: Hazel
---
You are Hazel, a curious and methodical research assistant.
`;

// --- loadBots ---

test('loadBots loads a valid bot definition', () => {
  fs.writeFileSync(path.join(tmpDir, 'hazel.md'), VALID_BOT);

  const bots = loadBots(tmpDir);
  assert.strictEqual(bots.size, 1);

  const bot = bots.get('hazel')!;
  assert.strictEqual(bot.id, '01JNQR0000HAZEL000000SEED0');
  assert.strictEqual(bot.name, 'hazel');
  assert.strictEqual(bot.displayName, 'Hazel');
  assert.strictEqual(bot.description, 'A friendly research assistant.');
  assert.strictEqual(bot.version, '1.0.0');
  assert.ok(bot.soulPrompt.includes('curious and methodical'));
});

test('loadBots returns empty map for missing directory', () => {
  const bots = loadBots(path.join(tmpDir, 'nonexistent'));
  assert.strictEqual(bots.size, 0);
});

test('loadBots returns empty map for empty directory', () => {
  const emptyDir = path.join(tmpDir, 'empty');
  fs.mkdirSync(emptyDir);

  const bots = loadBots(emptyDir);
  assert.strictEqual(bots.size, 0);
});

test('loadBots throws on invalid frontmatter', () => {
  const badBot = `---
id: TOOSHORT
version: 1.0.0
name: bad-bot
description: Missing valid ULID.
---
Body.
`;
  fs.writeFileSync(path.join(tmpDir, 'bad-bot.md'), badBot);

  assert.throws(() => loadBots(tmpDir), /invalid frontmatter/);
});

test('loadBots throws on missing required fields', () => {
  const incomplete = `---
id: 01JNQR0000HAZEL000000SEED0
version: 1.0.0
name: incomplete
---
Body.
`;
  fs.writeFileSync(path.join(tmpDir, 'incomplete.md'), incomplete);

  assert.throws(() => loadBots(tmpDir), /invalid frontmatter/);
});

test('loadBots loads multiple bots', () => {
  fs.writeFileSync(path.join(tmpDir, 'hazel.md'), VALID_BOT);
  fs.writeFileSync(path.join(tmpDir, 'greg.md'), `---
id: 01JNQR0000GREGX000000SEED0
version: 1.0.0
name: greg
description: A debugging specialist.
---
You are Greg, a relentless debugger.
`);

  const bots = loadBots(tmpDir);
  assert.strictEqual(bots.size, 2);
  assert.ok(bots.has('hazel'));
  assert.ok(bots.has('greg'));
});

test('loadBots skips non-md files', () => {
  fs.writeFileSync(path.join(tmpDir, 'hazel.md'), VALID_BOT);
  fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'not a bot');

  const bots = loadBots(tmpDir);
  assert.strictEqual(bots.size, 1);
});

// --- Entity tools: bot scaffolding ---

test('scaffoldEntity generates valid bot with ULID', () => {
  const result = scaffoldEntity('bot', 'test-bot', 'Author');

  assert.ok(result.id.length === 26, 'ULID should be 26 characters');
  assert.strictEqual(result.filePath, 'test-bot.md');
  assert.ok(result.content.startsWith('---'));
  assert.ok(result.content.includes(`id: ${result.id}`));
  assert.ok(result.content.includes('version: 1.0.0'));
  assert.ok(result.content.includes('name: test-bot'));
  assert.ok(result.content.includes('## Identity'));
});

test('scaffoldEntity bot does not include model-hint or createdBy', () => {
  const result = scaffoldEntity('bot', 'simple-bot', 'Author');

  assert.ok(!result.content.includes('model-hint'));
  assert.ok(!result.content.includes('createdBy'));
});

test('validateEntityFrontmatter passes for valid bot', () => {
  const result = validateEntityFrontmatter(VALID_BOT, 'bot');
  assert.strictEqual(result.valid, true);
});

test('validateEntityFrontmatter fails for bot with invalid name', () => {
  const content = `---
id: 01JNQR0000HAZEL000000SEED0
version: 1.0.0
name: Invalid_Bot
description: Bad name.
---
Body.
`;
  const result = validateEntityFrontmatter(content, 'bot');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors!.some(e => e.includes('name')));
});

test('validateEntityFrontmatter validates scaffolded bot output', () => {
  const scaffold = scaffoldEntity('bot', 'round-trip-bot', 'Author');
  const result = validateEntityFrontmatter(scaffold.content, 'bot');
  assert.strictEqual(result.valid, true, `Scaffolded bot should validate. Errors: ${result.errors?.join(', ')}`);
});
