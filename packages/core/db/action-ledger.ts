// The agent action ledger, kept: classified tool calls in action_ledger,
// filled from content_blocks and searched by our /actions page and API.
//
// Classifying is not free and there are 2.35 M blocks, so it happens once
// per block and the result is stored. Two cursors split the work:
//
//   head   — the highest block id classified going forward. Ingest calls
//            scanLedgerHead at the end of every pass, so a tool call that
//            just landed is in the ledger before anyone looks.
//   below  — history, classified newest first in bounded windows by the
//            worker while it is idle (backfillLedger), so recent actions
//            appear first and an old install never holds ingest for minutes.
//
// Both walk block-id windows rather than LIMIT n matches, so a pass costs
// the same whether a window holds ten tool calls or ten thousand. Rows are
// keyed on block_id, so overlap is harmless. When LEDGER_RULES_VERSION
// changes the table is emptied and both cursors restart: a better rule
// re-classifies history instead of only what arrives next.
//
// The same walk reads tool results for credentials (findSecrets, behind one
// cheap prefilter) and hands every call or result that carried one to
// db/secret-alerts.ts, which keeps the sighting and, for what the head scan
// finds after the feature first ran, raises an alert. The backfill never
// raises: history is flagged, not announced.

import type Database from 'better-sqlite3';
import { getDb } from './schema';
import { blockTextSql, blockToolInputSql } from './block-cold';
import { TOOL_CALL_SQL, TOOL_RESULT_SQL } from '../block-types';
import { classifyToolCall, secretKindsInInput, LEDGER_RULES_VERSION, ACTION_FLAGS, ACTION_KINDS, type ActionFlag, type ActionKind } from '../action-ledger';
import { findSecrets, mayHoldSecret } from '../pii';
import { outputKindsFor, outputReason, recordSightings, sightingStatus, type Sighting, type SightingStatus } from './secret-alerts';

const HEAD_KEY = 'action_ledger_head';
const BELOW_KEY = 'action_ledger_below';
const RULES_KEY = 'action_ledger_rules';
/** Block ids per window. ~50 ms of classifying on a busy window. */
export const LEDGER_WINDOW = 50_000;

function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
function setSetting(db: Database.Database, key: string, value: string | number): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, String(value));
}
const maxBlockId = (db: Database.Database) =>
  (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM content_blocks').get() as { m: number }).m;

/**
 * Our cursors, starting them on first use or after a rules change: head at
 * the newest block, history below it still to do.
 */
export function ledgerCursors(db: Database.Database): { head: number; below: number } {
  // Only ever forward: a web process still on older rules than the worker
  // must not empty what the newer one just built.
  const stored = Number(getSetting(db, RULES_KEY) ?? 0) || 0;
  if (stored < LEDGER_RULES_VERSION) {
    db.transaction(() => {
      db.exec('DELETE FROM action_ledger');
      const max = maxBlockId(db);
      setSetting(db, HEAD_KEY, max);
      setSetting(db, BELOW_KEY, max + 1);
      setSetting(db, RULES_KEY, LEDGER_RULES_VERSION);
    })();
  }
  return {
    head: Number(getSetting(db, HEAD_KEY) ?? 0) || 0,
    below: Number(getSetting(db, BELOW_KEY) ?? 1) || 1,
  };
}

interface BlockRow {
  block_id: number;
  message_id: number;
  tool_name: string | null;
  tool_input: string | null;
  tool_use_id: string | null;
  session_id: number | null;
  project_id: number | null;
  harness: string | null;
  timestamp: string;
  session_uuid: string | null;
  project_name: string | null;
  project_display_name: string | null;
}

const BLOCK_COLUMNS = `
    cb.id AS block_id, cb.message_id, cb.tool_use_id,
    m.session_id, s.project_id, s.harness, s.session_uuid,
    p.name AS project_name, p.display_name AS project_display_name,
    COALESCE(m.timestamp, replace(m.ingested_at, ' ', 'T') || 'Z') AS timestamp`;
const BLOCK_JOINS = `
      FROM content_blocks cb
      JOIN messages m ON m.id = cb.message_id
      LEFT JOIN sessions s ON s.id = m.session_id
      LEFT JOIN projects p ON p.id = s.project_id`;

function sightingOf(r: BlockRow, location: 'call' | 'result', kinds: string[]): Sighting {
  return {
    blockId: r.block_id, messageId: r.message_id, sessionId: r.session_id, projectId: r.project_id,
    timestamp: r.timestamp, location, toolName: r.tool_name, toolUseId: r.tool_use_id, kinds,
    sessionUuid: r.session_uuid, projectName: r.project_name, projectDisplayName: r.project_display_name,
    harness: r.harness,
  };
}

interface RangeResult { scanned: number; recorded: number; secrets: number; alerts: number }

/**
 * Classify the tool calls with lo < id <= hi and read the tool results in
 * the same range for credentials. `alert` says whether a new sighting may
 * raise an alert (head scan) or is only kept (history).
 */
function classifyRange(db: Database.Database, lo: number, hi: number, alert: boolean, now?: Date): RangeResult {
  const out: RangeResult = { scanned: 0, recorded: 0, secrets: 0, alerts: 0 };
  if (hi <= lo) return out;
  const rows = db.prepare(`
    SELECT ${BLOCK_COLUMNS}, cb.tool_name, ${blockToolInputSql('cb')} AS tool_input
      ${BLOCK_JOINS}
     WHERE cb.id > ? AND cb.id <= ?
       AND cb.block_type ${TOOL_CALL_SQL}
  `).all(lo, hi) as BlockRow[];

  const insert = db.prepare(`
    INSERT INTO action_ledger
      (block_id, message_id, session_id, project_id, harness, timestamp, tool_name, tool_use_id,
       kind, paths, command, flags, flagged, reasons)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(block_id) DO NOTHING
  `);
  const sightings: Sighting[] = [];
  db.transaction(() => {
    for (const r of rows) {
      let a;
      try { a = classifyToolCall(r.tool_name, r.tool_input); } catch { a = null; }
      if (!a) continue;
      if (a.flags.includes('secrets-in-diff') || a.flags.includes('secret-in-command')) {
        let kinds: string[] = [];
        try { kinds = secretKindsInInput(r.tool_input); } catch { kinds = []; }
        sightings.push(sightingOf(r, 'call', kinds));
      }
      // Its output may have been read first: the backfill walks newest first.
      const seen = outputKindsFor(db, r.tool_use_id, r.session_id);
      const flags = seen.length ? [...a.flags, 'secret-in-output'] : a.flags;
      const reasons = seen.length ? [...a.reasons, outputReason(seen)] : a.reasons;
      const res = insert.run(
        r.block_id, r.message_id, r.session_id, r.project_id, r.harness, r.timestamp, r.tool_name, r.tool_use_id,
        a.kind, a.paths.join('\n'), a.command, flags.join(' '), flags.length > 0 ? 1 : 0, reasons.join('; '),
      );
      out.recorded += res.changes;
    }
  })();
  out.scanned = rows.length;

  // Tool results: streamed, since their text is most of a window's bytes,
  // and only what passes the prefilter is matched in full.
  const results = db.prepare(`
    SELECT ${BLOCK_COLUMNS}, NULL AS tool_name, NULL AS tool_input, ${blockTextSql('cb')} AS text_content
      ${BLOCK_JOINS}
     WHERE cb.id > ? AND cb.id <= ?
       AND cb.block_type ${TOOL_RESULT_SQL}
       AND (cb.cold = 1 OR cb.text_content IS NOT NULL)
  `);
  for (const r of results.iterate(lo, hi) as IterableIterator<BlockRow & { text_content: string | null }>) {
    if (!r.text_content || !mayHoldSecret(r.text_content)) continue;
    const kinds = [...new Set(findSecrets(r.text_content).map((h) => h.kind))];
    if (kinds.length) sightings.push(sightingOf(r, 'result', kinds));
  }

  if (sightings.length) {
    const s = recordSightings(db, sightings, { alert, now });
    out.secrets = s.recorded;
    out.alerts = s.alerts;
  }
  return out;
}

export interface LedgerScanResult {
  scanned: number;
  recorded: number;
  /** Credential sightings new to secret_sightings. */
  secrets: number;
  /** secret_exposed alerts raised. Zero from the backfill, always. */
  alerts: number;
}

/**
 * Classify what arrived since the last pass. Bounded by `maxPasses`
 * windows so a burst cannot hold up ingest; the next pass takes the rest.
 */
export function scanLedgerHead(
  db: Database.Database = getDb(),
  opts: { window?: number; maxPasses?: number; now?: Date } = {},
): LedgerScanResult & { head: number } {
  const window = opts.window ?? LEDGER_WINDOW;
  const maxPasses = opts.maxPasses ?? 4;
  let { head } = ledgerCursors(db);
  const max = maxBlockId(db);
  const out = { scanned: 0, recorded: 0, secrets: 0, alerts: 0, head };
  for (let i = 0; i < maxPasses && head < max; i++) {
    const hi = Math.min(head + window, max);
    const r = classifyRange(db, head, hi, true, opts.now);
    out.scanned += r.scanned;
    out.recorded += r.recorded;
    out.secrets += r.secrets;
    out.alerts += r.alerts;
    head = hi;
    setSetting(db, HEAD_KEY, head);
  }
  out.head = head;
  return out;
}

/**
 * One window of history, newest first. `remaining` is how many block ids
 * are still below the cursor; zero when our history is done.
 */
export function backfillLedger(
  db: Database.Database = getDb(),
  opts: { window?: number } = {},
): LedgerScanResult & { remaining: number; done: boolean } {
  const window = opts.window ?? LEDGER_WINDOW;
  const { below } = ledgerCursors(db);
  if (below <= 1) return { scanned: 0, recorded: 0, secrets: 0, alerts: 0, remaining: 0, done: true };
  const lo = Math.max(0, below - 1 - window);
  const r = classifyRange(db, lo, below - 1, false);
  setSetting(db, BELOW_KEY, lo + 1);
  return { ...r, remaining: lo, done: lo === 0 };
}

/** Head and history both, to the end. For `make demo`, tests and a manual rebuild. */
export function drainLedger(db: Database.Database = getDb(), opts: { window?: number; now?: Date } = {}): LedgerScanResult {
  const out = { scanned: 0, recorded: 0, secrets: 0, alerts: 0 };
  for (;;) {
    const h = scanLedgerHead(db, { window: opts.window, maxPasses: 1000, now: opts.now });
    out.scanned += h.scanned; out.recorded += h.recorded; out.secrets += h.secrets; out.alerts += h.alerts;
    const b = backfillLedger(db, opts);
    out.scanned += b.scanned; out.recorded += b.recorded; out.secrets += b.secrets;
    if (b.done) break;
  }
  return out;
}

/** Empty the ledger and start both cursors again; the worker refills it. */
export function rebuildLedger(db: Database.Database = getDb()): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(RULES_KEY);
  ledgerCursors(db);
}

export interface LedgerStatus {
  rows: number;
  /** Block ids of history still to classify; 0 when the backfill is done. */
  backfillRemaining: number;
  /** Block ids past our head cursor, waiting on the next ingest. */
  headLag: number;
  rulesVersion: number;
  /** Credentials seen in tool calls and results (secret_sightings). */
  secrets: SightingStatus;
}

export function ledgerStatus(db: Database.Database = getDb()): LedgerStatus {
  const { head, below } = ledgerCursors(db);
  const rows = (db.prepare('SELECT COUNT(*) AS n FROM action_ledger').get() as { n: number }).n;
  return { rows, backfillRemaining: Math.max(0, below - 1), headLag: Math.max(0, maxBlockId(db) - head), rulesVersion: LEDGER_RULES_VERSION, secrets: sightingStatus(db) };
}

// ── Query ────────────────────────────────────────────────────────────────────

export interface LedgerQuery {
  /** Encoded project name (or an alias of one), or a numeric id. */
  project?: string | null;
  /** Session UUID. */
  session?: string | null;
  /** ISO instant or YYYY-MM-DD, inclusive. */
  from?: string | null;
  /** ISO instant or YYYY-MM-DD, inclusive of that whole day. */
  to?: string | null;
  kind?: string | null;
  /** 'any' for every flagged row, or one flag name. */
  flag?: string | null;
  /** Substring of any path, URL or host. */
  path?: string | null;
  /** Substring of the command. */
  command?: string | null;
  harness?: string | null;
  tool?: string | null;
  limit?: number;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string | null;
}

export interface LedgerRow {
  id: number;
  timestamp: string;
  kind: ActionKind;
  tool: string;
  harness: string | null;
  paths: string[];
  command: string | null;
  flags: ActionFlag[];
  reasons: string;
  projectName: string | null;
  projectDisplayName: string | null;
  sessionUuid: string | null;
  toolUseId: string | null;
}

export interface LedgerPage {
  rows: LedgerRow[];
  nextCursor: string | null;
  /** Rows matching every filter. */
  total: number;
  /** Counts per kind under every filter but kind. */
  kinds: Record<string, number>;
  /** Counts per flag under every filter but flag. */
  flags: Record<string, number>;
  /** Rows carrying any flag, under every filter but flag. */
  flaggedRows: number;
  status: LedgerStatus;
}

const likeEscape = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

interface Where { sql: string[]; args: unknown[] }

function buildWhere(db: Database.Database, q: LedgerQuery, omit: 'kind' | 'flag' | null): Where | null {
  const w: Where = { sql: [], args: [] };
  if (q.project) {
    const ids = /^\d+$/.test(q.project)
      ? [Number(q.project)]
      : (db.prepare(
          `SELECT id FROM projects WHERE name = ? UNION SELECT project_id FROM project_aliases WHERE encoded_name = ?`,
        ).all(q.project, q.project) as { id: number }[]).map((r) => r.id);
    if (ids.length === 0) return null;
    w.sql.push(`l.project_id IN (${ids.map(() => '?').join(',')})`);
    w.args.push(...ids);
  }
  if (q.session) {
    const s = db.prepare('SELECT id FROM sessions WHERE session_uuid = ?').get(q.session) as { id: number } | undefined;
    if (!s) return null;
    w.sql.push('l.session_id = ?');
    w.args.push(s.id);
  }
  if (q.from) { w.sql.push('l.timestamp >= ?'); w.args.push(q.from); }
  if (q.to) { w.sql.push('l.timestamp <= ?'); w.args.push(/^\d{4}-\d{2}-\d{2}$/.test(q.to) ? `${q.to}T23:59:59.999Z` : q.to); }
  if (q.kind && omit !== 'kind') { w.sql.push('l.kind = ?'); w.args.push(q.kind); }
  if (q.flag && omit !== 'flag') {
    w.sql.push('l.flagged = 1');
    if (q.flag !== 'any') { w.sql.push(`(' ' || l.flags || ' ') LIKE ?`); w.args.push(`% ${q.flag} %`); }
  }
  if (q.path) { w.sql.push(`l.paths LIKE ? ESCAPE '\\'`); w.args.push(likeEscape(q.path)); }
  if (q.command) { w.sql.push(`l.command LIKE ? ESCAPE '\\'`); w.args.push(likeEscape(q.command)); }
  if (q.harness) { w.sql.push('l.harness = ?'); w.args.push(q.harness); }
  if (q.tool) { w.sql.push('l.tool_name = ?'); w.args.push(q.tool); }
  return w;
}

const whereSql = (w: Where, extra: string[] = []) => {
  const all = [...w.sql, ...extra];
  return all.length ? `WHERE ${all.join(' AND ')}` : '';
};

/** One page of the ledger, newest first, with counts for the filters on screen. */
export function queryLedger(db: Database.Database = getDb(), q: LedgerQuery = {}): LedgerPage {
  const status = ledgerStatus(db);
  const limit = Math.max(1, Math.min(10_000, Math.floor(q.limit ?? 100)));
  const empty: LedgerPage = { rows: [], nextCursor: null, total: 0, kinds: {}, flags: {}, flaggedRows: 0, status };
  const w = buildWhere(db, q, null);
  if (!w) return empty;

  // Keyset, not OFFSET: page 200 costs what page 1 does.
  const extra: string[] = [];
  const pageArgs: unknown[] = [];
  if (q.cursor) {
    const m = /^(.+)\|(\d+)$/.exec(q.cursor);
    if (m) {
      extra.push('(l.timestamp < ? OR (l.timestamp = ? AND l.id < ?))');
      pageArgs.push(m[1], m[1], Number(m[2]));
    }
  }
  const raw = db.prepare(`
    SELECT l.id, l.timestamp, l.kind, l.tool_name, l.harness, l.paths, l.command, l.flags, l.reasons,
           l.tool_use_id, p.name AS project_name, p.display_name AS project_display_name, s.session_uuid
      FROM action_ledger l
      LEFT JOIN projects p ON p.id = l.project_id
      LEFT JOIN sessions s ON s.id = l.session_id
     ${whereSql(w, extra)}
     ORDER BY l.timestamp DESC, l.id DESC
     LIMIT ?
  `).all(...w.args, ...pageArgs, limit + 1) as Array<{
    id: number; timestamp: string; kind: ActionKind; tool_name: string; harness: string | null; paths: string;
    command: string | null; flags: string; reasons: string; tool_use_id: string | null;
    project_name: string | null; project_display_name: string | null; session_uuid: string | null;
  }>;
  const more = raw.length > limit;
  const page = more ? raw.slice(0, limit) : raw;
  const rows: LedgerRow[] = page.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    kind: r.kind,
    tool: r.tool_name,
    harness: r.harness,
    paths: r.paths ? r.paths.split('\n') : [],
    command: r.command,
    flags: (r.flags ? r.flags.split(' ') : []) as ActionFlag[],
    reasons: r.reasons,
    projectName: r.project_name,
    projectDisplayName: r.project_display_name,
    sessionUuid: r.session_uuid,
    toolUseId: r.tool_use_id,
  }));
  const last = page[page.length - 1];

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM action_ledger l ${whereSql(w)}`).get(...w.args) as { n: number }).n;

  const kinds: Record<string, number> = Object.fromEntries(ACTION_KINDS.map((k) => [k, 0]));
  const wk = buildWhere(db, q, 'kind')!;
  for (const r of db.prepare(`SELECT l.kind, COUNT(*) AS n FROM action_ledger l ${whereSql(wk)} GROUP BY l.kind`).all(...wk.args) as { kind: string; n: number }[]) {
    kinds[r.kind] = r.n;
  }

  // Flagged rows are few; tallying their flag strings beats one query per flag.
  const flags: Record<string, number> = Object.fromEntries(ACTION_FLAGS.map((f) => [f, 0]));
  let flaggedRows = 0;
  const wf = buildWhere(db, q, 'flag')!;
  for (const r of db.prepare(`SELECT l.flags, COUNT(*) AS n FROM action_ledger l ${whereSql(wf, ['l.flagged = 1'])} GROUP BY l.flags`).all(...wf.args) as { flags: string; n: number }[]) {
    flaggedRows += r.n;
    for (const f of r.flags.split(' ')) if (f) flags[f] = (flags[f] ?? 0) + r.n;
  }

  return { rows, nextCursor: more && last ? `${last.timestamp}|${last.id}` : null, total, kinds, flags, flaggedRows, status };
}
