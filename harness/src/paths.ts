import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Central path resolver — three path domains:
 *
 * 1. Instance  (COLLABOT_HOME env var, default ~/.collabot/)
 *    Config, roles, prompts, projects, task data, all runtime artifacts.
 *
 * 2. Package   (__dirname / import.meta.url)
 *    Compiled harness code only. Nothing user-facing.
 *
 * 3. Project   (absolute paths in project manifests)
 *    Fully decoupled from Collabot's own location.
 */

// Package root: harness/src/paths.ts → ../ = harness/
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));

let _instanceRoot: string | undefined;

/**
 * Resolve the instance target path without requiring it to exist.
 * Used by init/setup which create the directory.
 */
export function resolveInstanceTarget(): string {
  const fromEnv = process.env.COLLABOT_HOME;
  return fromEnv
    ? path.resolve(fromEnv)
    : path.join(os.homedir(), '.collabot');
}

/**
 * Resolve the instance root directory.
 *
 * Priority: COLLABOT_HOME env var → ~/.collabot/ default.
 * Errors if the resolved directory does not exist.
 */
export function getInstanceRoot(): string {
  if (_instanceRoot !== undefined) return _instanceRoot;

  const resolved = resolveInstanceTarget();

  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Instance root not found at ${resolved}. ` +
      (process.env.COLLABOT_HOME
        ? 'Check that COLLABOT_HOME points to an existing directory.'
        : 'Set COLLABOT_HOME or run `collabot init`.'),
    );
  }

  _instanceRoot = resolved;
  return _instanceRoot;
}

/**
 * Join path segments under the instance root.
 * e.g. getInstancePath('roles') → ~/.collabot/roles
 */
export function getInstancePath(...segments: string[]): string {
  return path.join(getInstanceRoot(), ...segments);
}

/**
 * Join path segments under the package root (harness/).
 * For compiled code references only — nothing user-facing.
 * e.g. getPackagePath('package.json') → harness/package.json
 */
export function getPackagePath(...segments: string[]): string {
  return path.join(PACKAGE_ROOT, ...segments);
}

/**
 * Reset cached instance root (for testing only).
 */
export function _resetInstanceRoot(): void {
  _instanceRoot = undefined;
}
