# Hub Workflow Skills — Roadmap

**Created:** 2026-02-16
**Source:** 12654 Post-Mortem Discussion
**Status:** Implemented skills live in `.claude/skills/`. This file tracks the roadmap only.

## Skill Pipeline

```
/trello-context  →  /spec-discuss  →  /dispatch-plan  →  /status  →  /post-mortem
    (intake)         (design)          (handoff)         (monitor)    (reflect)
     [done]           [done]            [roadmap]         [roadmap]    [done]
```

## Roadmap (pending agent communication / MCP tools)

### `/dispatch-plan`

Bridge between signed-off spec and actual work.

- Reads signed-off spec, identifies affected projects
- Determines dispatch order based on dependencies
- Generates dispatch prompts with business rules and acceptance criteria
- Presents plan for user approval

### `/status`

Feature progress tracking across projects. PM-agent territory but useful in the interim.

- Checks branch state across projects
- Reports what's merged, pending, blocked
- Suggests next steps

### `/retro` (future)

Lightweight mid-feature check-in. Triggered mid-implementation to assess progress and adjust course.
