# Ollama — Harness Format

**Provider**: Local (llama, mistral, codellama, gemma, phi, etc.)
**Status**: Researched (adapter planned)
**Adapter**: `packages/core/ollama-adapter.ts` (planned — API log parser)

## Overview

Ollama runs open source LLMs locally: https://github.com/ollama/ollama

Not a coding agent itself — it's an inference server. Other harnesses (Aider, Open WebUI, Continue.dev) use Ollama as a backend. Relevant to unfirehose because it's the most common local inference path.

## API Format

Ollama exposes an OpenAI-compatible API at `localhost:11434`:

### Chat Completion

```jsonc
// POST /api/chat
{
  "model": "llama3.1:70b",
  "messages": [
    { "role": "user", "content": "Explain quicksort" }
  ],
  "stream": true
}

// Response (streamed)
{
  "model": "llama3.1:70b",
  "created_at": "2026-03-05T10:42:45.000Z",
  "message": {
    "role": "assistant",
    "content": "Quicksort is..."
  },
  "done": false
}

// Final chunk
{
  "model": "llama3.1:70b",
  "created_at": "2026-03-05T10:42:47.000Z",
  "done": true,
  "total_duration": 2145000000,
  "load_duration": 50000000,
  "prompt_eval_count": 12,
  "prompt_eval_duration": 120000000,
  "eval_count": 156,
  "eval_duration": 1975000000
}
```

### Generate (Legacy)

```jsonc
// POST /api/generate
{
  "model": "codellama:13b",
  "prompt": "Write a Python function to sort a list",
  "stream": false
}
```

## File Location

Ollama doesn't persist conversation logs by default. Log sources:

```
~/.ollama/logs/server.log          # Server logs (not conversations)
# No native session persistence — must be captured at the client level
```

## Field Mapping -> Unfirehose

| Ollama | Unfirehose | Transform |
|---|---|---|
| `model` | `model` | identity |
| `message.role` | `role` | identity |
| `message.content` | `content: [{type: "text"}]` | wrap |
| `created_at` | `timestamp` | rename |
| `prompt_eval_count` | `usage.inputTokens` | rename |
| `eval_count` | `usage.outputTokens` | rename |
| `total_duration` | `usage.durationMs` | nanoseconds to ms |
| `load_duration` | metadata | model load time |

## Adapter Strategy

Since Ollama doesn't log conversations, the adapter would either:

1. **Proxy mode**: Intercept API calls through an unfirehose proxy
2. **Client capture**: Log at the client level (Aider, Open WebUI, etc.)
3. **Server log parsing**: Extract request/response pairs from server logs (limited)

The recommended path is to capture at the client harness level and note `provider: "ollama"` in metadata.

## Tools

Ollama supports function calling with compatible models:

| Capability | Support |
|------------|---------|
| Function calling | Yes (llama3.1+, mistral-nemo+) |
| Streaming | Yes |
| Multi-modal | Yes (llava, bakllava) |
| Embeddings | Yes |
| Thinking/reasoning | Model-dependent (DeepSeek-R1, QwQ) |

## Key Differences from Claude Code

| Aspect | Claude Code | Ollama |
|--------|------------|--------|
| Type | Coding agent | Inference server |
| Persistence | Full JSONL logs | No native conversation logs |
| Provider | Anthropic API | Local models |
| Token tracking | Full | Available per-response |
| Tools | Named function calls | Model-dependent |
| Thinking | Native extended thinking | Model-dependent |
