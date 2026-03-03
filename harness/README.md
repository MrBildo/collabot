# collabot

The Collaborative Agent Platform. Dispatch, coordinate, and manage AI bots across your projects.

[![npm version](https://img.shields.io/npm/v/collabot.svg)](https://npmjs.com/package/collabot)
[![CI](https://github.com/MrBildo/collabot/actions/workflows/ci.yml/badge.svg)](https://github.com/MrBildo/collabot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/MrBildo/collabot/blob/master/LICENSE)

Collabot is home base for your AI bots. It dispatches bots to work on tasks across your projects. You define projects, roles, and bots. Collabot handles dispatch, coordination, event capture, context reconstruction, and communication across four adapters (Slack, CLI, WebSocket, TUI).

## Install

```
npm install -g collabot
```

## Quick start

```
collabot init          # scaffold ~/.collabot/
collabot start         # start the harness
```

`collabot init` creates an instance directory at `~/.collabot/` with default configuration, prompt templates, and empty directories for roles, bots, skills, and projects. Edit `~/.collabot/config.toml` to configure model aliases, agent defaults, and adapter settings.

## Commands

| Command | Description |
|---------|-------------|
| `collabot init` | Scaffold a new instance at `~/.collabot/` |
| `collabot start` | Start the harness |
| `collabot dispatch` | One-shot CLI dispatch |
| `collabot --version` | Print version |
| `collabot --help` | Show help |

## Configuration

Instance configuration lives at `~/.collabot/config.toml`. Key sections:

- **models** — Default model and aliases (e.g., `opus-latest`, `sonnet-latest`)
- **agent** — Max turns and budget per dispatch
- **bots** — Bot definitions with default project and role assignments
- **slack** — Slack adapter settings and per-bot credentials
- **ws** — WebSocket server port and host
- **logging** — Log level (`minimal`, `debug`, `verbose`)

Override the instance location with the `COLLABOT_HOME` environment variable:

```
COLLABOT_HOME=/path/to/instance collabot start
```

Secrets (API keys, bot tokens) go in `~/.collabot/.env`.

## Requirements

- Node.js >= 22
- An AI provider API key configured

## Links

- [GitHub](https://github.com/MrBildo/collabot)
- [Documentation](https://github.com/MrBildo/collabot/tree/master/docs)
- [Issues](https://github.com/MrBildo/collabot/issues)

## License

[MIT](https://github.com/MrBildo/collabot/blob/master/LICENSE)
