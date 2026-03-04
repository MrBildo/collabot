import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { stringify as stringifyToml } from 'smol-toml';
import { loadProjects, createProject, projectHasPaths, isVirtualProject, ensureVirtualProject } from './project.js';
import type { RoleDefinition } from './types.js';

let tmpDir: string;

function makeRoles(...names: string[]): Map<string, RoleDefinition> {
  const map = new Map<string, RoleDefinition>();
  for (const name of names) {
    map.set(name, {
      id: '01HXYZ01234567890ABCDEFGH',
      version: '1.0.0',
      name,
      description: `${name} role.`,
      createdOn: '2026-02-24T15:00:00Z',
      createdBy: 'Test',
      displayName: name,
      modelHint: 'sonnet-latest',
      prompt: `You are ${name}`,
    });
  }
  return map;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collabot-project-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('loadProjects allows project with empty paths', () => {
  const projectDir = path.join(tmpDir, 'test-project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'project.toml'), stringifyToml({
    name: 'TestProject',
    description: 'A test project',
    paths: [],
    roles: ['api-dev'],
  }));

  const roles = makeRoles('api-dev');
  const projects = loadProjects(tmpDir, roles);

  assert.strictEqual(projects.size, 1);
  const project = projects.get('testproject')!;
  assert.strictEqual(project.name, 'TestProject');
  assert.deepStrictEqual(project.paths, []);
});

test('projectHasPaths returns false for empty paths, true for non-empty', () => {
  assert.strictEqual(projectHasPaths({ name: 'A', description: 'A', paths: [], roles: ['x'] }), false);
  assert.strictEqual(projectHasPaths({ name: 'A', description: 'A', paths: ['/some/path'], roles: ['x'] }), true);
});

test('createProject writes TOML and returns project with empty paths', () => {
  const roles = makeRoles('api-dev', 'portal-dev');

  const project = createProject(tmpDir, {
    name: 'NewProject',
    description: 'A new project',
    roles: ['api-dev', 'portal-dev'],
  }, roles);

  assert.strictEqual(project.name, 'NewProject');
  assert.deepStrictEqual(project.paths, []);
  assert.deepStrictEqual(project.roles, ['api-dev', 'portal-dev']);

  // Verify file was written
  const tomlPath = path.join(tmpDir, 'newproject', 'project.toml');
  assert.ok(fs.existsSync(tomlPath));

  // Verify loadProjects can read it back
  const loaded = loadProjects(tmpDir, roles);
  assert.strictEqual(loaded.size, 1);
  assert.strictEqual(loaded.get('newproject')!.name, 'NewProject');
});

test('createProject throws on invalid role', () => {
  const roles = makeRoles('api-dev');

  assert.throws(
    () => createProject(tmpDir, {
      name: 'Bad',
      description: 'Bad project',
      roles: ['nonexistent-role'],
    }, roles),
    /not found/,
  );
});

test('reload picks up TOML changes', () => {
  const roles = makeRoles('api-dev');

  // Create initial project
  createProject(tmpDir, {
    name: 'Evolving',
    description: 'Will change',
    roles: ['api-dev'],
  }, roles);

  // Load initial
  const initial = loadProjects(tmpDir, roles);
  assert.deepStrictEqual(initial.get('evolving')!.paths, []);

  // Manually edit TOML to add a path
  const tomlPath = path.join(tmpDir, 'evolving', 'project.toml');
  fs.writeFileSync(tomlPath, stringifyToml({
    name: 'Evolving',
    description: 'Will change',
    paths: ['/some/repo'],
    roles: ['api-dev'],
  }), 'utf-8');

  // Reload
  const reloaded = loadProjects(tmpDir, roles);
  assert.deepStrictEqual(reloaded.get('evolving')!.paths, ['/some/repo']);
});

// --- Virtual Projects ---

test('projectHasPaths handles virtual field gracefully', () => {
  assert.strictEqual(projectHasPaths({ name: 'A', description: 'A', paths: [], roles: ['x'], virtual: true }), false);
  assert.strictEqual(projectHasPaths({ name: 'A', description: 'A', paths: ['/root'], roles: ['x'], virtual: true }), true);
});

test('isVirtualProject returns true for virtual, false for regular', () => {
  assert.strictEqual(isVirtualProject({ name: 'A', description: 'A', paths: [], roles: ['x'], virtual: true }), true);
  assert.strictEqual(isVirtualProject({ name: 'A', description: 'A', paths: [], roles: ['x'], virtual: false }), false);
  assert.strictEqual(isVirtualProject({ name: 'A', description: 'A', paths: [], roles: ['x'] }), false);
});

test('ensureVirtualProject creates virtual project on first call', () => {
  const project = ensureVirtualProject(tmpDir, 'lobby', 'Default virtual project', ['ts-dev'], '/instance/root');

  assert.strictEqual(project.name, 'lobby');
  assert.strictEqual(project.virtual, true);
  assert.deepStrictEqual(project.paths, ['/instance/root']);
  assert.deepStrictEqual(project.roles, ['ts-dev']);

  // Verify file was written
  const tomlPath = path.join(tmpDir, 'lobby', 'project.toml');
  assert.ok(fs.existsSync(tomlPath));
});

test('ensureVirtualProject returns existing on second call', () => {
  const first = ensureVirtualProject(tmpDir, 'lobby', 'First description', ['ts-dev'], '/root');
  const second = ensureVirtualProject(tmpDir, 'lobby', 'Second description', ['api-dev'], '/root');

  // Should return the first one (already exists), not recreate
  assert.strictEqual(second.name, first.name);
  assert.strictEqual(second.description, first.description);
});

test('loadProjects loads virtual project with virtual=true', () => {
  const roles = makeRoles('ts-dev');
  ensureVirtualProject(tmpDir, 'lobby', 'Default lobby', ['ts-dev'], '/instance/root');

  const projects = loadProjects(tmpDir, roles);
  assert.strictEqual(projects.size, 1);

  const lobby = projects.get('lobby')!;
  assert.strictEqual(lobby.virtual, true);
  assert.strictEqual(lobby.name, 'lobby');
});
