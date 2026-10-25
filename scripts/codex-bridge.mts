// Retired 2026-10-23 (ticket 4011 item 1). Ingest now reads Codex rollouts
// straight from $CODEX_HOME/sessions (packages/core/db/ingest-foreign.ts),
// with the same message ids, project and session this bridge gave the same
// lines, so history it already landed is kept and nothing is counted twice.
// ~/.codex/unfirehose, which it wrote, is no longer read; delete it when you
// like, along with ~/.unfirehose/codex-bridge (its checkpoints).
console.log('[codex-bridge] retired: our worker reads $CODEX_HOME/sessions directly now, nothing to run.');
console.log('[codex-bridge] ~/.codex/unfirehose and ~/.unfirehose/codex-bridge are safe to delete.');
