# Messages Schema

The atomic unit of unfirehose logging. One JSONL line per message.

## Canonical Format

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "message",
  "id": "msg_019abc...",              // unique message ID (UUID or provider ID)
  "sessionId": "4e0f77f7-...",        // parent session UUID
  "parentId": "msg_018xyz...",         // conversation tree parent (null for roots)
  "role": "user|assistant|system|tool",
  "timestamp": "2026-03-05T10:42:45.161Z",

  // Content: always an array of typed blocks
  "content": [
    { "type": "text", "text": "Fix the login page" },
    { "type": "reasoning", "text": "Let me think about..." },
    { "type": "tool-call", "toolCallId": "tc_01...", "toolName": "Bash", "input": { "command": "ls" } },
    { "type": "tool-result", "toolCallId": "tc_01...", "toolName": "Bash", "output": "file.txt", "isError": false },
    { "type": "image", "mediaType": "image/png", "data": "base64..." },
    { "type": "file", "mediaType": "application/pdf", "data": "base64..." }
  ],

  // Model info (assistant messages only)
  "model": "claude-opus-4-6",
  "stopReason": "end_turn|tool_calls|length|content_filter|error",
  "provider": "anthropic|google|openai|local",

  // Token usage (assistant messages only)
  "usage": {
    "inputTokens": 3,
    "outputTokens": 78,
    "inputTokenDetails": {
      "cacheReadTokens": 12233,
      "cacheWriteTokens": 0,
      "noCacheTokens": 3
    },
    "outputTokenDetails": {
      "textTokens": 60,
      "reasoningTokens": 18
    },
    "totalTokens": 12314
  },

  // System message fields
  "subtype": "turn_duration|session_end|init",
  "durationMs": 5432,

  // Context
  "sidechain": false,                 // true for subagent/parallel execution
  "cwd": "/home/fox/git/myproject",
  "gitBranch": "main",
  "harness": "claude-code",           // originating harness
  "harnessVersion": "2.1.69"
}
```

## Roles

| Role | Description | Content Blocks |
|------|-------------|----------------|
| `user` | Human input or tool results | text, tool-result, image, file |
| `assistant` | Model response | text, reasoning, tool-call |
| `system` | Harness metadata events | text (turn duration, session lifecycle) |
| `tool` | Tool-role messages (OpenAI convention) | tool-result |

## Content Block Types

| Block Type | Fields | Vercel AI SDK Equivalent |
|------------|--------|--------------------------|
| `text` | `text` | `TextPart` |
| `reasoning` | `text` | `ReasoningPart` |
| `tool-call` | `toolCallId`, `toolName`, `input` | `ToolCallPart` |
| `tool-result` | `toolCallId`, `toolName`, `output`, `isError` | `ToolResultPart` |
| `image` | `mediaType`, `data` | `ImagePart` |
| `file` | `mediaType`, `data` | `FilePart` |

**Linking**: `toolCallId` links a `tool-call` block to its `tool-result` block. The call appears in an assistant message; the result appears in the next user or tool-role message.

## Usage Object

```typescript
interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  outputTokenDetails?: {
    textTokens?: number;
    reasoningTokens?: number;
  };
}
```

**Important**: `inputTokens` is exclusive of cache tokens in the Anthropic API. `totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens` if you want the full context window count.

## Multi-Step Tool Execution

A single user prompt may trigger multiple LLM round-trips (steps), each with its own tool calls and results. The `parentId` field threads them:

```
msg_001 (user, parentId: null)     "Fix the login page"
msg_002 (assistant, parentId: 001)  [reasoning, tool-call: Bash]
msg_003 (user, parentId: 002)       [tool-result: Bash output]
msg_004 (assistant, parentId: 003)  [reasoning, tool-call: Edit]
msg_005 (user, parentId: 004)       [tool-result: Edit success]
msg_006 (assistant, parentId: 005)  [text: "Done, I fixed the CSS"]
```

The Vercel AI SDK collapses these into `steps[]` on the result object. The unfirehose format keeps them as individual messages for streaming/append-only compatibility but supports reconstructing steps via `parentId` chains.

## Database Mapping

| JSON Field | DB Column | Table |
|---|---|---|
| `id` | `message_uuid` | messages |
| `parentId` | `parent_uuid` | messages |
| `role` | `type` | messages |
| `content[]` | rows in content_blocks | content_blocks |
| `content[].type: "reasoning"` | `block_type: "thinking"` | content_blocks |
| `content[].type: "tool-call"` | `block_type: "tool_use"` | content_blocks |
| `content[].type: "tool-result"` | `block_type: "tool_result"` | content_blocks |
| `usage.inputTokens` | `input_tokens` | messages |
| `usage.outputTokens` | `output_tokens` | messages |
| `usage.inputTokenDetails.cacheReadTokens` | `cache_read_tokens` | messages |
| `usage.inputTokenDetails.cacheWriteTokens` | `cache_creation_tokens` | messages |

Note: the database uses `snake_case` and Anthropic-era names internally. The canonical JSON uses `camelCase` and provider-neutral names. The ingestion layer handles the mapping.
