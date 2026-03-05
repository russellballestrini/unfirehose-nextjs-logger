# unfirehose.org Schema Specification

Version: `unfirehose/1.0`

A standard JSON format for machine learning agent session logging. Any harness can either log in this format natively or be adapted just-in-time on ingestion.

All objects carry `$schema: "unfirehose/1.0"` for forward compatibility. Consumers ignore unknown fields.

## Object Types

| Schema | Purpose | File |
|--------|---------|------|
| [Messages](./messages.md) | User/assistant/system turns with content blocks | Atomic unit of all logging |
| [Sessions](./sessions.md) | Session lifecycle envelope wrapping messages | One per coding session |
| [Projects](./projects.md) | Repository/workspace identity | One per working directory |
| [Tool Calls](./tool-calls.md) | Tool invocation and result format + standard registry | Content blocks within messages |
| [Thought Traces](./thought-traces.md) | Extended thinking / chain-of-thought reasoning | Content blocks within messages |
| [Todos](./todos.md) | Cross-session work items + audit events | Extracted from sessions or manual |
| [Metrics](./metrics.md) | Token usage, cost, timing rollups + alerts | Per-minute aggregations |
| [All Logs](./all-logs.md) | JSONL stream format + ingestion pipeline | How everything fits together |

## Harness Formats

Native format documentation and field mapping for each harness:

| Harness | Provider | Status | File |
|---------|----------|--------|------|
| [Claude Code](./harnesses/claude-code.md) | Anthropic | Reference impl | Adapter: identity |
| [Fetch](./harnesses/fetch.md) | Anthropic | Supported | Adapter: identity |
| [Gemini CLI](./harnesses/gemini-cli.md) | Google | Documented | Adapter: planned |
| [uncloseai-cli](./harnesses/uncloseai-cli.md) | Local (Hermes) | Supported | Adapter: live |
| [OpenAI Codex CLI](./harnesses/openai-codex.md) | OpenAI | Documented | Adapter: planned |
| [Aider](./harnesses/aider.md) | Multi-provider | Documented | Adapter: planned |
| [Cursor](./harnesses/cursor.md) | Multi-provider | Researched | Adapter: planned |
| [Continue.dev](./harnesses/continue-dev.md) | Multi-provider | Researched | Adapter: planned |
| [agnt](./harnesses/agnt.md) | Multi-provider | Native target | Ships with unfirehose/1.0 |

## API Field Maps

Provider API → unfirehose canonical field mappings:

| Provider | Key Differences |
|----------|----------------|
| Anthropic | `thinking` → `reasoning`, `tool_use` → `tool-call`, snake_case → camelCase |
| OpenAI | `messages[].tool_calls[]` flattened to content blocks, `prompt_tokens` → `inputTokens` |
| Google AI | `parts[]` → `content[]`, `functionCall` → `tool-call`, `usageMetadata` → `usage` |
| Vercel AI SDK | Near-identical — our reference alignment target |

## Design Principles

1. **Append-only JSONL** — one line per event, never mutate written lines
2. **Content block array** — all message content is `content: [...]`, never a bare string
3. **Provider-neutral naming** — `reasoning` not `thinking`, `tool-call` not `tool_use`
4. **camelCase JSON** — snake_case only in SQLite (ingestion layer handles mapping)
5. **UUIDv7 identity** — time-ordered, safe for cross-machine sync
6. **Idempotent ingestion** — UUID dedup + byte offsets = safe re-run
7. **Graceful degradation** — missing fields show "unknown", not errors

## Implementing the Standard

To adopt unfirehose/1.0 in a new harness:

```
1. Log JSONL with $schema: "unfirehose/1.0" header
2. Use canonical content block types (text, reasoning, tool-call, tool-result)
3. Include session envelope as first line (optional but recommended)
4. Store at ~/.{harness}/projects/{slug}/{session-uuid}.jsonl
```

See [All Logs](./all-logs.md) for the full JSONL stream structure and [harness adapter guide](./all-logs.md#writing-a-harness-adapter).
