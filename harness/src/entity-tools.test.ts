import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scaffoldEntity, validateEntityFrontmatter, validateLinks } from './entity-tools.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'entity-tools-test-'));
}

// --- scaffoldEntity ---

test('scaffoldEntity generates valid role with ULID and timestamps', () => {
  const result = scaffoldEntity('role', 'my-test-role', 'Test Author');

  assert.ok(result.id.length === 26, 'ULID should be 26 characters');
  assert.strictEqual(result.filePath, 'my-test-role.md');
  assert.ok(result.content.startsWith('---'));
  assert.ok(result.content.includes(`id: ${result.id}`));
  assert.ok(result.content.includes('version: 1.0.0'));
  assert.ok(result.content.includes('name: my-test-role'));
  assert.ok(result.content.includes('createdBy: Test Author'));
  assert.ok(result.content.includes('model-hint: sonnet-latest'));
});

test('scaffoldEntity includes human-readable date comment', () => {
  const result = scaffoldEntity('role', 'date-test', 'Author');

  // createdOn line should have a # comment with MM/DD/YYYY format
  const match = result.content.match(/createdOn: "(.+?)"\s+# (\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2} [AP]M)/);
  assert.ok(match, 'createdOn should have RFC 3339 value and human-readable comment');
});

test('scaffoldEntity includes role body template', () => {
  const result = scaffoldEntity('role', 'body-test', 'Author');

  assert.ok(result.content.includes('## How You Work'));
  assert.ok(result.content.includes('## Practices'));
  assert.ok(result.content.includes('Read the task spec or prompt carefully'));
});

test('scaffoldEntity generates unique IDs per call', () => {
  const a = scaffoldEntity('role', 'role-a', 'Author');
  const b = scaffoldEntity('role', 'role-b', 'Author');
  assert.notStrictEqual(a.id, b.id);
});

test('scaffoldEntity throws for unknown entity type', () => {
  assert.throws(
    () => scaffoldEntity('widget' as any, 'test', 'Author'),
    /Unknown entity type: widget/,
  );
});

// --- validateEntityFrontmatter ---

test('validateEntityFrontmatter passes for valid role', () => {
  const content = `---
id: 01HXYZ01234567890ABCDEFGHI
version: 1.0.0
name: ts-dev
description: TypeScript development.
createdOn: "2026-02-24T15:00:00Z"
createdBy: Bill Wheelock
model-hint: sonnet-latest
---
Body text here.
`;
  const result = validateEntityFrontmatter(content, 'role');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.errors, undefined);
});

test('validateEntityFrontmatter fails for missing required fields', () => {
  const content = `---
id: 01HXYZ01234567890ABCDEFGHI
version: 1.0.0
name: test-role
---
Body.
`;
  const result = validateEntityFrontmatter(content, 'role');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors!.length > 0);
});

test('validateEntityFrontmatter fails for invalid name', () => {
  const content = `---
id: 01HXYZ01234567890ABCDEFGHI
version: 1.0.0
name: Invalid_Name
description: A role with a bad name.
createdOn: "2026-02-24T15:00:00Z"
createdBy: Author
model-hint: sonnet-latest
---
Body.
`;
  const result = validateEntityFrontmatter(content, 'role');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors!.some(e => e.includes('name')));
});

test('validateEntityFrontmatter fails for invalid model-hint', () => {
  const content = `---
id: 01HXYZ01234567890ABCDEFGHI
version: 1.0.0
name: bad-model
description: A role with a bad model hint.
createdOn: "2026-02-24T15:00:00Z"
createdBy: Author
model-hint: gpt-4
---
Body.
`;
  const result = validateEntityFrontmatter(content, 'role');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors!.some(e => e.includes('model-hint')));
});

test('validateEntityFrontmatter fails for bad ULID length', () => {
  const content = `---
id: TOOSHORT
version: 1.0.0
name: bad-id
description: A role with a bad ID.
createdOn: "2026-02-24T15:00:00Z"
createdBy: Author
model-hint: sonnet-latest
---
Body.
`;
  const result = validateEntityFrontmatter(content, 'role');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors!.some(e => e.includes('id')));
});

test('validateEntityFrontmatter fails for missing frontmatter delimiters', () => {
  const content = `No frontmatter here.`;
  const result = validateEntityFrontmatter(content, 'role');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors!.some(e => e.includes('frontmatter')));
});

test('validateEntityFrontmatter validates scaffolded output', () => {
  const scaffold = scaffoldEntity('role', 'round-trip', 'Author');
  const result = validateEntityFrontmatter(scaffold.content, 'role');
  assert.strictEqual(result.valid, true, `Scaffolded role should validate. Errors: ${result.errors?.join(', ')}`);
});

test('validateEntityFrontmatter accepts valid permissions', () => {
  const content = `---
id: 01HXYZ01234567890ABCDEFGHI
version: 1.0.0
name: perm-role
description: A role with permissions.
createdOn: "2026-02-24T15:00:00Z"
createdBy: Author
model-hint: opus-latest
permissions: [agent-draft, projects-list]
---
Body.
`;
  const result = validateEntityFrontmatter(content, 'role');
  assert.strictEqual(result.valid, true);
});

test('validateEntityFrontmatter rejects invalid permissions', () => {
  const content = `---
id: 01HXYZ01234567890ABCDEFGHI
version: 1.0.0
name: bad-perm
description: A role with bad permissions.
createdOn: "2026-02-24T15:00:00Z"
createdBy: Author
model-hint: sonnet-latest
permissions: [sudo-all]
---
Body.
`;
  const result = validateEntityFrontmatter(content, 'role');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors!.some(e => e.includes('permissions')));
});

// --- validateLinks ---

test('validateLinks passes when all links resolve', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'target.md'), '# Target');

  const content = `See [target](target.md) for details.`;
  const result = validateLinks(content, dir);
  assert.strictEqual(result.valid, true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('validateLinks reports broken relative links', () => {
  const dir = tmpDir();

  const content = `See [missing](does-not-exist.md) for details.`;
  const result = validateLinks(content, dir);
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(result.broken, ['does-not-exist.md']);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('validateLinks skips URLs', () => {
  const dir = tmpDir();

  const content = `See [docs](https://example.com/docs) and [spec](http://example.com/spec).`;
  const result = validateLinks(content, dir);
  assert.strictEqual(result.valid, true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('validateLinks skips anchor-only links', () => {
  const dir = tmpDir();

  const content = `See [section](#heading) for details.`;
  const result = validateLinks(content, dir);
  assert.strictEqual(result.valid, true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('validateLinks handles links with anchors', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'doc.md'), '# Doc');

  const content = `See [section](doc.md#heading) for details.`;
  const result = validateLinks(content, dir);
  assert.strictEqual(result.valid, true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('validateLinks reports multiple broken links', () => {
  const dir = tmpDir();

  const content = `See [a](a.md) and [b](b.md) and [c](https://ok.com).`;
  const result = validateLinks(content, dir);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.broken!.length, 2);
  assert.ok(result.broken!.includes('a.md'));
  assert.ok(result.broken!.includes('b.md'));

  fs.rmSync(dir, { recursive: true, force: true });
});
