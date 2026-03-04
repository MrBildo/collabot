import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { getPackagePath } from './paths.js';

// ── .env template ────────────────────────────────────────────

const ENV_TEMPLATE = `# ──────────────────────────────────────────────────────────────
# Collabot instance — secrets and system paths
# ──────────────────────────────────────────────────────────────
# This file is loaded by dotenv at startup. It is gitignored.
# Operational settings (model aliases, pool size, etc.) belong in config.toml.

# ── Anthropic API ─────────────────────────────────────────────
# Required. Your Anthropic API key for Claude model access.
ANTHROPIC_API_KEY=

# ── Claude Code Paths (Windows) ──────────────────────────────
# Path to the installed claude.exe binary.
# Required on Windows — the SDK has a git-bash path resolution bug.
# Find yours with: where claude
CLAUDE_EXECUTABLE_PATH=

# Windows only — path to Git bash.exe with BACKSLASHES.
# Required because the SDK's git-bash auto-detection resolves to the wrong path.
# Example: C:\\Program Files\\Git\\bin\\bash.exe
CLAUDE_CODE_GIT_BASH_PATH=

# ── Slack Bot Credentials ────────────────────────────────────
# One pair per bot. Names must match the keys in config.toml [slack.bots.*].
# Get tokens from https://api.slack.com/apps → your bot app.

# HAZEL_BOT_TOKEN=xoxb-...
# HAZEL_APP_TOKEN=xapp-...
`;

// ── Starter role (researcher) ────────────────────────────────

const STARTER_ROLE = `---
id: 01STARTER0ROLE0RESEARCHER00
version: 1.0.0
name: researcher
description: Research and analysis — investigate topics, synthesize findings, and report back clearly.
createdOn: "${new Date().toISOString()}"
createdBy: collabot init
displayName: Researcher
model-hint: sonnet-latest
---
You are a researcher. You investigate topics thoroughly, synthesize findings, and report back with clear, well-organized answers.

## How You Work

1. Understand the question or topic being asked about
2. Break complex questions into smaller, researchable pieces
3. Investigate using available tools and context
4. Synthesize findings into a clear, concise response
5. Flag gaps, uncertainties, or areas that need follow-up

## Practices

- Depth over breadth — one solid answer beats five shallow ones
- Cite sources and file paths when referencing specific information
- Distinguish between facts and inferences
- If you get stuck or are unsure, report back rather than guessing
- Ask clarifying questions when the request is ambiguous
`;

// ── Starter bot (hazel) ──────────────────────────────────────

const STARTER_BOT = `---
id: 01STARTER0BOT00HAZEL000000
version: 1.0.0
name: hazel
displayName: Hazel
description: A friendly research assistant bot.
---
You are Hazel, a curious and methodical research assistant. You approach problems with genuine interest and break complex questions into manageable pieces.

## Identity

Hazel is thoughtful and precise. She asks clarifying questions when something is ambiguous, summarizes findings clearly, and admits when she doesn't know something. She prefers depth over breadth — one well-researched answer over five superficial ones.

## Boundaries

- Stay in character as a helpful, focused research assistant
- Ask for clarification rather than guessing at ambiguous requests
- Report back honestly if a task is outside your capabilities
`;

// ── Prompt templates ─────────────────────────────────────────

const SYSTEM_PROMPT = `# System Prompt

You are an AI agent working within Collabot, a collaborative agent platform. You have been assigned a role and a project. Use your tools to accomplish the task you've been given.

## Guidelines

- Focus on the task at hand. Don't explore unrelated areas.
- If you get stuck or are unsure about something, report back with your question rather than guessing.
- Prefer making incremental progress — commit small, correct changes rather than attempting everything at once.
- Use the MCP tools available to you (list_tasks, get_task_context, list_projects) to understand your context.
- When done, produce a structured result summarizing what you did, what changed, and any remaining issues.
`;

const TOOLS_PROMPT = `# Tools Prompt

You have access to MCP tools provided by the Collabot harness:

- **list_projects** — See which project you're working in
- **list_tasks** — List tasks in your current project
- **get_task_context** — Get the history of prior dispatches for a task

If your role has the \`agent-draft\` permission, you also have lifecycle tools:

- **draft_agent** — Dispatch a sub-agent with a role and prompt
- **await_agent** — Wait for a drafted agent to complete
- **kill_agent** — Abort a running agent
`;

// ── Instance docs ────────────────────────────────────────────

const GETTING_STARTED_DOC = `# Getting Started with Collabot

## First Run

1. Edit \`.env\` with your Anthropic API key (and Windows paths if applicable)
2. Run \`collabot start\` to boot the harness
3. The TUI connects automatically if the WS adapter is enabled

## First Bot Interaction

Hazel is your starter bot. She uses the \`researcher\` role by default.

**Via TUI:**
\`\`\`
/draft bot-hazel researcher    # draft Hazel for a conversation
Hey Hazel, what is Collabot?   # send a message
/undraft bot-hazel             # release Hazel when done
\`\`\`

**Via Slack (if configured):**
DM Hazel directly — she'll respond in the same thread.

## Key Concepts

- **Bots** are persistent identities (WHO) — personality, motivations, memories
- **Roles** define behavior (WHAT) — prompts, model hints, permissions
- **Projects** are work contexts — scoped to one or more repos
- **Tasks** track dispatches within a project — event logs, structured results

## Directory Structure

\`\`\`
~/.collabot/
├── config.toml        # operational settings
├── .env               # secrets (gitignored)
├── roles/             # role definitions (markdown + YAML frontmatter)
├── bots/              # bot definitions (markdown + YAML frontmatter)
├── prompts/           # system and tool prompts
├── skills/            # skill definitions
├── .projects/         # project manifests and task data
└── docs/              # this documentation
\`\`\`
`;

const ROLES_DOC = `# Roles

Roles define behavioral profiles for agents. Each role is a markdown file with YAML frontmatter in \`roles/\`.

## Frontmatter Schema

\`\`\`yaml
---
id: <ULID>              # unique identifier
version: <semver>       # e.g., 1.0.0
name: <slug>            # lowercase, hyphenated (e.g., ts-dev)
description: <text>     # what this role does
createdOn: <ISO 8601>   # creation timestamp
createdBy: <name>       # author
displayName: <text>     # human-friendly name
model-hint: <alias>     # maps to config.toml [models.aliases]
permissions:            # optional — controls MCP tool access
  - agent-draft         # can dispatch sub-agents
  - projects-list       # can list all projects
  - projects-create     # can create projects
---
\`\`\`

## Body

The markdown body after the frontmatter is the role's prompt — it defines how the agent behaves.

## Tips

- Keep roles tech-stack-focused, not project-specific
- Any role can be assigned to any project
- Use \`model-hint\` to match task complexity to model cost
- Add \`permissions\` only when the role needs lifecycle tools
`;

const BOTS_DOC = `# Bots

Bots are persistent identities. Each bot is a markdown file with YAML frontmatter in \`bots/\`.

## Frontmatter Schema

\`\`\`yaml
---
id: <ULID>              # unique identifier
version: <semver>       # e.g., 1.0.0
name: <slug>            # lowercase (e.g., hazel)
displayName: <text>     # human-friendly name
description: <text>     # brief identity description
---
\`\`\`

## Body — The Soul Prompt

The markdown body is the bot's soul prompt. It defines personality, identity, and behavioral boundaries. The soul prompt is appended after the role prompt, giving the bot character on top of capability.

## Bot vs Role

| Aspect | Bot | Role |
|--------|-----|------|
| Defines | WHO — identity, personality | WHAT — capability, behavior |
| Persistence | Across sessions | Per dispatch |
| Scope | One bot at a time | Any bot, any project |

## Configuration

Bots are assigned to projects and roles in \`config.toml\`:

\`\`\`toml
[bots.hazel]
defaultProject = "lobby"
defaultRole    = "researcher"
\`\`\`
`;

const PROJECTS_DOC = `# Projects

Projects represent logical products. Each project can span multiple repositories.

## Manifest Format

Project manifests live in \`.projects/<name>/project.toml\`:

\`\`\`toml
name = "My Project"
description = "What this project is"
paths = ["../my-repo", "../my-other-repo"]
roles = ["ts-dev", "researcher"]
\`\`\`

## Fields

- **name** — display name
- **description** — what the project is about
- **paths** — relative paths to project repositories
- **roles** — which roles can work on this project

## Virtual Projects

Some projects are virtual — they don't map to repos on disk. The \`lobby\` project is created automatically when bots are configured. Slack adapters can inject their own virtual projects.

## Creating Projects

**Via TUI:** \`/project init <name>\`
**Via WS:** \`create_project\` JSON-RPC method
**Manually:** Create \`.projects/<name>/project.toml\`

Projects are loaded at startup and can be reloaded without restart.
`;

// ── Init function ────────────────────────────────────────────

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
  const dirs = [
    '',
    'prompts',
    'roles',
    'bots',
    'skills',
    '.projects',
    'docs',
  ];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(target, dir), { recursive: true });
  }

  // Copy config.defaults.toml as config.toml
  const defaultsPath = getPackagePath('config.defaults.toml');
  fs.copyFileSync(defaultsPath, path.join(target, 'config.toml'));

  // Create .env template
  fs.writeFileSync(path.join(target, '.env'), ENV_TEMPLATE, 'utf8');

  // Create prompts
  fs.writeFileSync(path.join(target, 'prompts', 'system.md'), SYSTEM_PROMPT, 'utf8');
  fs.writeFileSync(path.join(target, 'prompts', 'tools.md'), TOOLS_PROMPT, 'utf8');

  // Create starter role
  fs.writeFileSync(path.join(target, 'roles', 'researcher.md'), STARTER_ROLE, 'utf8');

  // Create starter bot
  fs.writeFileSync(path.join(target, 'bots', 'hazel.md'), STARTER_BOT, 'utf8');

  // Create instance docs
  fs.writeFileSync(path.join(target, 'docs', 'getting-started.md'), GETTING_STARTED_DOC, 'utf8');
  fs.writeFileSync(path.join(target, 'docs', 'roles.md'), ROLES_DOC, 'utf8');
  fs.writeFileSync(path.join(target, 'docs', 'bots.md'), BOTS_DOC, 'utf8');
  fs.writeFileSync(path.join(target, 'docs', 'projects.md'), PROJECTS_DOC, 'utf8');

  // Output summary
  console.log(`\nCollabot instance created at ${target}\n`);
  console.log('  config.toml           operational settings (models, pool, adapters)');
  console.log('  .env                  secrets (API keys, tokens, system paths)');
  console.log('  prompts/              system and tool prompts');
  console.log('  roles/researcher.md   starter role');
  console.log('  bots/hazel.md         starter bot');
  console.log('  skills/               skill definitions (empty)');
  console.log('  .projects/            project manifests and task data');
  console.log('  docs/                 instance documentation');
  console.log('\nNext steps:');
  console.log('  1. Edit .env with your Anthropic API key');
  console.log('  2. Run `collabot start` to boot the harness');
  console.log('  3. Read docs/getting-started.md for usage guide');
}
