# Tickets

Tasks that take **over 15 minutes** or require **human planning to unblock** live here as markdown files.

## Why tickets exist

Todos extracted from Claude Code sessions are cheap — agents create hundreds of them per day. Most are small (under 15 minutes) and can be knocked out inline. But some have diverged from reality: the codebase moved on, the approach changed, dependencies shifted, or the task was never clearly scoped.

These need human eyes before an agent should touch them.

## Ticket lifecycle

```
todo (pending, >15m or blocked) → ticket file created → fox reviews → agent works it → completed → ticket archived
```

## File format

Each ticket is `docs/tickets/NNNN-slug.md` where NNNN is the todo ID from the database.

```markdown
# NNNN: Short title

**Status:** open | in-progress | blocked | done
**Project:** project-name
**Estimated:** Xm
**Todo IDs:** 1234, 1235 (if consolidating multiple)
**Blocked by:** description of what needs human input

## Context
What the original todo was about and why it's a ticket now.

## Plan
Steps to complete this. Agent fills this in, fox approves.

## Notes
Discussion, decisions, links.
```

## Creating tickets

Agents can auto-generate ticket files from the API:

```bash
# Find ticket-worthy todos
curl localhost:3000/api/todos/pending?needs_ticket=true

# Find stale todos (not touched in 7+ days, likely diverged from main)
curl localhost:3000/api/todos/stale?days=7

# After creating the ticket file, set the estimate on the todo
curl -X PATCH localhost:3000/api/todos/bulk \
  -H 'Content-Type: application/json' \
  -d '{"ids": [1234], "estimatedMinutes": 30}'
```

## Rules

- Under 15 minutes? Just do it. No ticket needed.
- Over 15 minutes? Create a ticket. Get fox's approval on the plan before starting.
- Blocked on human input? Create a ticket with `blocked` status and describe what you need.
- Stale todo that no longer matches reality? Create a ticket to reassess, or bulk-close as obsolete.
- Consolidate related todos into one ticket when they're really the same work.
