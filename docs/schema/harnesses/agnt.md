# agnt — Harness Format

**Provider**: Multi-provider
**Status**: Native target (ships with unfirehose/1.0)
**Adapter**: None needed (native unfirehose/1.0 format)

## Overview

`agnt` is our own agent harness, designed from the ground up to log in unfirehose/1.0 format natively. No adapter needed — the JSONL output IS the canonical format.

## File Location

```
~/.agnt/projects/{project-slug}/{session-uuid}.jsonl
```

## Format

agnt writes unfirehose/1.0 JSONL directly:

```jsonl
{"$schema":"unfirehose/1.0","type":"session","id":"019506a8-...","projectId":"-home-fox-git-myproject","status":"active","createdAt":"2026-03-05T10:42:45Z","harness":"agnt","harnessVersion":"0.1.0"}
{"$schema":"unfirehose/1.0","type":"message","role":"user","id":"msg_001","sessionId":"019506a8-...","timestamp":"2026-03-05T10:42:45Z","content":[{"type":"text","text":"Fix the login page"}]}
{"$schema":"unfirehose/1.0","type":"message","role":"assistant","id":"msg_002","sessionId":"019506a8-...","parentId":"msg_001","timestamp":"2026-03-05T10:42:51Z","model":"claude-opus-4-6","provider":"anthropic","content":[{"type":"reasoning","text":"Let me check the CSS..."},{"type":"tool-call","toolCallId":"tc_01","toolName":"Read","input":{"file_path":"src/login.css"}}],"usage":{"inputTokens":3,"outputTokens":78,"inputTokenDetails":{"cacheReadTokens":12233}}}
```

## Why Native

By implementing unfirehose/1.0 natively, agnt:

1. **Eliminates adapter overhead** — no transformation on ingestion
2. **Guarantees schema compliance** — validated at write time
3. **Enables streaming ingestion** — files can be tailed and ingested in real-time
4. **Sets the standard** — reference implementation for other harnesses to follow

## Implementation Checklist

For harnesses adopting unfirehose/1.0 natively:

- [ ] Write `$schema: "unfirehose/1.0"` on all objects
- [ ] Session header as first JSONL line
- [ ] Content always as block array (never bare strings)
- [ ] Use canonical block types: `text`, `reasoning`, `tool-call`, `tool-result`
- [ ] Use canonical tool names where possible
- [ ] Include `parentId` for conversation threading
- [ ] Include `usage` on assistant messages
- [ ] Use UUIDv7 for session and message IDs
- [ ] Store at `~/.{harness}/projects/{slug}/{uuid}.jsonl`
- [ ] System message with `subtype: "session_end"` on close

## Target Harnesses for Native Adoption

| Harness | Status | Notes |
|---------|--------|-------|
| `agnt` | In development | Reference native implementation |
| `uncloseai-cli` | Planned | Currently event-based, migrating to unfirehose/1.0 |
| `fetch` | Proposed | Already close to canonical (Claude Code format) |
