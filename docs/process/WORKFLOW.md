# Feature Planning Workflow

## Overview

This workspace is for planning cross-project features. The workflow produces a **feature spec** that sub-project agents consume during implementation.

## Pre-Flight Checklist

Before starting any task, verify these in order:

1. **Spec exists?** Scan `docs/specs/` for a matching file (by card # or slug). If found, confirm with user before overwriting.
2. **Task tracker context?** If a card/ticket is referenced, fetch its details (via `/trello-context` or equivalent). If it fails to find the card, **STOP and ask the user** — options: retry, different card number, different board, or proceed with user-provided requirements only. Never plow ahead without card context.
3. **Release branch?** Check the project's release tracking — branch from the active release if the project is listed, otherwise from master.
4. **Read the user's words** — don't assume defaults when the user explicitly states something (board name, branch, scope, etc.).

## Step-by-Step Process

### 1. Gather Task Context

**Check for an existing spec first.** Before fetching from Trello, scan `docs/specs/` for a matching spec file (by card number or feature slug). If a spec exists, present it to the user and ask whether to skip Trello and proceed from the existing spec. An existing spec may already contain everything needed — or may need updating, but either way it's the faster starting point.

**From a task tracker card (no existing spec):** Fetch card details using the appropriate integration (e.g., `/trello-context` for Trello boards). If the card isn't found, **stop and ask the user** before proceeding — the card may contain screenshots, requirements, or corrections that are critical to the implementation.

**Without a card:** The user describes the task directly (refactoring, tech debt, ad-hoc feature, etc.). Capture the requirements in conversation, then proceed to impact analysis. No Trello fetch needed — the spec itself becomes the single source of truth.

### 2. Discuss Before Speccing

Before writing the spec, **discuss the feature with the user**. The orchestration agent is a partner, not an assembly line. Be curious and ask questions — each card is an opportunity to surface ambiguity, challenge assumptions, and align on approach.

Good things to discuss:
- Competing design directions (mockups, alternative approaches)
- Styling/UX decisions that aren't fully resolved in the card
- Data model questions (where does the data live? what joins are needed?)
- Scope boundaries (what's in, what's explicitly out)
- Which existing components/endpoints can be reused

Present your understanding back to the user with numbered questions. Let them answer in whatever order makes sense. Only write the spec once alignment is clear.

### 3. Analyze Cross-Project Impact

Using the gathered context and the project's ecosystem documentation:

- Identify which projects are affected (API, portal, mobile, or combinations)
- Determine if API changes are needed (new endpoints, modified responses)
- Check if database changes are required (new tables, columns, migrations)
- Assess frontend impact (new pages, components, API hook changes)
- Assess mobile impact (new screens, navigation changes)

### 4. Write Feature Spec

Create a spec file at `docs/specs/<feature-name>.md` using the template at `docs/specs/TEMPLATE.md`.

The spec should be **self-contained** — a sub-project agent should be able to implement its portion by reading only the spec file, without needing access to this workspace's other documents.

Include:
- Clear summary of the feature
- Affected projects checklist
- Implementation order
- API contract details (endpoints, request/response shapes in both C# and TypeScript)
- Database changes (if any)
- Frontend changes (component structure, routes, state management)
- Mobile changes (if any)
- Acceptance criteria
- **Test plan** — derived from the acceptance criteria and any success criteria or testing steps from the Trello card. This is not optional; the test plan is authored during spec creation. See the Test Plan section in the template.

### 5. Define Implementation Order

The recommended default order is:

1. **Database + API** (backend repo) — schema changes, migrations, endpoints
2. **Frontend** (web portal repo) — consume new/modified API
3. **Mobile** (mobile app repo) — consume new/modified API

This order ensures each consumer has working endpoints to integrate with.

### 6. Plan Branching

Determine the correct branch name and parent branch for this feature. Check the project's release tracking for active releases.

**Release active -> feature from release branch:**
Branch: `feature/{card#}-{slug}` from `release/{name}`. If there's no Trello card, use `feature/{slug}`.

**No active release -> feature from master:**
Branch: `feature/{card#}-{slug}` from `master`. If there's no Trello card, use `feature/{slug}`.

**Multiple releases active -> ask the user** which release this feature belongs to.

**Hotfix (user explicitly requests) -> hotfix from master:**
Branch: `hotfix/{slug}` from `master`.

In all cases: recommend the branch name -> user confirms -> record in the spec header (Release + Branch fields) and update the project's release tracking if a release is active.

### 7. Hand Off to Sub-Projects

At the end of each spec, include **ready-to-paste prompts** for each affected project. Each prompt should include the branch name and parent branch so the sub-project agent knows where to start.

```
## Handoff Prompts

### backend-api
Open Claude Code in `../backend-api/`
> Check out branch `feature/1234-my-feature` (from `release/v2`), then implement the API changes from `./docs/specs/my-feature.md`. After implementation, create a PR per the project's PR workflow.

### web-portal
Open Claude Code in `../web-portal/`
> Check out branch `feature/1234-my-feature` (from `release/v2`), then implement the frontend changes from `./docs/specs/my-feature.md`. After implementation, create a PR per the project's PR workflow.
```

**Always include the PR instruction in the handoff prompt.** Sub-project agents create PRs as soon as implementation is done — don't wait for cross-project testing. PRs target the release branch (feature -> release), giving the user a place to review diffs immediately. Testing validates the release as a whole, not individual feature PRs.

### Session Management

The orchestration session stays alive as **home base** throughout the release. Sub-project sessions are opened and closed as needed.

- **Orchestration session (this workspace):** Tracks the release, writes specs, coordinates handoffs, resolves cross-project questions, dispatches testing
- **Sub-project sessions:** Implement from specs, create PRs, then close
- If a coding agent surfaces a question that crosses project boundaries (e.g., API contract ambiguity), the user brings it back to the orchestration session to resolve

### 8. Test the Implementation

After sub-project agents have implemented their changes, testing is dispatched to the designated **testing project** (e.g., via the `qa-dev` role). See the testing project's documentation for the full process.

1. **Confirm environment** — Ask the user: LOCAL or STAGE? Is the API running? Is the portal running?
2. **Read the playbook** — Check the testing project's playbook for documented procedures (auth, navigation, common flows)
3. **Execute the test plan** — Run each scenario from the feature spec's Test Plan section using Playwright CLI
4. **Ask when stuck** — If the playbook doesn't cover something, ask the user. Do not guess.
5. **Report results** — Pass/fail for each scenario, with screenshots for failures
6. **Update the playbook** — Document every new procedure or discovery learned during this session
7. **Clean up** — Close the browser, remove temp files

If tests fail, report the failures to the user. Fixes happen in sub-project sessions, then re-test.

### 9. Review Pull Requests

PRs are created during handoff (step 7), not after testing. By this point, PRs should already exist for each sub-project. After testing passes:

1. User reviews each PR (diffs are already up on Bitbucket)
2. User approves and merges (feature -> release)
3. Agent NEVER merges its own PR

If testing found issues, fixes are committed to the existing feature branch and the PR updates automatically.

## Spec File Conventions

- **Filename:** Kebab-case matching the feature name: `donor-export.md`, `journey-reminders.md`
- **Location:** `docs/specs/`
- **Template:** `docs/specs/TEMPLATE.md`
- **Status tracking:** Use the status field in the spec header (Draft -> Ready -> In Progress -> Complete)

## Between-Milestone Cleanup

After completing a milestone (post-mortem done, before planning the next), the PM runs through this checklist. This is a codified step, not optional — nobody else owns cleanup.

1. **Delete test artifacts** — journal files from test dispatches, temp files, test outputs
2. **Archive/update milestone spec** — mark the milestone spec as complete, note any deviations from the plan
3. **Write the handoff doc** — current state, what was built, what's next, known gaps
4. **Review memory** — check `.claude/projects/*/memory/MEMORY.md` for stale entries, remove outdated notes
5. **Clean dispatch prompts** — delete one-off prompt files (e.g., `docs/specs/dispatch-prompts/`) that were used during the build
6. **`git status`** — make sure nothing unexpected is uncommitted across all repos
7. **Update WORKFLOW.md or spec docs** if the milestone surfaced process improvements (like this section)

Five minutes, every milestone boundary. Prevents cruft accumulation.

## Post-Implementation

After all sub-projects have implemented the feature:

1. Update the spec status to **Complete**
2. Verify all PRs have been merged across sub-projects
3. If new API endpoints were added, note them in the project's API contracts doc
4. If architectural patterns changed, update the project's ecosystem doc
5. Consider whether business logic changes warrant unit tests — not every change needs tests, but invariant enforcement and conditional logic are good candidates
6. When all specs in a release are Complete and merged, update the project's release tracking
