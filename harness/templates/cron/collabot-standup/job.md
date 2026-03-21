---
name: collabot-standup
schedule: "0 9 * * MON-FRI"
role: researcher
# project: <your-project-name>  — set to a real project (not a virtual project like lobby)
singleton: true
tokenBudget: 100000
maxTurns: 5
---

Generate a daily standup report for the project's Collaboard board.

Check:
1. Cards in Review — anything waiting for merge?
2. Cards in In Progress — any stale (no activity in 2+ days)?
3. Cards in Triage — any ready to move to Ready?
4. Recent Done cards — what shipped since last standup?

Format as a brief standup summary. Add as a comment on the first card in the Review lane, or create a new card in Triage if there are actionable findings.
