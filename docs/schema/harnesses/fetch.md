# Fetch — Harness Format

**Provider**: Anthropic (uses Claude models)
**Status**: Supported
**Adapter**: Identity (same format as Claude Code)

## File Location

```
~/.fetch/sessions/{project-slug}/{session-uuid}.jsonl
```

## Format

Identical to [Claude Code](./claude-code.md). Fetch uses the same Anthropic API and logs in the same JSONL format.

## Key Differences

| Aspect | Claude Code | Fetch |
|--------|------------|-------|
| Base dir | `~/.claude/projects/` | `~/.fetch/sessions/` |
| Project naming | Slug from cwd | Prefixed `fetch:` in database |
| Display name | Project name | `[fetch] {name}` |
| Tool set | Full coding tools | Subset (Read, Bash, WebFetch) |
| Session index | `sessions-index.json` | Same format |

## Ingestion

During ingestion, Fetch sessions are tagged with `source: "fetch"` and their projects are prefixed to distinguish from Claude Code projects that may share the same directory.

The field mapping is identical to Claude Code — no separate adapter needed.
