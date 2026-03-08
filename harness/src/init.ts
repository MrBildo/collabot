import path from 'node:path';
import fs from 'node:fs';
import { getPackagePath, resolveInstanceTarget } from './paths.js';

/**
 * Resolve the path to a file inside harness/templates/.
 */
function templatePath(...segments: string[]): string {
  return getPackagePath('templates', ...segments);
}

export function runInit(): void {
  const target = resolveInstanceTarget();

  if (fs.existsSync(target)) {
    console.error(`Instance directory already exists at ${target}`);
    console.error('Remove it first if you want to reinitialize.');
    process.exit(1);
  }

  // Create directory structure — no skills/, no docs/
  const dirs = ['', 'prompts', 'roles', 'bots', '.projects'];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(target, dir), { recursive: true });
  }

  // Copy templates
  fs.copyFileSync(templatePath('config.defaults.toml'), path.join(target, 'config.toml'));
  fs.copyFileSync(templatePath('env.template'), path.join(target, '.env'));
  fs.copyFileSync(templatePath('prompts', 'system.md'), path.join(target, 'prompts', 'system.md'));

  // Output summary
  console.log(`\nCollabot instance created at ${target}\n`);
  console.log('  config.toml        operational settings (models, pool, adapters)');
  console.log('  .env               secrets (API keys, tokens, system paths)');
  console.log('  prompts/system.md  agent system prompt');
  console.log('  roles/             role definitions (empty — use `collabot setup` to add)');
  console.log('  bots/              bot definitions (empty — use `collabot setup` to add)');
  console.log('  .projects/         project manifests and task data');
  console.log('\nNext steps:');
  console.log('  1. Run `collabot setup` to configure API key, roles, and bots');
  console.log('  2. Then `collabot start` to boot the harness');
  console.log('\n  Note: the harness requires at least one role to start.');
}
