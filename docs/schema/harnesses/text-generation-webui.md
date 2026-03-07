# text-generation-webui — Harness Format

**Provider**: Local (any HuggingFace/GGUF model)
**Status**: Researched (adapter planned)
**Adapter**: `packages/core/tgwui-adapter.ts` (planned — chat log parser)

## Overview

text-generation-webui (oobabooga) is a Gradio web UI for running LLMs: https://github.com/oobabooga/text-generation-webui

Self-hosted interface supporting multiple backends (transformers, llama.cpp, ExLlamaV2, AutoGPTQ).

## File Location

```
text-generation-webui/logs/chat/{character}_{timestamp}.json
text-generation-webui/logs/chat/persistent_{character}.json    # persistent chat history
```

Chat logs are stored as JSON files per character/session.

## Native Format

### Chat Log

```jsonc
{
  "internal": [
    ["", "How can I help you today?"],          // [user_msg, assistant_msg]
    ["Write a Python quicksort", "Here's a quicksort implementation:\n\n```python\ndef quicksort(arr):\n..."]
  ],
  "visible": [
    ["", "How can I help you today?"],
    ["Write a Python quicksort", "Here's a quicksort implementation:\n\n```python\ndef quicksort(arr):\n..."]
  ]
}
```

The `internal` array contains the raw conversation (may include special tokens), while `visible` contains the display version.

### Chat Instruction Template

```jsonc
{
  "user": "{user message}",
  "bot": "{assistant message}",
  "turn_template": "<|user|>\n{user}\n<|assistant|>\n{bot}\n",
  "context": "You are a helpful assistant."
}
```

## Field Mapping -> Unfirehose

| text-generation-webui | Unfirehose | Transform |
|---|---|---|
| `internal[][0]` | `role: "user"`, `content: [{type: "text"}]` | extract + wrap |
| `internal[][1]` | `role: "assistant"`, `content: [{type: "text"}]` | extract + wrap |
| filename timestamp | `timestamp` | parse from filename |
| character name | metadata | session context |

## API (OpenAI-compatible)

text-generation-webui also serves an OpenAI-compatible API:

```jsonc
// POST /v1/chat/completions
{
  "messages": [
    { "role": "user", "content": "Hello" }
  ],
  "mode": "chat",
  "character": "Assistant"
}
```

## Adapter Challenges

1. **Paired format**: Messages stored as `[user, assistant]` pairs, not individual messages
2. **No timestamps per message**: Only session-level timestamp from filename
3. **No token usage**: Token counts not logged in chat files
4. **No message IDs**: Must be generated during ingestion
5. **Internal vs visible**: Two copies of each message — `internal` may have special tokens
6. **Character system**: Conversations are per-character, not per-session in the traditional sense
7. **Multiple backends**: Same UI can use transformers, llama.cpp, ExLlamaV2 — model info varies

## Unique Features

| Feature | Detail |
|---------|--------|
| Multi-backend | transformers, llama.cpp, ExLlamaV2, AutoGPTQ, GPTQ-for-LLaMa |
| Character cards | Persona system with greeting messages |
| Extensions | Plugin system (web search, long-term memory, voice) |
| Notebook mode | Free-form text completion (not chat) |
| Training | Built-in LoRA fine-tuning UI |

## Key Differences from Claude Code

| Aspect | Claude Code | text-generation-webui |
|--------|------------|----------------------|
| Type | CLI coding agent | Web chat/notebook UI |
| Storage | JSONL per session | JSON paired arrays |
| Structure | Individual messages | User/assistant pairs |
| Provider | Anthropic | Local models (multi-backend) |
| Tools | Full agent toolset | Extensions only |
| Thinking | Extended thinking blocks | Not supported |
| Use case | Code generation | General chat/roleplay |
