// Extracting rate-limit events out of already-ingested content blocks.
//
// Detection runs over content_blocks rather than at parse time so that
// improving a detector rule re-classifies history instead of only applying
// to whatever arrives next. Scanning is incremental: each pass starts from
// the highest block id already considered.

import type Database from 'better-sqlite3';
import { readdirSync, statSync, readFileSync } from 'fs';
import path from 'path';
import { getDb } from './schema';
import { detectRateLimit } from '../rate-limits';
import { recordHarnessRefusal } from './refusals';
import { classifyClaudeApiError } from '../claude-code-adapter';
import { claudePaths } from '../claude-paths';
import { uncloseaiPaths } from '../uncloseai-paths';

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
    // Only what this scanner wrote. Harness-reported rows came from JSONL
    // records already ingested past their file offsets — a rescan cannot
    // rebuild them, and on 2026-09-03 one deleted 173 of them.
    database.exec("DELETE FROM rate_limit_events WHERE rule != 'harness-reported'");
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

export interface RefusalBackfillResult {
  files: number;
  throttleRecords: number;
  claudeApiErrors: number;
  inserted: number;
  skipped: number;
}

function walkJsonl(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = path.join(dir, n);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walkJsonl(p, out, depth + 1);
    else if (n.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/**
 * Rebuild harness-reported refusals from the JSONL still on disk.
 *
 * Ingest records these as it reads each line, so they are lost to any
 * event-table wipe and never re-created by the incremental pass. This walks
 * the uncloseai unfirehose tree for `type: "throttle"` records and the Claude
 * Code projects tree for `isApiErrorMessage` rows, and inserts whichever are
 * not already present. Idempotent: a row is skipped when one with the same
 * session, timestamp and kind (or the same message) already exists.
 */
export function backfillReportedRefusals(
  db?: Database.Database,
  opts: { uncloseaiDir?: string; claudeProjectsDir?: string } = {},
): RefusalBackfillResult {
  const database = db ?? getDb();
  const res: RefusalBackfillResult = { files: 0, throttleRecords: 0, claudeApiErrors: 0, inserted: 0, skipped: 0 };

  const sessionByUuid = database.prepare('SELECT id FROM sessions WHERE session_uuid = ?');
  const messageByUuid = database.prepare('SELECT id, session_id FROM messages WHERE message_uuid = ?');
  const existsByTime = database.prepare(
    `SELECT 1 FROM rate_limit_events WHERE rule = 'harness-reported'
       AND session_id IS ? AND timestamp = ? AND kind = ? LIMIT 1`,
  );
  const existsByMessage = database.prepare(
    `SELECT 1 FROM rate_limit_events WHERE rule = 'harness-reported' AND message_id = ? LIMIT 1`,
  );

  const uncloseaiFiles = walkJsonl(opts.uncloseaiDir ?? uncloseaiPaths.unfirehose);
  const claudeFiles = walkJsonl(opts.claudeProjectsDir ?? claudePaths.projects);
  res.files = uncloseaiFiles.length + claudeFiles.length;

  database.transaction(() => {
    for (const file of uncloseaiFiles) {
      let text: string;
      try { text = readFileSync(file, 'utf-8'); } catch { continue; }
      if (!text.includes('"throttle"')) continue;
      const sessionUuid = path.basename(file, '.jsonl');
      const sessionId = (sessionByUuid.get(sessionUuid) as { id: number } | undefined)?.id ?? null;
      for (const line of text.split('\n')) {
        if (!line.includes('"throttle"')) continue;
        let e: any;
        try { e = JSON.parse(line); } catch { continue; }
        if (e?.type !== 'throttle') continue;
        res.throttleRecords++;
        const ts = typeof e.timestamp === 'string' ? e.timestamp : null;
        const kind = typeof e.kind === 'string' ? e.kind : 'rate_limit';
        if (ts && existsByTime.get(sessionId, ts, kind)) { res.skipped++; continue; }
        const ok = recordHarnessRefusal(database, {
          sessionId, timestamp: ts, kind,
          provider: typeof e.harness === 'string' ? e.harness : 'uncloseai',
          upstream: typeof e.upstream === 'string' ? e.upstream : null,
          operation: typeof e.operation === 'string' ? e.operation : null,
          model: typeof e.model === 'string' ? e.model : null,
          httpStatus: typeof e.httpStatus === 'number' ? e.httpStatus : null,
          retryAfterSeconds: typeof e.retryAfterSeconds === 'number' ? e.retryAfterSeconds : null,
          detail: typeof e.message === 'string' ? e.message : null,
        });
        if (ok) res.inserted++; else res.skipped++;
      }
    }

    for (const file of claudeFiles) {
      let text: string;
      try { text = readFileSync(file, 'utf-8'); } catch { continue; }
      if (!text.includes('"isApiErrorMessage":true')) continue;
      for (const line of text.split('\n')) {
        if (!line.includes('"isApiErrorMessage":true')) continue;
        let e: any;
        try { e = JSON.parse(line); } catch { continue; }
        const refusal = classifyClaudeApiError(e);
        if (!refusal) continue;
        res.claudeApiErrors++;
        const msg = typeof e.uuid === 'string'
          ? (messageByUuid.get(e.uuid) as { id: number; session_id: number } | undefined)
          : undefined;
        if (msg && existsByMessage.get(msg.id)) { res.skipped++; continue; }
        const sessionId = msg?.session_id
          ?? (typeof e.sessionId === 'string' ? (sessionByUuid.get(e.sessionId) as { id: number } | undefined)?.id : undefined)
          ?? null;
        const ts = typeof e.timestamp === 'string' ? e.timestamp : null;
        if (!msg && ts && existsByTime.get(sessionId, ts, refusal.kind)) { res.skipped++; continue; }
        const ok = recordHarnessRefusal(database, {
          sessionId, messageId: msg?.id ?? null, timestamp: ts, kind: refusal.kind,
          provider: 'anthropic', upstream: 'anthropic', model: null,
          httpStatus: refusal.status, detail: refusal.detail,
        });
        if (ok) res.inserted++; else res.skipped++;
      }
    }
  })();

  return res;
}
