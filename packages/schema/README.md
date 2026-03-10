# @unturf/unfirehose-schema

The `unfirehose/1.0` schema specification for machine learning agent session logging.

A standard format for logging sessions across coding agent harnesses: Claude Code, Gemini CLI, Codex, Aider, Cursor, Continue.dev, Ollama, and more. No universal standard exists for this — every harness invented its own format. This package defines the one they should converge on.

## Install

```bash
npm install @unturf/unfirehose-schema
```

## What's in the box

### TypeScript types

```ts
import type {
  Message, Session, Todo, Project, Metric,
  ContentBlock, TextBlock, ReasoningBlock, ToolCallBlock, ToolResultBlock,
  Usage, ToolDefinition, UnfirehoseObject
} from '@unturf/unfirehose-schema'
```

### JSON Schema files (for validation)

```ts
import messageSchema from '@unturf/unfirehose-schema/json-schema/message'
import sessionSchema from '@unturf/unfirehose-schema/json-schema/session'
import contentBlockSchema from '@unturf/unfirehose-schema/json-schema/content-block'
import usageSchema from '@unturf/unfirehose-schema/json-schema/usage'
import todoSchema from '@unturf/unfirehose-schema/json-schema/todo'
import projectSchema from '@unturf/unfirehose-schema/json-schema/project'
import metricSchema from '@unturf/unfirehose-schema/json-schema/metric'
import toolDefinitionSchema from '@unturf/unfirehose-schema/json-schema/tool-definition'
```

### Specification docs

The `docs/` directory contains the full spec:

| Document | Purpose |
|---|---|
| [Canonical Format](docs/canonical-format.md) | Full unfirehose/1.0 schema with field maps for Anthropic, OpenAI, and Google APIs |
| [JSONL Format](docs/jsonl-format.md) | JSONL stream structure, file layout, ingestion pipeline |
| [Messages](docs/messages.md) | Message schema with content block types |
| [Sessions](docs/sessions.md) | Session lifecycle envelope |
| [Projects](docs/projects.md) | Repository/workspace identity |
| [Tool Calls](docs/tool-calls.md) | Tool invocation format and standard registry |
| [Thought Traces](docs/thought-traces.md) | Extended thinking / chain-of-thought |
| [Todos](docs/todos.md) | Cross-session work items |
| [Metrics](docs/metrics.md) | Token usage, cost, timing rollups |
| [All Logs](docs/all-logs.md) | How everything fits together |

### Harness adapter docs

| Harness | Provider | Status |
|---|---|---|
| [Claude Code](docs/harnesses/claude-code.md) | Anthropic | Reference implementation |
| [Fetch](docs/harnesses/fetch.md) | Anthropic | Supported |
| [uncloseai-cli](docs/harnesses/uncloseai-cli.md) | Local (Hermes) | Supported |
| [Gemini CLI](docs/harnesses/gemini-cli.md) | Google | Documented |
| [OpenAI Codex](docs/harnesses/openai-codex.md) | OpenAI | Documented |
| [Aider](docs/harnesses/aider.md) | Multi-provider | Documented |
| [Cursor](docs/harnesses/cursor.md) | Multi-provider | Researched |
| [Continue.dev](docs/harnesses/continue-dev.md) | Multi-provider | Researched |
| [Hermes Agent](docs/harnesses/hermes-agent.md) | Local (Hermes) | Documented |
| [Open Code](docs/harnesses/opencode.md) | Multi-provider | Researched |
| [Ollama](docs/harnesses/ollama.md) | Local | Researched |
| [Open WebUI](docs/harnesses/open-webui.md) | Multi-provider | Researched |
| [llama.cpp](docs/harnesses/llama-cpp.md) | Local | Researched |
| [vLLM](docs/harnesses/vllm.md) | Local/self-hosted | Researched |
| [text-generation-webui](docs/harnesses/text-generation-webui.md) | Local | Researched |
| [pi](docs/harnesses/pi.md) | Multi-provider | Extension implemented |
| [agnt](docs/harnesses/agnt.md) | Multi-provider | Native target |

## Quick example

A minimal unfirehose/1.0 JSONL session:

```jsonl
{"$schema":"unfirehose/1.0","type":"session","id":"4e0f77f7-1b16-4adc-88bd-37f46790e2ae","harness":"claude-code"}
{"$schema":"unfirehose/1.0","type":"message","role":"user","content":[{"type":"text","text":"Fix the login page"}]}
{"$schema":"unfirehose/1.0","type":"message","role":"assistant","model":"claude-opus-4-6","content":[{"type":"reasoning","text":"Let me look at the CSS..."},{"type":"tool-call","toolCallId":"tc_01","toolName":"Read","input":{"file_path":"login.css"}}],"usage":{"inputTokens":3,"outputTokens":78}}
{"$schema":"unfirehose/1.0","type":"message","role":"user","content":[{"type":"tool-result","toolCallId":"tc_01","toolName":"Read","output":".login { margin: 0 }"}]}
{"$schema":"unfirehose/1.0","type":"message","role":"assistant","content":[{"type":"text","text":"Fixed the margin."}]}
```

## Design principles

1. **Append-only JSONL** — one line per event, never mutate written lines
2. **Content block array** — all message content is `content: [...]`, never a bare string
3. **Provider-neutral naming** — `reasoning` not `thinking`, `tool-call` not `tool_use`
4. **camelCase JSON** — snake_case only in database (ingestion layer handles mapping)
5. **UUIDv7 identity** — time-ordered, safe for cross-machine sync
6. **Idempotent ingestion** — UUID dedup + byte offsets = safe re-run
7. **Graceful degradation** — missing fields show "unknown", not errors

## Implementing the standard

Three tiers of adoption, one source of truth each:

| Tier | Strategy | Example |
|------|----------|---------|
| 1 — Native | Harness writes unfirehose/1.0 as its only format | agnt, uncloseai-cli |
| 2 — Extension | Extension hooks harness lifecycle, writes unfirehose/1.0 | pi (`extensions/pi-unfirehose.ts`) |
| 3 — Adapter | Unfirehose reads harness native format, transforms on ingest | Claude Code, Cursor, aider |

To adopt unfirehose/1.0 in a new harness:

1. Log JSONL with `$schema: "unfirehose/1.0"` header
2. Use canonical content block types (`text`, `reasoning`, `tool-call`, `tool-result`)
3. Include session envelope as first line (optional but recommended)
4. Store at `~/.{harness}/projects/{slug}/{session-uuid}.jsonl`

### Extensions (Tier 2)

For harnesses with extension/plugin systems, this package ships ready-to-use extensions:

```bash
# pi coding agent
cp node_modules/@unturf/unfirehose-schema/extensions/pi-unfirehose.ts ~/.pi/agent/extensions/unfirehose.ts
```

See the [harness adapter guide](docs/all-logs.md) for the full pipeline.

## Part of the unfirehose monorepo

| Package | Description |
|---|---|
| [@unturf/unfirehose](https://www.npmjs.com/package/@unturf/unfirehose) | Core data layer — ingestion, SQLite, types |
| [@unturf/unfirehose-router](https://www.npmjs.com/package/@unturf/unfirehose-router) | CLI daemon — forwards JSONL to cloud |
| [@unturf/unfirehose-ui](https://www.npmjs.com/package/@unturf/unfirehose-ui) | Shared React components |
| **@unturf/unfirehose-schema** | Schema specification (this package) |

## License

AGPL-3.0-only
