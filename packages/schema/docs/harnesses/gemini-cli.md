# Gemini CLI — Harness Format

**Provider**: Google
**Status**: Supported: ingested from Gemini CLI's own chat recordings
**Adapter**: `packages/core/gemini-adapter.ts` (fold + mapping), read by `packages/core/db/ingest-foreign.ts`

## File Location

Gemini CLI records every chat without being asked
(`packages/core/src/services/chatRecordingService.ts`, types in
`chatRecordingTypes.ts`; read at main `a713410`, 2026-10-23):

```
~/.gemini/tmp/<project>/chats/session-<YYYY-MM-DDTHH-MM>-<id8>.jsonl   # current
~/.gemini/tmp/<project>/chats/session-*.json                           # legacy: one ConversationRecord, rewritten whole
~/.gemini/tmp/<project>/chats/<parentSessionId>/<sessionId>.jsonl     # subagent sessions
~/.gemini/tmp/<project>/.project_root                                  # the project's absolute path
~/.gemini/projects.json                                                # { projects: { "<path>": "<project>" } }
```

`<project>` is a slug from `projects.json`; older installs named the directory
`sha256(projectRoot)` and Gemini CLI migrates those as it meets them. We take a
project's cwd from `.project_root`, then `projects.json`, then (for a hashed
directory) any project path we already know that hashes to it. `GEMINI_CLI_HOME`
moves the whole `~/.gemini` tree, and we follow it.

### Recording lines

A `.jsonl` recording is append-only but not one message per line:

| Line | Meaning |
|---|---|
| `{ sessionId, projectHash, startTime, kind? }` | session metadata (line 1) |
| `{ id, timestamp, type, content, … }` | a message; appended again with the same `id` each time it changes (tokens, tool calls) |
| `{ $patch: { id, toolCalls: [{ id, result }] } }` | a tool call's result, or new content |
| `{ $rewindTo: "<id>" }` | drop that message and everything after it |
| `{ $set: { … } }` | metadata (summary, lastUpdated); in older writers a whole `messages` history |

We fold a recording the way Gemini CLI's own loader does, then map each
message. A file is skipped while its size and mtime are unchanged; a changed
file is refolded and its messages inserted by id, so nothing lands twice. The
newest message of a file touched in the last 30 seconds waits a pass, since it
may still gain its tokens or tool results. Messages already ingested stay when
a later `$rewindTo` removes them from Gemini's view, as rewritten Claude Code
lines do.

`message.type` is `user`, `gemini`, `info`, `warning` or `error`. A `gemini`
message carries `model`, `thoughts[]` (`{ subject, description }`),
`toolCalls[]` (`{ id, name, args, result, status }`) and `tokens`
(`{ input, output, cached, thoughts, tool, total }`).

Telemetry over OTLP (`telemetry.*` in `settings.json`) is a separate stream we
do not need.

Source: https://github.com/google-gemini/gemini-cli

## Mapping as ingested

| Recording | Unfirehose |
|---|---|
| `type: "user"` | `role: "user"`, text blocks |
| `type: "gemini"` | `role: "assistant"`: `thoughts[]` as `reasoning` (`subject: description`), `thought: true` parts as `reasoning`, text parts as `text`, `toolCalls[]` as `tool-call` |
| `toolCalls[].result` | a following `role: "user"` message (id `<message id>:tool-results`) of `tool-result` blocks; `status` `error`/`cancelled` sets `isError` |
| `info` / `warning` / `error` | `role: "system"`, `subtype` the type |
| `tokens.input + tokens.tool - tokens.cached` | `usage.inputTokens` (the prompt count includes cached tokens) |
| `tokens.output + tokens.thoughts` | `usage.outputTokens` (thinking bills as output) |
| `tokens.cached` | `usage.inputTokenDetails.cacheReadTokens` |
| `kind: "subagent"`, or a file under `chats/<parent>/` | a sidechain session, `delegated_from` the parent |

Projects are `gemini-cli:<encoded cwd>`, the same encoding Claude Code uses.

## API Format (for reference)

The parts inside a recording's `content` are Gemini API `Part`s:

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

## Tools

Gemini CLI exposes tools through MCP (Model Context Protocol) and built-in functions. Ingest keeps the names Gemini CLI records; this is how they line up with Claude Code's:

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
| Tool calls | `tool_use` blocks | `toolCalls[]` on the gemini message (`functionCall` parts in the API) |
| Tool results | `tool_result` blocks | `toolCalls[].result` (`functionResponse` parts) |
| Roles | user, assistant, system | user, gemini, info/warning/error (API: user, model, function) |
| Thinking | `thinking` block type | `thought: true` flag on text parts |
| Usage | `usage.input_tokens` | `tokens.input` (API: `usageMetadata.promptTokenCount`), cached included |
| Cache tokens | Separate fields | `cachedContentTokenCount` |
