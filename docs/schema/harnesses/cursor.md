# Cursor — Harness Format

**Provider**: Multi-provider (GPT-4, Claude, custom models)
**Status**: Researched (adapter planned)
**Adapter**: planned

## Overview

Cursor is a VS Code fork with integrated ML coding assistance: https://cursor.com

Cursor is **closed-source** and does not expose session logs in a standard format.

## Session Storage

Cursor stores conversation data in its internal SQLite database:

```
~/.cursor/                            # macOS/Linux
%APPDATA%\Cursor\                     # Windows

Internal storage (not documented):
- SQLite databases in extension storage
- Workspace-specific conversation history
- No public JSONL export
```

## What We Know

| Aspect | Details |
|--------|---------|
| Log format | Internal SQLite, not publicly documented |
| Export | No native session export functionality |
| API | Uses various provider APIs (OpenAI, Anthropic) behind a proxy |
| Tool calls | Codebase search, file editing, terminal — via internal tools |
| Thinking | Depends on model (Claude thinking, o-series reasoning) |
| Token tracking | Internal billing, not exposed to users |

## Potential Adapter Approach

1. **Extension API**: Build a Cursor extension that hooks into conversation events and writes unfirehose JSONL
2. **SQLite scraping**: Parse Cursor's internal database (fragile, undocumented)
3. **Proxy logging**: Intercept API calls to log the raw provider messages

The extension approach is recommended for stability.

## Key Differences from Claude Code

| Aspect | Claude Code | Cursor |
|--------|------------|--------|
| Open source | Yes | No |
| Log format | JSONL (documented) | Internal SQLite |
| Session export | Native | Not available |
| Multi-model | One model per session | Can switch per request |
| IDE | Terminal-based | VS Code fork |
| MCP support | Yes | Yes (via extensions) |
