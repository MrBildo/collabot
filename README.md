# Collabot

The collaborative agent platform. Dispatches, coordinates, and manages AI coding agents across projects.

[![npm version](https://img.shields.io/npm/v/collabot.svg)](https://npmjs.com/package/collabot)
[![CI](https://github.com/MrBildo/collabot/actions/workflows/ci.yml/badge.svg)](https://github.com/MrBildo/collabot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## What is Collabot?

Collabot is a general-purpose agent orchestration platform. It runs as a persistent service on your machine, dispatching [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agents via the [Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) to work on tasks across multiple projects.

A **project** is a logical product that may span multiple repositories. Collabot provides the infrastructure — projects bring the domain knowledge.

## Architecture

- **Harness** — Node.js/TypeScript orchestration engine (the [npm package](https://npmjs.com/package/collabot))
- **Adapters** — Interfaces that connect to the harness: Slack, CLI, WebSocket, TUI
- **Roles** — Behavioral profiles that define agent identity, model, and permissions
- **Projects** — Logical products registered with the harness, spanning one or more repos

## Quick Start

```
npm install -g collabot
collabot init
collabot start
```

See the [package README](https://npmjs.com/package/collabot) for configuration details.

## Documentation

- [Workflow Process](docs/process/WORKFLOW.md)
- [Agent Orchestration Architecture](docs/process/agent-orchestration-architecture.md)
- [Role System](docs/specs/role-system-v2.md)
- [Platform Vision](docs/vision/authoring-and-knowledge.md)

## Status

Pre-release (`0.x`). Under active development.

## License

[MIT](LICENSE)
