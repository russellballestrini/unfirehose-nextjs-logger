# llama.cpp — Harness Format

**Provider**: Local (GGUF models — llama, mistral, phi, gemma, etc.)
**Status**: Researched (adapter planned)
**Adapter**: `packages/core/llama-cpp-adapter.ts` (planned — server log parser)

## Overview

llama.cpp is LLM inference in C/C++: https://github.com/ggerganov/llama.cpp

Runs GGUF-format models on CPU or GPU. Provides a server (`llama-server`) with an OpenAI-compatible API.

## API Format

llama-server exposes an OpenAI-compatible chat completions API:

### Chat Completion

```jsonc
// POST /v1/chat/completions
{
  "model": "model.gguf",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Write a quicksort in Python" }
  ],
  "temperature": 0.7,
  "max_tokens": 2048,
  "stream": true
}

// Response
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1709632965,
  "model": "model.gguf",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Here's a quicksort implementation..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 24,
    "completion_tokens": 156,
    "total_tokens": 180
  },
  "timings": {
    "prompt_n": 24,
    "prompt_ms": 120.5,
    "predicted_n": 156,
    "predicted_ms": 1975.3,
    "predicted_per_token_ms": 12.66,
    "predicted_per_second": 78.99
  }
}
```

### Legacy Completion

```jsonc
// POST /completion
{
  "prompt": "Write a Python quicksort:\n```python\n",
  "n_predict": 512,
  "temperature": 0.7,
  "stop": ["```"]
}
```

## File Location

llama.cpp doesn't persist conversations. Log sources:

```
# Server stdout/stderr — verbose logging with --log-enable
# No native session persistence
```

## Field Mapping -> Unfirehose

| llama.cpp | Unfirehose | Transform |
|---|---|---|
| `choices[].message.role` | `role` | identity |
| `choices[].message.content` | `content: [{type: "text"}]` | wrap |
| `model` | `model` | identity (GGUF filename) |
| `created` | `timestamp` | epoch to ISO |
| `usage.prompt_tokens` | `usage.inputTokens` | rename |
| `usage.completion_tokens` | `usage.outputTokens` | rename |
| `choices[].finish_reason` | `stopReason` | map (`stop` -> `end_turn`, `length` -> `max_tokens`) |
| `timings.predicted_per_second` | metadata | tokens/sec throughput |
| `timings.prompt_ms` | metadata | prompt evaluation time |

## Adapter Strategy

Same as Ollama — llama.cpp is an inference server, not a conversation logger:

1. **Proxy mode**: Intercept API calls through an unfirehose proxy
2. **Client capture**: Log at the client level
3. **Server log parsing**: Extract from verbose server logs when `--log-enable` is set

## Unique Features

| Feature | Detail |
|---------|--------|
| `timings` | Per-request performance data (tokens/sec, prompt eval time) — valuable for benchmarking |
| Quantization info | Model metadata includes quantization level (Q4_K_M, Q8_0, etc.) |
| Grammar | Supports constrained output via BNF grammars |
| Speculative decoding | Draft model acceleration |
| Multi-slot | Concurrent request serving |

## Key Differences from Claude Code

| Aspect | Claude Code | llama.cpp |
|--------|------------|-----------|
| Type | Coding agent | Inference server |
| Persistence | Full JSONL logs | No native logs |
| Provider | Anthropic API | Local GGUF models |
| API compat | Anthropic Messages | OpenAI Chat Completions |
| Performance data | API latency only | Full timing breakdown |
| Tools | Named function calls | Model-dependent |
