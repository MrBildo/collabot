# Feature: [Feature Name]

| Field | Value |
|-------|-------|
| **Source** | [Trello card number/link, or "Ad-hoc" / "Refactoring" / user description] |
| **Status** | Draft / Ready / In Progress / Complete |
| **Created** | YYYY-MM-DD |
| **Last Updated** | YYYY-MM-DD |
| **Release** | [Release name, or "None" if branching directly from master] |
| **Branch** | `feature/{card#}-{slug}` [or `hotfix/{slug}`] |

## Summary

[1-2 paragraph description of the feature, its purpose, and user-facing behavior.]

## Affected Projects

- [ ] **[backend-repo]** — [Brief description of API changes]
- [ ] **[frontend-repo]** — [Brief description of frontend changes]
- [ ] **[mobile-repo]** — [Brief description of mobile changes]

## Implementation Order

1. **[backend-repo]** — [Why first: schema changes, new endpoints, etc.]
2. **[frontend-repo]** — [Why second: consumes new API]
3. **[mobile-repo]** — [If applicable]

---

## API Changes

### New Endpoints

#### `[METHOD] /api/[path]`

**Purpose:** [What this endpoint does]

**Request (C#):**
```csharp
public record ExampleRequest(Guid CharityId, string Name);
```

**Request (TypeScript):**
```typescript
interface ExampleRequest {
  charityId: string;
  name: string;
}
```

**Response (C#):**
```csharp
public record ExampleResponse(Guid Id, string Name, DateTime CreatedAt);
```

**Response (TypeScript):**
```typescript
interface ExampleResponse {
  id: string;
  name: string;
  createdAt: string;
}
```

### Modified Endpoints

[Document any changes to existing endpoints, including before/after shapes]

---

## Database Changes

### New Tables

| Table | Columns | Notes |
|-------|---------|-------|
| [TableName] | [Key columns] | [Relationships, constraints] |

### Modified Tables

| Table | Change | Details |
|-------|--------|---------|
| [TableName] | Add column | [Column name, type, nullable, default] |

### Migration Name

`[Verb][Feature]Migration` (e.g., `AddDonorExportMigration`)

---

## Frontend Changes

### New Components

- `[ComponentName]` — [Purpose, location]

### New Routes

- `/[path]` — [Page description]

### API Hooks

- `use[QueryName]` — [What data it fetches]
- `use[MutationName]` — [What action it performs]

### State Changes

[Any new state management needs]

---

## Mobile Changes

### New Screens

- `[ScreenName]` — [Purpose]

### Navigation Changes

[New navigation entries, tab changes, etc.]

---

## Acceptance Criteria

- [ ] [Specific, testable criterion]
- [ ] [Specific, testable criterion]
- [ ] [Specific, testable criterion]

---

## Test Plan

> **This section is required during spec creation.** Derive test scenarios from the acceptance criteria above and any success criteria or testing steps from the Trello card. Do not leave this for later.

### Prerequisites

- [ ] Target: [LOCAL / STAGE] — confirm with user before testing
- [ ] API running locally (if LOCAL target)
- [ ] Portal running and pointed to correct target
- [ ] [Any feature-specific prerequisites — test data, config, prior steps]

### Test Scenarios

#### Scenario 1: [Name — derived from acceptance criterion]

**Steps:**
1. [Navigate to X]
2. [Perform action Y]
3. [Verify Z]

**Expected Result:** [What should happen]

#### Scenario 2: [Name]

**Steps:**
1. ...

**Expected Result:** ...

#### Edge Cases

- [ ] [Invalid input / empty state / permission boundary / etc.]
- [ ] [Error condition — what should the user see?]

### Playbook Gaps

_List anything the testing agent will likely need to ask about or discover. This helps the agent know upfront what's undocumented._

- [ ] [e.g., "How to navigate to the donor management page — not yet in playbook"]
- [ ] [e.g., "Test account with admin role needed"]

---

## Handoff Prompts

> **Note:** The spec full path is needed so the agent can _read_ the file. But when referencing the spec in PR descriptions, use **just the filename** (e.g., `[feature-name].md`), not the full path.

### [backend-repo]
Open Claude Code in `../[backend-repo]/`
> Check out branch `[branch-name]` (from `[parent-branch]`), then implement the API changes from spec `./docs/specs/[feature-name].md`. [Brief summary of API work]. After implementation, create a PR per the project's PR workflow. In the PR description's Spec Reference field, use just the filename `[feature-name].md`.

### [frontend-repo]
Open Claude Code in `../[frontend-repo]/`
> Check out branch `[branch-name]` (from `[parent-branch]`), then implement the frontend changes from spec `./docs/specs/[feature-name].md`. [Brief summary of frontend work]. After implementation, create a PR per the project's PR workflow. In the PR description's Spec Reference field, use just the filename `[feature-name].md`.

### [mobile-repo]
Open Claude Code in `../[mobile-repo]/`
> Check out branch `[branch-name]` (from `[parent-branch]`), then implement the mobile changes from spec `./docs/specs/[feature-name].md`. [Brief summary of mobile work]. After implementation, create a PR per the project's PR workflow. In the PR description's Spec Reference field, use just the filename `[feature-name].md`.
