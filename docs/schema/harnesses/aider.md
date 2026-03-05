# Aider — Harness Format

**Provider**: Multi-provider (OpenAI, Anthropic, local)
**Status**: Documented (adapter planned)
**Adapter**: `packages/core/aider-adapter.ts` (planned — markdown parser)

## Overview

Aider is an open-source coding assistant: https://github.com/paul-gauthier/aider

Unlike other harnesses, Aider logs in **Markdown**, not JSON/JSONL.

## File Location

```
{project-root}/.aider.chat.history.md    # conversation history
{project-root}/.aider.input.history       # user input history (readline)
{project-root}/.aider.tags.cache.v3/     # ctags cache
```

## Native Format

### Chat History (Markdown)

```markdown
# aider chat started at 2026-03-05 10:42:45

#### /ask Fix the login page

I'll help fix the login page. Let me look at the relevant files.

#### /code Fix the CSS flexbox issue in login.css

I'll fix the flexbox issue:

```css
login.css
<<<<<<< SEARCH
.login-form {
  display: block;
}
=======
.login-form {
  display: flex;
  flex-direction: column;
}
>>>>>>> REPLACE
```

Done! The login form now uses flexbox.
```

### Message Types

| Marker | Role | Description |
|--------|------|-------------|
| `# aider chat started at` | session start | Session header |
| `#### /ask ...` | user (question) | User prompt in ask mode |
| `#### /code ...` | user (edit request) | User prompt in code mode |
| `#### /architect ...` | user (design) | User prompt in architect mode |
| `#### ...` (no slash) | user | General user message |
| Unmarked text blocks | assistant | Model response |
| `<<<<<<< SEARCH` / `>>>>>>> REPLACE` | tool-call (Edit) | File edit diff |

## Field Mapping → Unfirehose

| Aider Element | Unfirehose | Transform |
|---|---|---|
| `# aider chat started` | Session header | Parse timestamp |
| `#### /ask {text}` | `role: "user"`, `content: [{type: "text"}]` | Extract text |
| `#### /code {text}` | `role: "user"`, `content: [{type: "text"}]` | Extract text |
| Unmarked paragraphs | `role: "assistant"`, `content: [{type: "text"}]` | Extract text |
| SEARCH/REPLACE blocks | `role: "assistant"`, `content: [{type: "tool-call", toolName: "Edit"}]` | Parse diff format |
| Git commit messages | `role: "system"`, `subtype: "commit"` | Extract |

## Adapter Challenges

1. **Markdown parsing**: No structured delimiters — relies on heading patterns
2. **No timestamps per message**: Only session start time is logged
3. **No token usage**: Aider doesn't log API token counts in the history file
4. **No message IDs**: Must be generated during ingestion
5. **Multi-model**: Aider can switch models mid-session (architect vs coder)
6. **Edit format**: The SEARCH/REPLACE block is unique to Aider

## Tools

Aider's "tools" are implicit — the model outputs diffs in a specific format rather than calling named functions:

| Aider Operation | Canonical Name | Notes |
|-----------------|---------------|-------|
| SEARCH/REPLACE blocks | `Edit` | Aider's core edit format |
| `/run {command}` | `Bash` | Shell execution |
| `/add {file}` | `Read` | Add file to context |
| `/web {url}` | `WebFetch` | Fetch URL content |

## Thinking Support

Not supported. Aider uses text-only model outputs. Some models may include reasoning in the visible text, but there's no separate thinking block.

## Key Differences from Claude Code

| Aspect | Claude Code | Aider |
|--------|------------|-------|
| Format | JSONL | Markdown |
| Structure | Typed blocks | Freeform text with patterns |
| Tool calls | Named function calls | SEARCH/REPLACE diffs |
| Timestamps | Per message | Per session only |
| Token tracking | Full | None in logs |
| Thinking | Separate blocks | Not supported |
| Multi-model | One model per session | Can switch mid-session |
