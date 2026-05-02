# Aborist — Harness Format

**Provider**: Local (Hermes / multi-provider)
**Status**: Implemented — first production native unfirehose/1.0 harness
**Adapter**: None needed (native unfirehose/1.0 format, auto-discovered)

## Overview

Aborist is a coding agent harness that writes unfirehose/1.0 JSONL natively. It was the first harness to ship a production native implementation of our schema, validating that adapters are optional. Sessions land directly in canonical format and flow through ingestion without any transformation step.

Discovery happens automatically: any directory at `~/.{name}/unfirehose/` is treated as a native harness root. No registration, no config — drop a session file into our path and unfirehose picks it up on its next ingest cycle.

## File Location

```
~/.aborist/unfirehose/{project-slug}/{session-uuid}.jsonl
```

Project slug encoding follows our standard scheme (path separators and dots become hyphens; leading slash becomes leading hyphen):

```
/home/fox/git/myproject  →  -home-fox-git-myproject
```

## Format

Aborist writes unfirehose/1.0 JSONL directly. Every object carries `$schema: "unfirehose/1.0"`:

```jsonl
{"$schema":"unfirehose/1.0","type":"session","id":"019506a8-...","projectId":"-home-fox-git-myproject","status":"active","createdAt":"2026-04-12T10:42:45Z","harness":"aborist","harnessVersion":"0.4.2"}
{"$schema":"unfirehose/1.0","type":"message","role":"user","id":"msg_001","sessionId":"019506a8-...","timestamp":"2026-04-12T10:42:45Z","content":[{"type":"text","text":"Refactor our retrieval pipeline"}]}
{"$schema":"unfirehose/1.0","type":"message","role":"assistant","id":"msg_002","sessionId":"019506a8-...","parentId":"msg_001","timestamp":"2026-04-12T10:42:51Z","model":"hermes-3-llama-3.1-8b","provider":"local","content":[{"type":"reasoning","text":"Let me check our anchor-class extractor..."},{"type":"tool-call","toolCallId":"tc_01","toolName":"Read","input":{"file_path":"src/retrieval.py"}}],"usage":{"inputTokens":18,"outputTokens":142,"inputTokenDetails":{"cacheReadTokens":8431}}}
```

## Auto-Discovery

Aborist is picked up by `discoverNativeHarnesses()` in `packages/core/db/ingest.ts`. Our discovery rule:

1. Scan `$HOME` for dot-directories
2. For each `~/.{name}/`, check whether `~/.{name}/unfirehose/` exists and is a directory
3. If yes, register `{name}` as a native harness with root `~/.{name}/unfirehose/`
4. Excluded: `.unfirehose` (our own data dir), `.claude` and `.fetch` (custom adapters)

A new harness becomes visible by simply creating its directory and writing one valid session JSONL file. No code changes, no config, no restart required beyond our next ingest cycle.

## Why Native Over Adapter

By implementing unfirehose/1.0 natively, Aborist:

1. **Eliminates adapter overhead** — no per-line transformation during ingestion
2. **Guarantees schema compliance** — validation happens at write time, not read time
3. **Enables streaming ingestion** — files can be tailed and ingested in real-time
4. **Lets dashboard treat sessions as first-class** — Live, Active, Sessions pages all work without harness-specific code paths

## Live Integration

The dashboard's `/api/live` endpoint streams Aborist sessions alongside Claude Code and other native harnesses. Display tags (`'aborist'`, `'claude-code'`, `'agnt'`) come from our directory name, not a hardcoded list. Ingestion result statistics (projects added, sessions added, messages added, blocks added) flow into our usual ingest pipeline.

## Implementation Checklist

For other harnesses adopting unfirehose/1.0 natively, follow Aborist's pattern:

- [ ] Write `$schema: "unfirehose/1.0"` on every object
- [ ] Session header as first JSONL line (`type: "session"`)
- [ ] Content always as block array — never a bare string
- [ ] Use canonical block types: `text`, `reasoning`, `tool-call`, `tool-result`
- [ ] Use canonical tool names where possible (`Read`, `Write`, `Edit`, `Bash`, `Grep`, etc.)
- [ ] Include `parentId` on assistant messages for conversation threading
- [ ] Include `usage` on every assistant message
- [ ] Use UUIDv7 for session and message IDs (time-ordered, B-tree friendly)
- [ ] Store sessions at `~/.{harness}/unfirehose/{slug}/{uuid}.jsonl`
- [ ] Emit `system` message with `subtype: "session_end"` on close
