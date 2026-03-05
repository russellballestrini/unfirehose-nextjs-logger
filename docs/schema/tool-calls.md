# Tool Calls Schema

Tool invocation and result format within messages.

## Content Block Format

### Tool Call (in assistant messages)

```jsonc
{
  "type": "tool-call",
  "toolCallId": "tc_01A2B3...",
  "toolName": "Bash",
  "input": {
    "command": "git status",
    "description": "Check working tree"
  }
}
```

### Tool Result (in user/tool messages)

```jsonc
{
  "type": "tool-result",
  "toolCallId": "tc_01A2B3...",
  "toolName": "Bash",
  "output": "On branch main\nnothing to commit",
  "isError": false
}
```

**Linking**: `toolCallId` links a `tool-call` to its `tool-result`. The call appears in an assistant message; the result appears in the next user or tool-role message.

## Tool Definition

Compatible with Vercel AI SDK `tool()` shape. Published in a tool registry or as JSONL header lines.

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "tool_definition",
  "name": "Bash",
  "description": "Execute a shell command and return its output",
  "inputSchema": {
    "type": "object",
    "properties": {
      "command": { "type": "string", "description": "The command to execute" },
      "timeout": { "type": "number", "description": "Timeout in milliseconds" },
      "description": { "type": "string", "description": "What this command does" }
    },
    "required": ["command"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "stdout": { "type": "string" },
      "stderr": { "type": "string" },
      "exitCode": { "type": "number" }
    }
  }
}
```

**Vercel AI SDK alignment**: `inputSchema` maps to the `parameters` field (accepts JSON Schema or Zod). We use `inputSchema`/`outputSchema` to match the SDK's `tool()` function signature.

## Standard Tool Registry

Tools that all coding agent harnesses share (names may differ per harness):

| Canonical Name | Purpose | Common Aliases |
|----------------|---------|----------------|
| `Bash` | Shell execution | `bash`, `terminal`, `shell`, `execute`, `run_command` |
| `Read` | Read file | `read_file`, `cat`, `view`, `file_read` |
| `Write` | Write file | `write_file`, `create_file`, `file_write` |
| `Edit` | Edit file (diff) | `edit_file`, `str_replace`, `patch`, `apply_diff` |
| `Glob` | Find files | `find_files`, `list_files`, `search_files`, `list_dir` |
| `Grep` | Search content | `search`, `ripgrep`, `find_in_files`, `regex_search` |
| `WebFetch` | HTTP fetch | `web_fetch`, `curl`, `browser`, `fetch_url` |
| `WebSearch` | Web search | `web_search`, `google`, `search_web` |
| `Agent` | Spawn subagent | `sub_agent`, `delegate`, `spawn` |
| `AskUser` | Prompt human | `ask_user`, `human_input`, `ask_followup` |
| `TodoWrite` | Create/update todo | `todo_write`, `task_create`, `add_task` |
| `NotebookEdit` | Edit Jupyter cell | `notebook_edit`, `edit_cell` |

Adapters normalize tool name aliases to canonical names during ingestion. Unknown tool names pass through unchanged.

## Multi-Step Tool Execution

A single user prompt often triggers multiple tool calls across several LLM round-trips. Each round-trip is a "step":

```
User: "Fix the login page"
  Step 1: Assistant → tool-call(Bash: "grep -r 'login'")
          Tool result → "src/login.css:14: .login-form { ... }"
  Step 2: Assistant → tool-call(Read: "src/login.css")
          Tool result → file contents
  Step 3: Assistant → tool-call(Edit: fix CSS)
          Tool result → success
  Step 4: Assistant → text("Done, I fixed the CSS")
```

In JSONL these are individual messages linked by `parentId`. See [Messages](./messages.md) for the threading model.

## Provider Field Maps

### Anthropic → Unfirehose

| Anthropic API | Unfirehose |
|---|---|
| `content[].type: "tool_use"` | `content[].type: "tool-call"` |
| `content[].id` | `content[].toolCallId` |
| `content[].name` | `content[].toolName` |
| `content[].input` | `content[].input` |
| `content[].type: "tool_result"` | `content[].type: "tool-result"` |
| `content[].tool_use_id` | `content[].toolCallId` |

### OpenAI → Unfirehose

| OpenAI API | Unfirehose |
|---|---|
| `tool_calls[].function.name` | `content[].toolName` |
| `tool_calls[].function.arguments` | `content[].input` (JSON parse) |
| `tool_calls[].id` | `content[].toolCallId` |
| `role: "tool"`, `tool_call_id` | `role: "tool"`, `content[].toolCallId` |

### Google AI → Unfirehose

| Google AI | Unfirehose |
|---|---|
| `parts[].functionCall.name` | `content[].toolName` |
| `parts[].functionCall.args` | `content[].input` |
| `parts[].functionResponse.name` | `content[].toolName` |
| `parts[].functionResponse.response` | `content[].output` |

## Database Mapping

| JSON Field | DB Column | Table |
|---|---|---|
| `toolCallId` | `tool_use_id` | content_blocks |
| `toolName` | `tool_name` | content_blocks |
| `input` | `tool_input` (JSON string) | content_blocks |
| `output` | `text_content` | content_blocks |
| `isError` | `is_error` | content_blocks |
| `type: "tool-call"` | `block_type: "tool_use"` | content_blocks |
| `type: "tool-result"` | `block_type: "tool_result"` | content_blocks |
