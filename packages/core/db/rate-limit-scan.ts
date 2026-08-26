// Extracting rate-limit events out of already-ingested content blocks.
//
// Detection runs over content_blocks rather than at parse time so that
// improving a detector rule re-classifies history instead of only applying
// to whatever arrives next. Scanning is incremental: each pass starts from
// the highest block id already considered.

import type Database from 'better-sqlite3';
import { getDb } from './schema';
import { detectRateLimit } from '../rate-limits';

const CURSOR_KEY = 'rate_limit_scan_block_id';

function getCursor(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(CURSOR_KEY) as
      | { value: string }
      | undefined;
    return row ? parseInt(row.value, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

function setCursor(db: Database.Database, id: number): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(CURSOR_KEY, String(id));
}

export interface RateLimitScanResult {
  scanned: number;
  found: number;
  lastBlockId: number;
}

/**
 * Scan content blocks for rate-limit events and record them.
 *
 * `fromScratch` re-reads every block and is what a detector change calls for;
 * the default incremental pass only looks at blocks added since last time.
 */
export function scanRateLimits(
  db?: Database.Database,
  opts: { batch?: number; fromScratch?: boolean } = {},
): RateLimitScanResult {
  const database = db ?? getDb();
  const batch = opts.batch ?? 50_000;

  if (opts.fromScratch) {
    database.exec('DELETE FROM rate_limit_events');
    setCursor(database, 0);
  }

  const cursor = getCursor(database);
  const rows = database
    .prepare(
      `SELECT cb.id       AS block_id,
              cb.message_id,
              cb.text_content,
              m.session_id,
              m.timestamp,
              m.model,
              m.provider,
              s.project_id,
              s.harness
         FROM content_blocks cb
         JOIN messages m ON m.id = cb.message_id
         LEFT JOIN sessions s ON s.id = m.session_id
        WHERE cb.id > ?
          AND cb.text_content IS NOT NULL
          AND cb.text_content != ''
        ORDER BY cb.id
        LIMIT ?`,
    )
    .all(cursor, batch) as Array<{
      block_id: number;
      message_id: number;
      text_content: string;
      session_id: number | null;
      timestamp: string | null;
      model: string | null;
      provider: string | null;
      project_id: number | null;
      harness: string | null;
    }>;

  if (rows.length === 0) return { scanned: 0, found: 0, lastBlockId: cursor };

  const insert = database.prepare(`
    INSERT INTO rate_limit_events
      (block_id, message_id, session_id, project_id, timestamp, kind, target,
       provider, upstream, operation, model, http_status, retry_after_s, rule, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(block_id) DO NOTHING
  `);

  // A harness that reports its own throttles still prints the error into a
  // tool result, so the same refusal would be counted twice — once from the
  // record, once from the text. The record wins: it names the upstream, which
  // the text never can. Skip a scanned event when a harness-reported one
  // already covers that session within a minute either side.
  const nearbyReported = database.prepare(`
    SELECT 1 FROM rate_limit_events
     WHERE rule = 'harness-reported'
       AND session_id IS ?
       AND ABS(strftime('%s', timestamp) - strftime('%s', ?)) <= 60
     LIMIT 1
  `);

  let found = 0;
  let last = cursor;
  const write = database.transaction(() => {
    for (const r of rows) {
      last = r.block_id;
      const ev = detectRateLimit(r.text_content);
      if (!ev) continue;
      if (r.timestamp && nearbyReported.get(r.session_id, r.timestamp)) continue;
      insert.run(
        r.block_id,
        r.message_id,
        r.session_id,
        r.project_id,
        r.timestamp ?? new Date().toISOString(),
        ev.kind,
        ev.target,
        // The text usually names the provider; fall back to what the message
        // recorded, which is where the call actually went. Never inherit that
        // fallback for a crawled web page — provider='local' on an uncloseai
        // message says nothing about the site that returned 429.
        ev.provider
          ?? (ev.target === 'web' ? 'web' : null)
          // messages.provider says 'local' for all uncloseai traffic — a
          // harness label, not a routing fact (see pricing.isSelfHosted). The
          // harness that made the call is the honest attribution here.
          ?? (r.provider && r.provider !== 'local' ? r.provider : null)
          ?? r.harness
          ?? null,
        ev.upstream,
        ev.operation,
        r.model,
        ev.status,
        ev.retryAfterSeconds,
        ev.rule,
        ev.detail,
      );
      found++;
    }
    setCursor(database, last);
  });
  write();

  return { scanned: rows.length, found, lastBlockId: last };
}

/** Drain the backlog in batches. Returns totals across all passes. */
export function scanRateLimitsFully(
  db?: Database.Database,
  opts: { batch?: number; fromScratch?: boolean; maxPasses?: number } = {},
): RateLimitScanResult {
  const database = db ?? getDb();
  const maxPasses = opts.maxPasses ?? 200;
  let scanned = 0;
  let found = 0;
  let lastBlockId = 0;
  for (let i = 0; i < maxPasses; i++) {
    const r = scanRateLimits(database, {
      batch: opts.batch,
      fromScratch: opts.fromScratch && i === 0,
    });
    scanned += r.scanned;
    found += r.found;
    lastBlockId = r.lastBlockId;
    if (r.scanned === 0) break;
  }
  return { scanned, found, lastBlockId };
}
