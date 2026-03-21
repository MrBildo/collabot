# Collaboard — Collabot

Work is tracked on Collaboard (MCP server). Auth key is in `.agents.env` (gitignored).

**Board slug:** `collabot`

## Lanes

| Lane | Purpose |
|------|---------|
| **Backlog** | Prioritized, ready to pick up |
| **Triage** | New items land here, need sizing/discussion |
| **Ready** | Sized, scoped — agents can pick these up |
| **In Progress** | Actively being worked on |
| **Review** | PR open, awaiting user review |
| **Done** | Merged to master |
| **Archived** | Cleared periodically |

## Labels

### Type

| Label | Color | Meaning |
|-------|-------|---------|
| `Feature` | green | `feat:` commits — new functionality |
| `Bug` | orange-red | `fix:` commits — defects |
| `Improvement` | blue | `refactor:` / minor enhancements |
| `Chore` | gray | CI, deps, tooling |
| `Docs` | teal | Documentation |
| `Infrastructure` | dark gray | Build, deploy, CI infrastructure |
| `Investigation` | yellow | Research-driven work |
| `Discussion` | purple | Needs conversation before action |

### Component

| Label | Color | Meaning |
|-------|-------|---------|
| `Harness` | orange | Core harness engine |
| `Adapter` | lime | Communication adapters (Slack, WS, CLI) |
| `Entity` | cyan | Entity model (bots, roles, projects) |
| `Context` | pink | Context reconstruction, memory |
| `Security` | light blue | Auth, permissions, secrets |

### Status (transient)

| Label | Color | Meaning |
|-------|-------|---------|
| `Blocked` | red | Can't proceed, external dependency |
| `CLI Parity` | cyan | On the daily driver critical path |

## Sizes

| Size | Ordinal |
|------|---------|
| S | 0 |
| M | 1 |
| L | 2 |
| XL | 3 |

## Workflow

1. New items → **Triage** with type + component labels
2. Size (S/M/L/XL), prioritize → **Backlog**
3. User approves for work → **Ready** (agents should only pick up cards from Ready)
4. Pick up → **In Progress**, create a feature branch, comment with plan
5. PR open → **Review**, add comment with branch name and/or PR link
6. PR merged → **Done**
7. Periodically sweep Done → **Archived**

## Session Protocol

- **Start of session:** Call `get_cards` with the Collabot board slug to see current state
- **Check for changes:** Use `get_cards` with the `since` parameter to see cards with recent activity
- **During work:** Move cards between lanes, add comments logging progress, attach deliverables
- **Auth key:** Use the key from THIS project's `.agents.env` for the Collabot board. If you need to touch the TUI board, use the key from the TUI project's `.agents.env`.
- **Board slug:** `collabot`
