// Refusals a harness reported about itself — the authoritative copy of a
// refused call, as opposed to what the text scanner infers from error
// strings afterwards. Two sources feed this today: unfirehose/1.0
// `type: "throttle"` records (uncloseai-cli) and Claude Code's
// `isApiErrorMessage` rows. Lives apart from ingest so the scan module can
// backfill from disk without importing the whole ingest pipeline.

import type Database from 'better-sqlite3';

export interface HarnessRefusal {
  sessionId: number | null;
  messageId?: number | null;
  timestamp: string | null;
  kind: string;
  provider: string | null;
  upstream: string | null;
  operation?: string | null;
  model: string | null;
  httpStatus: number | null;
  retryAfterSeconds?: number | null;
  detail: string | null;
}

/**
 * Write a refusal the harness itself reported — a `type: "throttle"` record
 * or a Claude Code `isApiErrorMessage` row. Rule `harness-reported` marks it
 * as the authoritative copy: the text scanner skips any match it finds in
 * the same session within a minute, so the error text printed alongside
 * never double-counts. Never throws; a bad record must not stop ingest.
 */
export function recordHarnessRefusal(db: Database.Database, r: HarnessRefusal): boolean {
  try {
    const projectId = r.sessionId === null ? null
      : (db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(r.sessionId) as { project_id: number } | undefined)?.project_id ?? null;
    db.prepare(`
      INSERT INTO rate_limit_events
        (block_id, message_id, session_id, project_id, timestamp,
         kind, target, provider, upstream, operation, model,
         http_status, retry_after_s, rule, detail)
      VALUES (NULL, ?, ?, ?, ?, ?, 'inference', ?, ?, ?, ?, ?, ?, 'harness-reported', ?)
    `).run(
      r.messageId ?? null,
      r.sessionId,
      projectId,
      r.timestamp ?? new Date().toISOString(),
      r.kind,
      r.provider,
      r.upstream,
      r.operation ?? null,
      r.model,
      r.httpStatus,
      r.retryAfterSeconds == null ? null : Math.round(r.retryAfterSeconds),
      (r.detail ?? '').slice(0, 300) || '(no message)',
    );
    return true;
  } catch {
    return false;
  }
}
