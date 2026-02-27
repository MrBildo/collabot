#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getPackagePath } from './paths.js';

const args = process.argv.slice(2);
const command = args[0];

if (command === '--version' || command === '-v') {
  const pkg = JSON.parse(readFileSync(getPackagePath('package.json'), 'utf8')) as { version: string };
  console.log(pkg.version);
  process.exit(0);
}

if (command === '--help' || command === '-h' || command === undefined) {
  printHelp();
  process.exit(0);
}

if (command === 'init') {
  const { runInit } = await import('./init.js');
  runInit();
} else if (command === 'start' || command === 'dispatch') {
  // Load .env from instance root before delegating
  const instanceRoot = process.env.COLLABOT_HOME
    ? path.resolve(process.env.COLLABOT_HOME)
    : path.join(os.homedir(), '.collabot');
  const dotenv = await import('dotenv');
  dotenv.config({ path: path.join(instanceRoot, '.env') });

  // Strip subcommand from argv so delegated modules parse correctly
  process.argv = [process.argv[0]!, process.argv[1]!, ...process.argv.slice(3)];

  if (command === 'start') {
    await import('./index.js');
  } else {
    await import('./cli.js');
  }
} else {
  console.error(`Unknown command: ${command}\n`);
  printHelp();
  process.exit(1);
}

function printHelp(): void {
  const pkg = JSON.parse(readFileSync(getPackagePath('package.json'), 'utf8')) as { version: string };
  console.log(`
  Collabot v${pkg.version} — the collaborative agent platform

  Usage:
    collabot start                Start the harness
    collabot init                 Scaffold a new instance (~/.collabot/)
    collabot dispatch [options]   One-shot CLI dispatch
    collabot --version            Print version

  Dispatch options:
    --project, -p <name>          Project name (required)
    --role, -r <role>             Role name (required)
    --cwd <path>                  Working directory override
    --task, -t <slug>             Attach to existing task
    --list-projects               List all projects
    --list-tasks                  List tasks for a project
`);
}
