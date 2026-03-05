# Thought Traces Schema

Extended thinking / chain-of-thought reasoning blocks within assistant messages.

## Content Block Format

```jsonc
{
  "type": "reasoning",
  "text": "The user wants me to fix the CSS. Let me first check what files exist...",
  "signature": "ErUB..."    // optional: Anthropic thinking signature for verification
}
```

Reasoning blocks appear in `assistant` messages alongside `text` and `tool-call` blocks. They represent the model's chain-of-thought before acting.

## Thinking Chain

A **thinking chain** is the sequence of all reasoning blocks across a session, read in timestamp order. It shows how the model's understanding evolved through a task.

```jsonc
// Message 1 (assistant)
{
  "content": [
    { "type": "reasoning", "text": "The user wants me to fix the CSS..." },
    { "type": "tool-call", "toolName": "Grep", "input": { "pattern": "login" } }
  ]
}

// Message 3 (assistant, after tool result)
{
  "content": [
    { "type": "reasoning", "text": "Found the file. The issue is the flex layout..." },
    { "type": "tool-call", "toolName": "Edit", "input": { "..." } }
  ]
}

// Message 5 (assistant, after tool result)
{
  "content": [
    { "type": "reasoning", "text": "Edit applied. Let me verify it works..." },
    { "type": "text", "text": "Done, I fixed the flexbox issue in login.css" }
  ]
}
```

### Extracting a Thinking Chain

```sql
SELECT cb.text_content, m.timestamp, m.model
FROM content_blocks cb
JOIN messages m ON cb.message_id = m.id
JOIN sessions s ON m.session_id = s.id
WHERE s.session_uuid = ? AND cb.block_type = 'thinking'
ORDER BY m.timestamp, cb.position;
```

## Cross-Harness Support

| Harness | Thinking Support | Block Type | Notes |
|---------|-----------------|------------|-------|
| Claude Code | Full | `type: "thinking"` native → `reasoning` canonical | Extended thinking with signature |
| Fetch | Full | Same as Claude Code | Uses Claude models |
| Gemini CLI | Partial | `thinkingConfig` parameter | No separate output block yet; may need inference |
| OpenAI Codex | Hidden | o-series has internal "reasoning" | Tokens counted but text not exposed |
| Aider | None | — | Uses text-only models typically |
| uncloseai-cli | None | — | Hermes 3 doesn't have extended thinking |
| hermes-agent | None | — | Local models, no thinking API |
| agnt | Planned | Native `reasoning` blocks | Will ship with unfirehose/1.0 |

## Provider Field Maps

### Anthropic → Unfirehose

| Anthropic | Unfirehose | Notes |
|---|---|---|
| `content[].type: "thinking"` | `content[].type: "reasoning"` | Renamed for provider neutrality |
| `content[].thinking` | `content[].text` | Unified text field |
| `thinking_signature` | `content[].signature` | Optional verification |

### OpenAI → Unfirehose

| OpenAI | Unfirehose | Notes |
|---|---|---|
| `reasoning_tokens` (usage only) | `usage.outputTokenDetails.reasoningTokens` | Text not exposed |
| No content block | — | Cannot reconstruct reasoning text |

### Google AI → Unfirehose

| Google AI | Unfirehose | Notes |
|---|---|---|
| `thinkingConfig.includeThoughts: true` | enables reasoning blocks | Config, not output field |
| `parts[].thought: true` | `content[].type: "reasoning"` | When thoughts are returned |

## Database Mapping

| JSON Field | DB Column | Table |
|---|---|---|
| `type: "reasoning"` | `block_type: "thinking"` | content_blocks |
| `text` | `text_content` | content_blocks |

## Dashboard

The `/thinking` page shows all reasoning blocks across all sessions with:
- Search by content
- Date range filtering
- Preceding user prompt context
- Character count
- Model and project attribution
