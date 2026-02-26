import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from './roles.js';

// ============================================================
// parseFrontmatter — basic parsing (unchanged, format-agnostic)
// ============================================================

const VALID_ROLE_V2 = `---
id: 01HXYZ01234567890ABCDEFGH
version: 1.0.0
name: ts-dev
description: TypeScript development and maintenance.
createdOn: "2026-02-24T15:00:00Z"
createdBy: Bill Wheelock
displayName: TS Developer
model-hint: sonnet-latest
---
You are a TypeScript developer. You build, test, and maintain TypeScript applications.
`;

test('valid v2 frontmatter + body splits correctly', () => {
  const { frontmatter, body } = parseFrontmatter(VALID_ROLE_V2, 'ts-dev.md');
  const fm = frontmatter as Record<string, unknown>;
  assert.strictEqual(fm['name'], 'ts-dev');
  assert.strictEqual(fm['description'], 'TypeScript development and maintenance.');
  assert.strictEqual(fm['model-hint'], 'sonnet-latest');
  assert.strictEqual(fm['id'], '01HXYZ01234567890ABCDEFGH');
  assert.strictEqual(fm['version'], '1.0.0');
  assert.strictEqual(fm['createdBy'], 'Bill Wheelock');
  assert.ok(body.includes('You are a TypeScript developer'));
});

test('missing closing --- throws', () => {
  const content = `---
id: 01HXYZ01234567890ABCDEFGH
version: 1.0.0
name: ts-dev
description: TypeScript dev.
createdOn: "2026-02-24T15:00:00Z"
createdBy: Bill Wheelock
model-hint: sonnet-latest
You forgot to close the frontmatter
`;
  assert.throws(
    () => parseFrontmatter(content, 'bad.md'),
    /closing --- not found/,
  );
});

test('missing opening --- throws', () => {
  const content = `name: ts-dev
description: TypeScript dev.
model-hint: sonnet-latest
---
body here
`;
  assert.throws(
    () => parseFrontmatter(content, 'bad.md'),
    /missing YAML frontmatter/,
  );
});

test('v2 frontmatter with permissions parses correctly', () => {
  const content = `---
id: 01HXYZ01234567890ABCDEFGH
version: 1.0.0
name: product-analyst
description: Coordination, analysis, and multi-agent dispatch.
createdOn: "2026-02-24T15:00:00Z"
createdBy: Bill Wheelock
displayName: Product Analyst
model-hint: opus-latest
permissions: [agent-draft, projects-list, projects-create]
---
You are the Product Analyst.
`;
  const { frontmatter, body } = parseFrontmatter(content, 'product-analyst.md');
  const fm = frontmatter as Record<string, unknown>;
  assert.strictEqual(fm['name'], 'product-analyst');
  assert.strictEqual(fm['model-hint'], 'opus-latest');
  assert.deepStrictEqual(fm['permissions'], ['agent-draft', 'projects-list', 'projects-create']);
  assert.ok(body.includes('Product Analyst'));
});

test('v2 frontmatter with optional fields parses correctly', () => {
  const content = `---
id: 01HXYZ01234567890ABCDEFGH
version: 1.2.0
name: dotnet-dev
description: .NET/C# backend development.
createdOn: "2026-02-24T15:00:00Z"
createdBy: Bill Wheelock
updatedOn: "2026-02-25T10:00:00Z"
updatedBy: Bot Greg
displayName: .NET Developer
model-hint: sonnet-latest
metadata:
  stack: dotnet
  tier: coding
---
You are a .NET developer.
`;
  const { frontmatter } = parseFrontmatter(content, 'dotnet-dev.md');
  const fm = frontmatter as Record<string, unknown>;
  assert.strictEqual(fm['updatedBy'], 'Bot Greg');
  assert.deepStrictEqual(fm['metadata'], { stack: 'dotnet', tier: 'coding' });
});
