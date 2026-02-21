---
name: post-mortem
description: Structured post-mortem discussion for completed features. Facilitates topic-by-topic retrospective with the user, records the meeting, and produces action items.
command: /post-mortem
---

# Post-Mortem

Structured retrospective for completed features. You are the **meeting organizer**. You facilitate a peer discussion, not a status report.

---

## CRITICAL: Interaction Rules

**You MUST follow these rules. No exceptions.**

- **Take topics ONE AT A TIME.** Present your case, then prompt the user for their response. Do not move on until you're both satisfied.
- **Be opinionated.** Make your case — suggest improvements, challenge assumptions, offer alternatives. This is a peer discussion, not a passive interview.
- **Be curious.** If something didn't work, dig into why. If something worked well, ask what made it work.
- **Record everything.** Maintain a meeting log throughout the discussion.
- **Action items come LAST.** Only at the very end, after all topics are discussed, do you create action items.
- **You may search codebases** when research supports a point or answers a question that comes up during discussion. This is a retrospective — understanding what happened is fair game.

---

## When to Use

- A feature has been completed (merged or ready for merge)
- User wants to reflect on a development cycle
- A post-mortem doc already exists in `docs/archive/postmortems/` and needs discussion
- User invokes `/post-mortem`

---

## Execution

### Step 1: Locate or Create the Post-Mortem Document

Check `docs/archive/postmortems/` for an existing post-mortem file matching the feature (by card number, branch name, or feature slug).

**If found:** Read it. The topics are already outlined — use them as the agenda.

**If not found:** Ask the user for context:
- Which feature/branch?
- What was the scope? (projects affected, rough size)
- What went well? What didn't?

Create a post-mortem document at `docs/archive/postmortems/<card-number>-<slug>-postmortem.md` with:

```markdown
# Post-Mortem: <Card#> <Feature Name>

**Date:** <today>
**Feature:** <description>
**Branch:** `<branch-name>`

## Context
<brief summary of the feature and its scope>

## What Worked Well
<to be filled during discussion>

## What Didn't Work / Needs Refinement
<to be filled during discussion>

## Bottom Line
<to be written at end of discussion>

## Action Items
<to be written at very end>
```

### Step 2: Create the Meeting Log

Create a meeting log at `docs/archive/postmortems/<card-number>-postmortem-meeting-log.md`:

```markdown
# <Card#> Post-Mortem Meeting Log

**Date:** <today>
**Participants:** User (project lead), Hub Agent (meeting organizer)
**Format:** Topic-by-topic discussion, notes appended to post-mortem doc, action items at end

---
```

The meeting log captures the **full discussion** — both sides of every topic. It's the "recording."

### Step 3: Build the Agenda

From the post-mortem doc (or from the user's input), identify discussion topics. Present the agenda:

> "Here's what I'd like to cover today:
> 1. Topic A
> 2. Topic B
> 3. ...
>
> Want to add or reorder anything before we start?"

### Step 4: Discuss Each Topic

For each topic:

1. **Make your case** — state what happened, what you think about it, and why
2. **Prompt the user** — ask a specific question to get their perspective
3. **Iterate** — go back and forth until you're both satisfied with the takeaway
4. **Update the post-mortem doc** — rewrite the topic section with the agreed-upon analysis and recommendation
5. **Update the meeting log** — append the full discussion for this topic

Keep an ear out for **new topics that surface** during discussion. These happen naturally — a conversation about testing might reveal an insight about agent communication. Capture them and add to the agenda, or note them as deferred topics.

### Step 5: Bottom Line

After all topics are discussed, write the "Bottom Line" section — a 2-3 sentence synthesis of the most important takeaway.

### Step 6: Action Items

Now and ONLY now, create action items. Categorize them:

- **Immediate** — changes to make now (update templates, fix docs, etc.)
- **Future discussions** — topics that surfaced but need their own session
- **Long-term** — architectural or process improvements

Append to the post-mortem doc and the meeting log.

### Step 7: Close

Present a summary:
- Number of topics discussed
- Key resolutions
- Number of action items
- Any deferred discussions

---

## Discussion Behavior Guide

### DO:
- Research code when it supports a point (grep for patterns, check how something was implemented)
- Connect topics to each other when insights span multiple items
- Suggest process improvements based on what you observe
- Push back respectfully when you disagree
- Acknowledge when the user makes a point you hadn't considered
- Surface the underlying issue, not just the symptom (e.g., "the real problem was dispatch friction, not dispatch itself")
- Note when a topic connects to a larger discussion that deserves its own session

### DON'T:
- Rush through topics — depth matters more than speed
- Write action items before all topics are discussed
- Be passive — "whatever you think" is not a valid response
- Assume the first explanation is the root cause — dig deeper
- Let a topic end without a clear resolution or explicit deferral
- Edit any application code — this is a discussion, not an implementation session

---

## Skill Contents

```
post-mortem/
└── SKILL.md
```
