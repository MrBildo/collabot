import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from './roles.js';

const VALID_ROLE = `---
name: api-dev
displayName: API Developer
category: api
model: claude-sonnet-4-6
---
You are a backend developer working in .NET/C# projects.
`;

test('valid frontmatter + body splits correctly with all fields populated', () => {
  const { frontmatter, body } = parseFrontmatter(VALID_ROLE, 'api-dev.md');
  const fm = frontmatter as Record<string, unknown>;
  assert.strictEqual(fm['name'], 'api-dev');
  assert.strictEqual(fm['displayName'], 'API Developer');
  assert.strictEqual(fm['category'], 'api');
  assert.strictEqual(fm['model'], 'claude-sonnet-4-6');
  assert.ok(body.includes('You are a backend developer'));
});

test('missing closing --- throws', () => {
  const content = `---
name: api-dev
displayName: API Developer
category: api
You forgot to close the frontmatter
`;
  assert.throws(
    () => parseFrontmatter(content, 'bad.md'),
    /closing --- not found/,
  );
});

test('missing opening --- throws', () => {
  const content = `name: api-dev
displayName: API Developer
category: api
---
body here
`;
  assert.throws(
    () => parseFrontmatter(content, 'bad.md'),
    /missing YAML frontmatter/,
  );
});

test('product-analyst role parses with cwd and category', () => {
  const content = `---
name: product-analyst
displayName: Product Analyst
category: conversational
cwd: ../
---
You are the Product Analyst.
`;
  const { frontmatter, body } = parseFrontmatter(content, 'product-analyst.md');
  const fm = frontmatter as Record<string, unknown>;
  assert.strictEqual(fm['name'], 'product-analyst');
  assert.strictEqual(fm['displayName'], 'Product Analyst');
  assert.strictEqual(fm['category'], 'conversational');
  assert.strictEqual(fm['cwd'], '../');
  assert.ok(body.includes('Product Analyst'));
});
