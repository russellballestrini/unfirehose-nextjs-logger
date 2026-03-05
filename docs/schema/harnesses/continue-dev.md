# Continue.dev — Harness Format

**Provider**: Multi-provider (OpenAI, Anthropic, Ollama, etc.)
**Status**: Researched (adapter planned)
**Adapter**: planned

## Overview

Continue is an open-source coding assistant as a VS Code/JetBrains extension: https://github.com/continuedev/continue

## Session Storage

Continue stores session history in JSON files:

```
~/.continue/sessions/                  # Session storage
~/.continue/config.json                # Configuration
~/.continue/dev_data/                  # Analytics/telemetry data
```

### Session Format

```jsonc
{
  "sessionId": "abc-123-...",
  "title": "Fix login page",
  "dateCreated": "2026-03-05T10:42:45Z",
  "history": [
    {
      "message": {
        "role": "user",
        "content": "Fix the login page"
      },
      "contextItems": [
        {
          "name": "login.css",
          "description": "File contents",
          "content": "..."
        }
      ]
    },
    {
      "message": {
        "role": "assistant",
        "content": "I'll fix the login page..."
      },
      "edits": [
        {
          "filepath": "src/login.css",
          "replacement": ".login-form { display: flex; }"
        }
      ]
    }
  ]
}
```

## Field Mapping → Unfirehose

| Continue.dev | Unfirehose | Transform |
|---|---|---|
| `history[].message.role` | `role` | direct |
| `history[].message.content` | `content: [{type: "text", text}]` | wrap in block |
| `history[].contextItems` | not mapped | context, not messages |
| `history[].edits[].filepath` | `content[].toolName: "Edit"` | extract as tool-call |
| `sessionId` | `sessionId` | direct |
| `dateCreated` | `createdAt` | rename |

## Adapter Challenges

1. **JSON not JSONL**: Sessions are full JSON documents, not append-only streams
2. **Context items**: Rich context (file contents, codebase search) attached to messages but not tool calls
3. **Edits inline**: File edits are part of the assistant message, not separate tool calls
4. **No token tracking**: Usage not logged in session files
5. **No timestamps per message**: Only session creation time

## Key Differences from Claude Code

| Aspect | Claude Code | Continue.dev |
|--------|------------|-------------|
| Format | JSONL (append-only) | JSON (full document) |
| Tool calls | Named function calls | Inline edits |
| Context | Implicit (model sees files) | Explicit `contextItems` |
| Token tracking | Full | None in logs |
| Open source | Yes (CLI) | Yes (extension) |
| IDE | Terminal | VS Code / JetBrains |
