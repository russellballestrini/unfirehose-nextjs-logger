# OpenAI Codex CLI

Status: supported through `scripts/codex-bridge.mts` and `packages/core/codex-adapter.ts`.

Run alongside the dashboard and ingestion worker:

```sh
npx tsx scripts/codex-bridge.mts
```

Reads `$CODEX_HOME/sessions/**/*.jsonl` (default `~/.codex/sessions`) and writes
native unfirehose/1.0 to `~/.codex/unfirehose/<project>/<session>.jsonl`. The
worker discovers this directory automatically and the session viewer reads it.
Source rollouts are never modified. Run only one bridge per output/checkpoint
directory. `--once` runs one bounded pass; repeat until caught up.

Configuration:

- `CODEX_BRIDGE_STATE`: checkpoints (default `~/.unfirehose/codex-bridge`).
- `UNFIREHOSE_CODEX_DIR`: output override for isolated tests. Production native
  discovery expects `~/.codex/unfirehose`; a symlink to another disk is supported.
- `UNFIREHOSE_HARNESSES=codex`: restrict ingestion and watchers to Codex.

Each source processes approximately 32 MiB per pass. Byte offsets preserve UTF-8
and retry incomplete trailing records. Checkpoints retain model/session context
and cumulative usage. Restarts roll back uncommitted output; deterministic
source-file/byte-offset message IDs prevent duplicate database rows. Malformed
complete JSON and source truncation fail visibly. Archives outside `sessions/`
are not scanned.

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

Verified against Codex CLI 0.154.0 rollout envelopes. No API key, CLI configuration
change, or extra inference call is required.
