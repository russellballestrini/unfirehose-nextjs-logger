# Aider — Harness Format

**Provider**: Multi-provider (OpenAI, Anthropic, local)
**Status**: Supported: ingested from Aider's own chat log, in the roots of projects unfirehose already ingests
**Adapter**: `packages/core/aider-adapter.ts` (markdown parser), read by `packages/core/db/ingest-foreign.ts`

## Overview

Aider is an open-source coding assistant: https://github.com/paul-gauthier/aider

Unlike other harnesses, Aider logs in **Markdown**, not JSON/JSONL.

## File Location

```
{project-root}/.aider.chat.history.md    # conversation history
{project-root}/.aider.input.history       # user input history (readline)
{project-root}/.aider.tags.cache.v3/     # ctags cache
```

Aider writes these in the git root of the repo it runs in, and keeps no home
directory of its own. unfirehose looks for them only in the directories of
projects it already ingests (`projects.path`, `projects.last_cwd_seen`, and
the git root above either), never by walking the home directory. An Aider
session lands in the project whose root holds the log, as `aider:<slug>`.

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
| `> ...` | system (`subtype: aider-output`) | Aider's own output: startup lines, `Tokens:` reports, commits |
| Unmarked text blocks | assistant | Model response |
| `<<<<<<< SEARCH` / `>>>>>>> REPLACE` | tool-call (Edit) | File edit diff |

## Field Mapping → Unfirehose

| Aider Element | Unfirehose | Transform |
|---|---|---|
| `# aider chat started` | Session header | Parse timestamp |
| `#### /ask {text}` | `role: "user"`, `content: [{type: "text"}]` | Extract text |
| `#### /code {text}` | `role: "user"`, `content: [{type: "text"}]` | Extract text |
| Unmarked paragraphs | `role: "assistant"`, `content: [{type: "text"}]` | Extract text |
| SEARCH/REPLACE blocks | `role: "assistant"`, `content: [{type: "tool-call", toolName: "Edit"}]` | `{file_path, old_string, new_string}`, Claude Code's input shape |
| `> Applied edit to {file}` | `role: "user"`, `content: [{type: "tool-result"}]` | Result of that file's Edit call |
| `> Main model: {model} ...` | `model` on later assistant messages | Also `Model:` / `Models:` in older versions |
| `> Tokens: 2.4k sent, 1.1k cache write, 3.2k cache hit, 312 received.` | `usage` of the reply before it | Rounded as printed; message marked approximate (`messages.tokens_approx = 1`) |
| `.aider.input.history` `# {time}` + `+{line}` | `timestamp` of the matching prompt | Other messages take the latest known time, never earlier than the run's start |
| Other `> ` lines | `role: "system"`, `subtype: "aider-output"` | Text, verbatim |

Message ids are `aider:{session}:{byte offset from the run's header}`; the
session id is derived from the log's path and the header's offset and time.
The log is appended, so it is read from a stored byte offset; the newest
turn waits while the file moved in the last 30 s, so its `Tokens:` line
lands with its reply.

## Adapter Challenges

1. **Markdown parsing**: No structured delimiters — relies on heading patterns
2. **No timestamps per message**: Only session start time is logged (local time, no zone); prompts are stamped from `.aider.input.history`
3. **Rounded token usage**: `Tokens:` lines print `format_tokens` output (`2.4k`, `12k`), so counts are approximate to that precision. "sent" is the prompt as the provider counted it; Aider prices cache hits and writes on top of it, and unfirehose books them the same way
4. **No message IDs**: Generated during ingestion from byte offsets
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
| Timestamps | Per message | Per session, plus per prompt in `.aider.input.history` |
| Token tracking | Full | Rounded, in `> Tokens:` lines |
| Thinking | Separate blocks | Not supported |
| Multi-model | One model per session | Can switch mid-session |
