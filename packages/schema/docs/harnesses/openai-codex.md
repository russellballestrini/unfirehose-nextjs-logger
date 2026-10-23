# OpenAI Codex CLI

Status: supported. Ingest reads Codex's own rollouts in place
(`packages/core/db/ingest-foreign.ts`, mapping in `packages/core/codex-adapter.ts`).
Nothing to run beside our worker.

Reads `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (default
`~/.codex/sessions`). Source rollouts are never modified. Archives outside
`sessions/` are not scanned. `UNFIREHOSE_HARNESSES=codex` restricts ingestion to
Codex (add `claude-code` and the rest to keep them).

A rollout is append-only, so a file resumes from its stored byte offset; an
incomplete trailing line waits for the next pass. The reader's state (session,
working directory, model, cumulative token counters) is stored beside the
offset, so a resumed file never rereads earlier lines. Each file reads about
32 MiB per pass, so a long backlog catches up over several. Malformed lines are
skipped.

Projects are `codex:<encoded cwd>`; message ids are
`codex:<sha256(rollout path)>:<byte offset of the line>`.

### The bridge, retired

Until 2026-10-23 `scripts/codex-bridge.mts` copied rollouts into
`~/.codex/unfirehose`, which ingest read as a native harness. Ingest now gives
every line the same message id, project and session the bridge gave it, so a
box that ran the bridge keeps its history and gains no duplicates. `~/.codex/unfirehose`
is no longer read (reading it as well would count every rollout twice); it and
the bridge's checkpoints in `~/.unfirehose/codex-bridge` can be deleted. The
script now only says so.

## Mapping and limits

- `session_meta`: session ID, working directory, creation time, git branch.
- `turn_context`: active model.
- `response_item.message`: user/assistant text; developer messages become system.
- Function and custom tool calls/results retain names, call IDs and payloads.
- `event_msg.token_count`: cumulative deltas, with cached input separated from
  uncached input. Repeated counters add zero. Duplicate event messages and
  `token_usage_record` are not counted again.
- Available reasoning summaries are retained; encrypted reasoning is excluded.
  This does not recover hidden chain-of-thought.
- Images, audio and unknown record kinds are currently omitted.
- Costs are catalog-derived API equivalents, not subscription charges.

Verified against Codex CLI 0.154.0 rollout envelopes (fixture:
`packages/core/test/fixtures/harnesses/codex/`). No API key, CLI configuration
change, or extra inference call is required.
