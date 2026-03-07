# vLLM — Harness Format

**Provider**: Local/self-hosted (any HuggingFace model)
**Status**: Researched (adapter planned)
**Adapter**: `packages/core/vllm-adapter.ts` (planned — OpenAI-compatible API)

## Overview

vLLM is a high-throughput LLM serving engine: https://github.com/vllm-project/vllm

Production-grade inference with PagedAttention, continuous batching, and tensor parallelism. OpenAI-compatible API.

## API Format

vLLM serves an OpenAI-compatible API:

### Chat Completion

```jsonc
// POST /v1/chat/completions
{
  "model": "meta-llama/Llama-3.1-70B-Instruct",
  "messages": [
    { "role": "user", "content": "Explain PagedAttention" }
  ],
  "max_tokens": 1024,
  "temperature": 0.7,
  "stream": true
}

// Response
{
  "id": "cmpl-abc123",
  "object": "chat.completion",
  "created": 1709632965,
  "model": "meta-llama/Llama-3.1-70B-Instruct",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "PagedAttention is..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 8,
    "completion_tokens": 234,
    "total_tokens": 242
  }
}
```

### Tool/Function Calling

```jsonc
{
  "model": "meta-llama/Llama-3.1-70B-Instruct",
  "messages": [...],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather",
        "parameters": { "type": "object", "properties": { "location": { "type": "string" } } }
      }
    }
  ]
}
```

## File Location

vLLM doesn't persist conversations. Observability sources:

```
# Prometheus metrics at /metrics
# Server stdout with request logging
# OpenTelemetry traces (optional)
```

## Field Mapping -> Unfirehose

| vLLM | Unfirehose | Transform |
|---|---|---|
| `choices[].message.role` | `role` | identity |
| `choices[].message.content` | `content: [{type: "text"}]` | wrap |
| `choices[].message.tool_calls[]` | `content: [{type: "tool-call"}]` | OpenAI format mapping |
| `model` | `model` | identity (HuggingFace model ID) |
| `created` | `timestamp` | epoch to ISO |
| `usage.prompt_tokens` | `usage.inputTokens` | rename |
| `usage.completion_tokens` | `usage.outputTokens` | rename |
| `choices[].finish_reason` | `stopReason` | map values |

## Adapter Strategy

Same pattern as Ollama/llama.cpp — inference server without conversation persistence:

1. **Proxy mode**: Intercept OpenAI-compatible API calls
2. **Client capture**: Log at the client level
3. **Prometheus scraping**: Capture throughput/latency metrics from `/metrics`
4. **OTEL integration**: Capture traces if OpenTelemetry is configured

## Unique Features

| Feature | Detail |
|---------|--------|
| PagedAttention | Efficient KV cache management — higher throughput than naive serving |
| Continuous batching | Dynamic request batching for optimal GPU utilization |
| Tensor parallelism | Multi-GPU model sharding |
| Prefix caching | Automatic prompt caching across requests |
| Speculative decoding | Draft model acceleration |
| Prometheus metrics | `vllm:num_requests_running`, `vllm:avg_generation_throughput_toks_per_s`, etc. |
| LoRA serving | Hot-swap LoRA adapters per request |

## Key Differences from Claude Code

| Aspect | Claude Code | vLLM |
|--------|------------|------|
| Type | Coding agent | Inference server |
| Persistence | Full JSONL logs | No native logs (Prometheus/OTEL) |
| Provider | Anthropic API | Local HuggingFace models |
| API compat | Anthropic Messages | OpenAI Chat Completions |
| Scale | Single user | Multi-tenant production serving |
| GPU | Not required | Required (CUDA) |
| Tools | Named function calls | OpenAI function-calling format |
