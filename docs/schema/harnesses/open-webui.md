# Open WebUI — Harness Format

**Provider**: Multi-provider (Ollama, OpenAI, Anthropic, local)
**Status**: Researched (adapter planned)
**Adapter**: `packages/core/open-webui-adapter.ts` (planned — SQLite extractor)

## Overview

Open WebUI is a self-hosted ChatGPT-like interface: https://github.com/open-webui/open-webui

Web-based frontend that connects to Ollama, OpenAI, and other backends. Stores conversations in a local SQLite database.

## File Location

```
~/.open-webui/webui.db             # SQLite database (default)
# Or Docker volume: /app/backend/data/webui.db
```

## Native Format

### Database Schema (Key Tables)

```sql
-- Conversations
CREATE TABLE chat (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    title TEXT,
    chat TEXT,              -- JSON blob with full message history
    created_at REAL,
    updated_at REAL,
    share_id TEXT,
    archived INTEGER DEFAULT 0
);

-- The chat.chat column contains:
{
  "messages": [
    {
      "id": "msg_001",
      "role": "user",
      "content": "Fix the login page",
      "timestamp": 1709632965
    },
    {
      "id": "msg_002",
      "parentId": "msg_001",
      "role": "assistant",
      "content": "I'll help fix the login page...",
      "model": "llama3.1:70b",
      "timestamp": 1709632970,
      "info": {
        "total_duration": 2145000000,
        "prompt_eval_count": 12,
        "eval_count": 156
      }
    }
  ],
  "history": {
    "currentId": "msg_002",
    "messages": { /* tree structure for branching conversations */ }
  }
}
```

## Field Mapping -> Unfirehose

| Open WebUI | Unfirehose | Transform |
|---|---|---|
| `chat.id` | `sessionId` | rename |
| `chat.title` | `sessionTitle` | rename |
| `messages[].id` | `id` | rename |
| `messages[].parentId` | `parentId` | rename |
| `messages[].role` | `role` | identity |
| `messages[].content` | `content: [{type: "text"}]` | wrap |
| `messages[].model` | `model` | identity |
| `messages[].timestamp` | `timestamp` | epoch to ISO |
| `messages[].info.prompt_eval_count` | `usage.inputTokens` | extract |
| `messages[].info.eval_count` | `usage.outputTokens` | extract |
| `chat.created_at` | session `startedAt` | epoch to ISO |

## Adapter Strategy

1. Read SQLite database directly
2. Parse `chat` JSON column for each conversation
3. Handle branching conversation trees (Open WebUI supports message regeneration/branching)
4. Incremental ingestion by tracking `updated_at` timestamps

## Adapter Challenges

1. **SQLite access**: Need read access to the database file (may be in a Docker volume)
2. **Branching conversations**: Message tree structure requires flattening to linear session
3. **JSON-in-SQLite**: Full conversation stored as JSON blob in a TEXT column
4. **Multi-model per chat**: Users can switch models mid-conversation
5. **No tool calls**: Open WebUI is primarily a chat interface, not a coding agent
6. **Image uploads**: Multi-modal messages include base64 image data

## Key Differences from Claude Code

| Aspect | Claude Code | Open WebUI |
|--------|------------|------------|
| Type | CLI coding agent | Web chat interface |
| Storage | JSONL files | SQLite database |
| Conversation model | Linear | Branching tree |
| Provider | Anthropic | Multi-provider |
| Tools | Full agent toolset | None (chat only) |
| Thinking | Extended thinking blocks | Not supported |
| Use case | Code generation | General chat |
