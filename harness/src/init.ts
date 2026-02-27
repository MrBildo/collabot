import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { getPackagePath } from './paths.js';

const ENV_TEMPLATE = `# Collabot instance — secrets and system paths only.
# Operational settings (agent defaults, log level, pool size) are in config.toml.

# Slack bot token (xoxb-...)
SLACK_BOT_TOKEN=

# Slack app-level token for Socket Mode (xapp-...)
SLACK_APP_TOKEN=

# Path to the installed claude.exe binary.
# Required on Windows — the SDK has a git-bash path resolution bug.
# Find yours with: where claude
CLAUDE_EXECUTABLE_PATH=

# Windows only — path to Git bash.exe with BACKSLASHES.
# Required because the SDK's git-bash auto-detection resolves to the wrong path.
# Example: C:\\Program Files\\Git\\bin\\bash.exe
CLAUDE_CODE_GIT_BASH_PATH=
`;

const SYSTEM_PROMPT_TEMPLATE = `# System Prompt

<!-- This file is scaffolded by collabot init and owned by the instance. -->
<!-- Edit this file to customize the system prompt sent to dispatched agents. -->
`;

const TOOLS_PROMPT_TEMPLATE = `# Tools Prompt

<!-- This file is scaffolded by collabot init and owned by the instance. -->
<!-- Edit this file to document MCP tools available to dispatched agents. -->
`;

/**
 * Resolve the instance target directory (same logic as paths.ts but without
 * requiring it to exist).
 */
function resolveInstanceTarget(): string {
  const fromEnv = process.env.COLLABOT_HOME;
  return fromEnv
    ? path.resolve(fromEnv)
    : path.join(os.homedir(), '.collabot');
}

export function runInit(): void {
  const target = resolveInstanceTarget();

  if (fs.existsSync(target)) {
    console.error(`Instance directory already exists at ${target}`);
    console.error('Remove it first if you want to reinitialize.');
    process.exit(1);
  }

  // Create directory structure
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(path.join(target, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(target, 'roles'), { recursive: true });
  fs.mkdirSync(path.join(target, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(target, '.projects'), { recursive: true });

  // Copy config.defaults.toml as config.toml
  const defaultsPath = getPackagePath('config.defaults.toml');
  fs.copyFileSync(defaultsPath, path.join(target, 'config.toml'));

  // Create .env template
  fs.writeFileSync(path.join(target, '.env'), ENV_TEMPLATE, 'utf8');

  // Create placeholder prompts
  fs.writeFileSync(path.join(target, 'prompts', 'system.md'), SYSTEM_PROMPT_TEMPLATE, 'utf8');
  fs.writeFileSync(path.join(target, 'prompts', 'tools.md'), TOOLS_PROMPT_TEMPLATE, 'utf8');

  console.log(`\nCollabot instance created at ${target}\n`);
  console.log('  config.toml       configuration (model aliases, pool size, etc.)');
  console.log('  .env              secrets (API keys, tokens, system paths)');
  console.log('  prompts/          system and tool prompts');
  console.log('  roles/            role definitions');
  console.log('  skills/           skill definitions');
  console.log('  .projects/        project manifests and task data');
  console.log('\nNext: edit .env with your API keys, then run `collabot start`.');
}
