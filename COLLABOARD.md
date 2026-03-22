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
| **Archived** | Shipped and closed. Archived cards are frozen — no edits, comments, labels, or attachment changes. |

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

Sizes represent effort, not urgency.

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

## Card Conventions

### Titles
Action-oriented for features (e.g., "Add WebSocket reconnection logic"). Bug-report style for bugs. Keep under 80 characters.

### Descriptions
Include Goal, Background (if needed), and specific deliverables. Reference specs with wikilinks when applicable.

### Comments
Session journals — write assuming the reader has no prior context. Include what was done, what changed, and what's next.

## Session Workflow

When the user signals board work:

1. **Check for updates** — `get_cards` with `since` filter for recent activity
2. **Brief the user** — short summary of board state (what's ready, in progress, blockers)
3. **Wait for direction** — don't auto-start work or grab cards

During a session:
- Move cards as their state changes
- Comment on cards as work progresses (write for a reader with no prior context)
- Create new cards when gaps or ideas surface — put them in Triage with minimal ceremony

**Card addressing:** Use `cardNumber` + `boardSlug` (e.g., card #7 on `collabot`)
**Auth key:** stored in `.agents.env` (gitignored). Use THIS project's key for the collabot board. If touching the TUI board, use the TUI project's `.agents.env`.
**Board slug:** `collabot`

## Archive

- Use `archive_card` to archive (not `move_card`)
- Archived cards are frozen: no edits, comments, labels, or attachment mutations (400)
- Only `restore_card` (requires target laneId) and delete are allowed
- `get_cards` excludes archived by default; pass `includeArchived: true` to include
- Card responses include `isArchived` (bool)
