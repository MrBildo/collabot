# Product/Instance Separation

| Field | Value |
|-------|-------|
| **Source** | Spec discussion 2026-02-27 |
| **Status** | **Signed Off** |
| **Signed Off** | 2026-02-27 |
| **Created** | 2026-02-27 |

## Summary

Separate Collabot the product from the user's Collabot instance. The product repo produces a globally-installed npm package. The user's instance lives at `~/.collabot/` and contains all configuration, roles, skills, prompts, projects, and runtime artifacts. This is the only hard gate before dogfooding Collabot on real projects.

## Deployment Identity

Collabot is a **service installed on a machine**, not a library consumed by projects. One install per machine, one instance, one configuration. Like a database server, a CI agent, or Docker — you install it globally, configure it once, start it, and it runs.

```
npm install -g collabot    # install the platform
collabot init              # scaffold ~/.collabot/
collabot start             # run the service
npm update -g collabot     # update the platform
```

This is a foundational architectural constraint, not a deployment detail.

## Design Decisions

### D1: Product Ships Zero Content

Product is pure infrastructure. No default roles, no starter skills, no template projects. Scaffolding creates initial content that is instance-owned from birth. There is no override/extension model — everything the user has, they own.

### D2: Global npm Package

The harness publishes as a global npm package with a `bin` entry point. Not a per-project dependency. Not multiple instances per machine. `npm link` provides a zero-infrastructure local dev loop during development.

### D3: Instance at ~/.collabot/

All user-owned content lives under a single root directory, defaulting to `~/.collabot/`. Overridable via `COLLABOT_HOME` environment variable. Sub-paths under the instance root are hard-coded by convention — only the root is configurable.

### D4: TOML Configuration Standard

User-editable Collabot configuration uses TOML.

| Format | Use case | Examples |
|--------|----------|---------|
| **TOML** | User-editable Collabot settings | `config.toml`, `project.toml` |
| **YAML** | Entity frontmatter, 3rd-party conventions | Role/skill/bot `.md` frontmatter, CI pipelines |
| **JSON** | Structured data read by tools, ecosystem conventions | `package.json`, `tsconfig.json`, event logs, task manifests |
| **.env** | Secrets and system paths only | API keys, tokens, `CLAUDE_EXECUTABLE_PATH` |

Operational settings (`max_turns`, `max_budget_usd`, `log_level`) move from `.env` to `config.toml`. The `.env` file is scoped exclusively to secrets and environment-specific system paths.

Libraries: `smol-toml` or `@iarna/toml` (Node/TS), `Tomlyn` (.NET/C#).

### D5: Three Path Domains

| Domain | Resolved from | Contains |
|--------|--------------|----------|
| **Package** | `__dirname` | Compiled harness code. Nothing user-facing. |
| **Instance** | `COLLABOT_HOME` / `~/.collabot/` | Config, roles, skills, prompts, projects, task data, all runtime artifacts. |
| **Project working dirs** | Absolute paths in project manifests | The actual project repositories agents are pinned to at dispatch time. |

No persistent env var needed for the package install location — Node.js resolves via `__dirname` automatically. `COLLABOT_HOME` is the only Collabot-specific env var (optional, has default).

Project paths are absolute in the manifest — decoupled from Collabot's location and structure. Machine-specific by nature.

### D6: Prompts are Instance-Owned

`system.md` and `tools.md` scaffold into `~/.collabot/prompts/` and are user-owned from birth. No sync mechanism between package version and instance prompts on day 1. This is a known gap for wider release — the harness could warn on staleness in the future.

### D7: WS Protocol Versioning

The WebSocket protocol gets a version number. Handshake on connect — harness advertises its protocol version, TUI checks compatibility. Incompatible versions produce a clear error, not silent breakage. This is the contract between the harness and any external client.

### D8: TUI Extraction

The TUI becomes its own project in its own repository. It connects to the harness as an external client via the versioned WS protocol. Own build, own versioning (semver), own conventions (`.editorconfig` + `dotnet format` + conventions doc).

### D9: Big Bang Migration

Single focused effort, clean cut, no dual-mode code. The product repo remains intact as the development workspace. A fresh instance is scaffolded and validated before production cutover.

### D10: Versioning

Both harness and TUI get semver versioning as a prerequisite for packaging. The harness version is in `package.json`. The TUI version is in its `.csproj`.

## Instance Structure

```
~/.collabot/
├── config.toml            # Model aliases, pool size, WS port, agent defaults
├── .env                   # Secrets and system paths only
├── prompts/
│   ├── system.md          # System prompt (scaffolded, user-owned)
│   └── tools.md           # MCP tool docs (scaffolded, user-owned)
├── roles/                 # User's role definitions (.md with YAML frontmatter)
├── skills/                # User's skill definitions
├── .projects/             # Project manifests + task data
│   └── <name>/
│       ├── project.toml   # Project manifest (name, description, absolute paths, roles)
│       └── tasks/         # Task directories
└── ...                    # Additional user-created content
```

## npm Package Contents

```
collabot/
├── package.json           # Dependencies, bin entry, version
├── dist/                  # Compiled JavaScript (from tsc)
│   ├── cli.js             # CLI entry point (collabot start, collabot init)
│   ├── index.js           # Harness entry
│   └── ...                # All compiled modules
└── config.defaults.toml   # Default config values (fallback when user fields are missing)
```

The package ships pre-compiled (`dist/`). No TypeScript source, no dev dependencies, no roles, no skills, no instance content.

## Migration Steps

### Step 1: TOML Conversion (parallel with Step 2)

Convert `config.yaml` → `config.toml`. Add TOML parser to harness. Move operational settings from `.env` to `config.toml`. Update all config loading code. Prove the harness runs on TOML.

### Step 2: Versioning (parallel with Step 1)

Set meaningful semver in harness `package.json` and TUI `.csproj`.

### Step 3: Path Resolution Refactor (depends on Step 1)

Replace `HUB_ROOT` with `COLLABOT_HOME` resolution. Instance paths from env/default, package paths from `__dirname`. All runtime artifacts (sessions, drafts, events) resolve from instance root.

### Step 4: npm Package Setup (depends on Step 3)

Configure `package.json` with `bin` entry, `files` field, `tsc` build step. Create CLI entry point handling `collabot start`, `collabot init`.

### Step 5: `collabot init` Scaffolder (depends on Step 3)

Build the init command. Creates `~/.collabot/` with minimal `config.toml`, `.env` template, `prompts/`, empty `roles/`, `skills/`, `.projects/`.

### Step 6: WS Protocol Versioning (independent, parallel with Steps 3–5)

Add protocol version to harness. Handshake on WS connect — server advertises version, client checks compatibility.

### Step 7: TUI Extraction (depends on Step 6)

Move TUI to its own repository. Update to connect as external client with protocol negotiation. Set up own build, versioning, `.editorconfig` + `dotnet format` + conventions doc.

### Step 8: End-to-End Validation (depends on all above)

`npm link` the package globally. Run `collabot init`. Copy current roles/config into scaffolded instance. Start harness. Connect TUI. Verify: drafting, dispatch, project resolution, MCP tools, event capture.

### Step 9: Production Cutover (depends on Step 8)

Move real roles, skills, projects, config into `~/.collabot/`. This is the live switch.

## Post-Package Roadmap

These are captured and sequenced but do not gate this initiative.

| Topic | Timing | Notes |
|-------|--------|-------|
| Adapter pattern | Post-package | Model, I/O, tools, memory extension points. Codify when second impl arrives. |
| Hooks | Post-package | Extensible harness event handling. Current pipeline seams are clean. |
| Cron jobs | Post-package | Scheduled agent work. Pure additive. |
| Permissions/security | Post-package | Agent permission scoping. Research SDK capabilities first. |
| Temporal awareness | Whenever | Timestamp injection in dispatch system prompt. |
| Prompt staleness detection | Wider release | Warn when instance prompts are older than package version. |
| Agent-owned credentials | Future | Per-bot credential vault. Blocked on bot abstraction. |

## Out of Scope

- **Multiple instances per machine** — Collabot is one instance, one config, one service.
- **Starter kit / opinionated scaffolding** — Minimal scaffold only. Starter content is a future consideration.
- **Prompt sync mechanism** — Known gap. Instance prompts can drift from harness version. Acceptable at current scale.
- **Adapter abstraction** — I/O adapters exist via `CommAdapter` but formal plugin architecture is deferred.
- **Task internals redesign** — Separate spec-discuss cycle, post-separation.
- **Context window optimization** — Research deferred until post-separation when system is representative.
