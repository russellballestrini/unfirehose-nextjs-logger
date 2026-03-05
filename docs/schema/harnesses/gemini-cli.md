# Gemini CLI — Harness Format

**Provider**: Google
**Status**: Documented (adapter planned)
**Adapter**: `packages/core/gemini-adapter.ts` (planned)

## File Location

```
~/.gemini/sessions/{slug}/{session-uuid}.jsonl   # expected
```

Gemini CLI is open source: https://github.com/google-gemini/gemini-cli

## Native Format

Gemini CLI uses the Google AI Gemini API format. Messages use `parts[]` instead of `content[]`:

### User Message

```jsonc
{
  "role": "user",
  "parts": [
    { "text": "Fix the login page" }
  ]
}
```

### Model Response

```jsonc
{
  "role": "model",
  "parts": [
    { "text": "I'll fix the login page." },
    {
      "functionCall": {
        "name": "run_shell_command",
        "args": { "command": "ls src/" }
      }
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 1234,
    "candidatesTokenCount": 567,
    "totalTokenCount": 1801,
    "cachedContentTokenCount": 890
  }
}
```

### Function Response

```jsonc
{
  "role": "function",
  "parts": [
    {
      "functionResponse": {
        "name": "run_shell_command",
        "response": { "output": "login.css\napp.js" }
      }
    }
  ]
}
```

## Field Mapping → Unfirehose

| Gemini CLI | Unfirehose | Transform |
|---|---|---|
| `role: "model"` | `role: "assistant"` | rename |
| `role: "function"` | `role: "tool"` | rename |
| `parts[].text` | `content[].text` | `parts` → `content` |
| `parts[].functionCall.name` | `content[].toolName` | flatten |
| `parts[].functionCall.args` | `content[].input` | rename |
| `parts[].functionResponse.name` | `content[].toolName` | flatten |
| `parts[].functionResponse.response` | `content[].output` | rename |
| `usageMetadata.promptTokenCount` | `usage.inputTokens` | rename |
| `usageMetadata.candidatesTokenCount` | `usage.outputTokens` | rename |
| `usageMetadata.totalTokenCount` | `usage.totalTokens` | rename |
| `usageMetadata.cachedContentTokenCount` | `usage.inputTokenDetails.cacheReadTokens` | nest |

## Tools

Gemini CLI exposes tools through MCP (Model Context Protocol) and built-in functions:

| Gemini Tool | Canonical Name |
|-------------|---------------|
| `run_shell_command` | `Bash` |
| `read_file` | `Read` |
| `write_file` | `Write` |
| `edit_file` | `Edit` |
| `list_directory` | `Glob` |
| `search_files` | `Grep` |
| `web_search` | `WebSearch` |

## Thinking Support

Gemini supports thinking via `thinkingConfig`:

```jsonc
{
  "generationConfig": {
    "thinkingConfig": {
      "includeThoughts": true,
      "thinkingBudget": 8192
    }
  }
}
```

When enabled, model responses may include thought parts:

```jsonc
{
  "parts": [
    { "text": "...", "thought": true },   // thinking content
    { "text": "..." }                      // visible response
  ]
}
```

Parts with `thought: true` map to `{ type: "reasoning" }` in canonical format.

## Key Differences from Claude Code

| Aspect | Claude Code | Gemini CLI |
|--------|------------|------------|
| Content array | `content[]` | `parts[]` |
| Tool calls | `tool_use` blocks | `functionCall` in parts |
| Tool results | `tool_result` blocks | `functionResponse` in parts |
| Roles | user, assistant, system | user, model, function |
| Thinking | `thinking` block type | `thought: true` flag on text parts |
| Usage | `usage.input_tokens` | `usageMetadata.promptTokenCount` |
| Cache tokens | Separate fields | `cachedContentTokenCount` |
