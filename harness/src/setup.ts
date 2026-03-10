import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import * as p from '@clack/prompts';
import { ulid } from 'ulid';
import { getPackagePath, resolveInstanceTarget } from './paths.js';
import { runInit } from './init.js';

// ── Types ────────────────────────────────────────────────────

export type TemplateMeta = {
  fileName: string;
  name: string;
  displayName: string;
  description: string;
  order: number;
};

/**
 * List template files of a given type (roles/ or bots/) and parse display info from frontmatter.
 */
export function listTemplates(type: 'roles' | 'bots'): TemplateMeta[] {
  const dir = getPackagePath('templates', type);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  const results: TemplateMeta[] = [];

  for (const fileName of files) {
    const content = fs.readFileSync(path.join(dir, fileName), 'utf8');
    const fm = parseFrontmatterSimple(content);
    results.push({
      fileName,
      name: fm.name ?? fileName.replace(/\.md$/, ''),
      displayName: fm.displayName ?? fm.name ?? fileName.replace(/\.md$/, ''),
      description: fm.description ?? '',
      order: fm.order ? parseInt(fm.order, 10) : 999,
    });
  }

  return results.sort((a, b) => a.order - b.order);
}

/**
 * Minimal frontmatter parser — extracts key: value pairs between --- delimiters.
 * Does not depend on js-yaml to keep setup lightweight.
 */
function parseFrontmatterSimple(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---')) return result;

  const endIdx = normalized.indexOf('---', 3);
  if (endIdx === -1) return result;

  const block = normalized.slice(3, endIdx).trim();
  for (const line of block.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    result[key] = value;
  }

  return result;
}

/**
 * Read a template file, stamp frontmatter fields (id, version, createdOn, createdBy for roles),
 * and write to the target directory. If outputName is provided, the file is saved as
 * `<outputName>.md` and the frontmatter `name` field is updated to match.
 */
export function stampAndCopyEntity(type: 'roles' | 'bots', templateName: string, targetDir: string, outputName?: string): string {
  const templateFile = getPackagePath('templates', type, templateName);
  let content = fs.readFileSync(templateFile, 'utf8');

  const id = ulid();
  const now = new Date().toISOString();

  // Normalize line endings to \n for consistent regex matching
  content = content.replace(/\r\n/g, '\n');

  // Inject id and version after the opening ---
  const insertAfterOpen = `---\nid: ${id}\nversion: 1.0.0\n`;
  content = content.replace(/^---\n/, insertAfterOpen);

  // For roles, also inject createdOn and createdBy before model-hint
  if (type === 'roles') {
    content = content.replace(
      /^(model-hint:.*)$/m,
      `createdOn: "${now}"\ncreatedBy: collabot setup\n$1`,
    );
  }

  // If a custom name is provided, update the frontmatter name field and output filename
  const finalName = outputName ?? templateName.replace(/\.md$/, '');
  if (outputName) {
    content = content.replace(/^name:.*$/m, `name: ${outputName}`);
  }

  const outPath = path.join(targetDir, type, `${finalName}.md`);
  fs.writeFileSync(outPath, content, 'utf8');
  return outPath;
}

/**
 * Patch a key=value in an .env file. If the key exists (even commented), uncomment and set it.
 * If the key doesn't exist, append it.
 */
export function patchEnvFile(envPath: string, key: string, value: string): void {
  let content = fs.readFileSync(envPath, 'utf8');

  // Match the key with optional leading # and spaces
  const re = new RegExp(`^(#\\s*)?${key}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }

  fs.writeFileSync(envPath, content, 'utf8');
}

// ── Platform checks ──────────────────────────────────────────

/**
 * Check if Claude Code CLI is installed. Returns version string if found, null otherwise.
 */
function checkClaudeCli(): string | null {
  try {
    const version = execSync('claude --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return version || 'installed';
  } catch {
    return null;
  }
}

function checkNode(): string | null {
  const [major] = process.versions.node.split('.').map(Number);
  if (major !== undefined && major < 22) {
    return `Node.js ${process.versions.node} detected — Collabot requires Node.js 22+.`;
  }
  return null;
}

function checkGitBash(): string | null {
  if (process.platform !== 'win32') return null;

  try {
    const gitPath = execSync('where git', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n')[0];
    if (gitPath) {
      const bashPath = path.resolve(path.dirname(gitPath), '..', '..', 'bin', 'bash.exe');
      if (fs.existsSync(bashPath)) {
        return bashPath;
      }
    }
  } catch {
    // git not found — will prompt manually
  }
  return null;
}

function checkMacToolchain(): string | null {
  if (process.platform !== 'darwin') return null;

  try {
    execSync('xcode-select -p', { stdio: ['pipe', 'pipe', 'pipe'] });
    return null;
  } catch {
    return 'Xcode Command Line Tools not found. Some operations may fail. Run: xcode-select --install';
  }
}

function checkSnapNode(): string | null {
  if (process.platform !== 'linux') return null;

  if (process.execPath.includes('/snap/')) {
    return 'Node.js installed via snap detected. This may cause file system sandbox issues with Collabot. Consider installing Node.js via nvm or your package manager.';
  }
  return null;
}

// ── Main wizard ──────────────────────────────────────────────

export async function runSetup(): Promise<void> {
  p.intro('Collabot Setup');

  // 1. Auto-init if instance doesn't exist
  const target = resolveInstanceTarget();
  if (!fs.existsSync(target)) {
    p.log.step('No instance found — running init...');
    // Temporarily suppress console output from runInit
    const origLog = console.log;
    const origErr = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      runInit();
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    p.log.success(`Instance created at ${target}`);
  } else {
    p.log.step(`Instance found at ${target}`);
  }

  // 2. Claude Code CLI check
  const claudeInstalled = checkClaudeCli();
  if (claudeInstalled) {
    p.log.success(`Claude Code CLI found: ${claudeInstalled}`);
    p.log.info(
      'Collabot dispatches bots via the Claude Code CLI.\n' +
      'Authentication is managed by the CLI — run `claude` to log in or check status.\n' +
      'Supported methods: Claude Pro/Max/Teams/Enterprise, Console API key,\n' +
      'Amazon Bedrock, Google Vertex AI, Microsoft Foundry.\n' +
      'See https://code.claude.com/docs/en/authentication',
    );
  } else {
    p.log.warn(
      'Claude Code CLI not found.\n' +
      'Collabot requires Claude Code CLI to dispatch bots.\n' +
      'Install: npm install -g @anthropic-ai/claude-code\n' +
      'Then run `claude` to authenticate.\n' +
      'See https://code.claude.com/docs/en/authentication',
    );
  }

  // 3. Platform checks
  const nodeWarning = checkNode();
  if (nodeWarning) p.log.warn(nodeWarning);

  const macWarning = checkMacToolchain();
  if (macWarning) p.log.warn(macWarning);

  const snapWarning = checkSnapNode();
  if (snapWarning) p.log.warn(snapWarning);

  // Windows: Claude executable path
  if (process.platform === 'win32') {
    // Auto-detect claude.exe location
    let detectedClaude: string | null = null;
    try {
      const whereResult = execSync('where claude', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n')[0];
      if (whereResult && fs.existsSync(whereResult.trim())) {
        detectedClaude = whereResult.trim();
      }
    } catch { /* not found */ }

    const claudeDefault = detectedClaude ?? `C:\\Users\\${process.env.USERNAME ?? 'you'}\\.local\\bin\\claude.exe`;

    const claudePath = await p.text({
      message: 'Path to claude.exe',
      initialValue: claudeDefault,
    });

    if (p.isCancel(claudePath)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }

    if (claudePath && claudePath.trim()) {
      patchEnvFile(path.join(target, '.env'), 'CLAUDE_EXECUTABLE_PATH', claudePath.trim());
    }

    // Git bash path
    const detectedBash = checkGitBash();
    const gitBashDefault = detectedBash ?? 'C:\\Program Files\\Git\\bin\\bash.exe';

    const gitBashPath = await p.text({
      message: 'Path to Git bash.exe',
      initialValue: gitBashDefault,
    });

    if (p.isCancel(gitBashPath)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }

    if (gitBashPath && gitBashPath.trim()) {
      patchEnvFile(path.join(target, '.env'), 'CLAUDE_CODE_GIT_BASH_PATH', gitBashPath.trim());
    }
  }

  // 4. Role selection
  const roleTemplates = listTemplates('roles');
  if (roleTemplates.length > 0) {
    const selectedRoles = await p.multiselect({
      message: 'Which roles do you want to install?',
      options: roleTemplates.map((t) => ({
        value: t.fileName,
        label: t.displayName,
        hint: t.description,
      })),
      initialValues: [roleTemplates.find((t) => t.name === 'assistant')?.fileName ?? roleTemplates[0]!.fileName],
      required: true,
    });

    if (p.isCancel(selectedRoles)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }

    for (const fileName of selectedRoles) {
      stampAndCopyEntity('roles', fileName, target);
    }
    p.log.success(`${selectedRoles.length} role(s) installed`);
  }

  // 5. Bot selection + naming
  const installedBotNames: string[] = [];
  const botTemplates = listTemplates('bots');
  if (botTemplates.length > 0) {
    const selectedBots = await p.multiselect({
      message: 'Which bot personalities do you want to install?',
      options: botTemplates.map((t) => ({
        value: t.fileName,
        label: t.displayName,
        hint: t.description,
      })),
      initialValues: [botTemplates.find((t) => t.name === 'agent')?.fileName ?? botTemplates[0]!.fileName],
      required: true,
    });

    if (p.isCancel(selectedBots)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }

    for (const fileName of selectedBots) {
      const templateLabel = botTemplates.find((t) => t.fileName === fileName)?.displayName ?? fileName;

      const botName = await p.text({
        message: `Name for ${templateLabel} bot`,
        placeholder: 'letters, numbers, and hyphens (e.g. Hazel)',
        validate: (val = '') => {
          if (!val.trim()) return 'Name is required';
          if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(val.trim())) return 'Letters, numbers, and hyphens only (must start with a letter)';
          if (installedBotNames.includes(val.trim())) return 'Name already used';
          return undefined;
        },
      });

      if (p.isCancel(botName)) {
        p.cancel('Setup cancelled.');
        process.exit(0);
      }

      const name = botName.trim();
      stampAndCopyEntity('bots', fileName, target, name);
      installedBotNames.push(name);
    }
    p.log.success(`${installedBotNames.length} bot(s) installed: ${installedBotNames.join(', ')}`);
  }

  // 6. Slack setup
  const wantsSlack = await p.confirm({
    message: 'Set up Slack integration?',
    initialValue: false,
  });

  if (p.isCancel(wantsSlack)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  if (wantsSlack) {
    p.log.info(
      'You\'ll need a Slack App with Socket Mode enabled.\n' +
      'See https://api.slack.com/apps\n' +
      'Required scopes: chat:write, im:history, im:read, app_mentions:read\n' +
      'Each bot needs its own Slack App with separate tokens.',
    );

    // Pick which bots to connect to Slack
    // Include any bots already on disk (from a previous setup run)
    const existingBots = fs.existsSync(path.join(target, 'bots'))
      ? fs.readdirSync(path.join(target, 'bots')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
      : [];
    const allBotNames = [...new Set([...installedBotNames, ...existingBots])];

    if (allBotNames.length === 0) {
      p.log.warn('No bots installed — install at least one bot first.');
    } else {
      const slackBots = await p.multiselect({
        message: 'Which bots should be connected to Slack?',
        options: allBotNames.map((name) => ({ value: name, label: name })),
        required: false,
      });

      if (p.isCancel(slackBots)) {
        p.cancel('Setup cancelled.');
        process.exit(0);
      }

      if (slackBots.length > 0) {
        const configPath = path.join(target, 'config.toml');
        let config = fs.readFileSync(configPath, 'utf8');
        config += '\n[slack]\ndefaultRole = "assistant"\n';

        for (const botName of slackBots) {
          p.log.step(`Configuring Slack for "${botName}"`);
          const envPrefix = botName.toUpperCase().replace(/-/g, '_');

          const appToken = await p.text({
            message: `${botName} — App token (xapp-...)`,
            placeholder: 'xapp-...',
          });

          if (p.isCancel(appToken)) {
            p.cancel('Setup cancelled.');
            process.exit(0);
          }

          const botToken = await p.text({
            message: `${botName} — Bot token (xoxb-...)`,
            placeholder: 'xoxb-...',
          });

          if (p.isCancel(botToken)) {
            p.cancel('Setup cancelled.');
            process.exit(0);
          }

          if (appToken?.trim() && botToken?.trim()) {
            patchEnvFile(path.join(target, '.env'), `${envPrefix}_APP_TOKEN`, appToken.trim());
            patchEnvFile(path.join(target, '.env'), `${envPrefix}_BOT_TOKEN`, botToken.trim());

            config += `\n[slack.bots.${botName}]\nbotTokenEnv = "${envPrefix}_BOT_TOKEN"\nappTokenEnv = "${envPrefix}_APP_TOKEN"\n`;

            p.log.success(`Slack configured for "${botName}"`);
          } else {
            p.log.info(`Skipped "${botName}" — add tokens to .env later.`);
          }
        }

        fs.writeFileSync(configPath, config, 'utf8');
      }
    }
  }

  p.outro('Setup complete! Run `collabot start` to boot the harness.');
}
