# collabot

The collaborative agent platform — dispatch, coordinate, and manage AI coding agents.

[![npm version](https://img.shields.io/npm/v/collabot.svg)](https://npmjs.com/package/collabot)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/MrBildo/collabot/blob/master/LICENSE)

## Install

```
npm install -g collabot
```

## Quick Start

```
collabot init          # scaffold ~/.collabot/
collabot start         # start the harness
```

`collabot init` creates an instance directory at `~/.collabot/` with default configuration, prompt templates, and empty directories for roles, skills, and projects. Edit `~/.collabot/config.toml` to configure model aliases, agent defaults, and the WebSocket port.

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
- **ws** — WebSocket server port and host
- **logging** — Log level (`minimal`, `debug`, `verbose`)

Override the instance location with the `COLLABOT_HOME` environment variable:

```
COLLABOT_HOME=/path/to/instance collabot start
```

Secrets (API keys, tokens) go in `~/.collabot/.env`.

## Requirements

- Node.js >= 22
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- Anthropic API key configured

## Links

- [GitHub](https://github.com/MrBildo/collabot)
- [Documentation](https://github.com/MrBildo/collabot/tree/master/docs)
- [Issues](https://github.com/MrBildo/collabot/issues)

## License

[MIT](https://github.com/MrBildo/collabot/blob/master/LICENSE)
