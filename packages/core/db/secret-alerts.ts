// Credentials seen at ingest, kept and raised as alerts.
//
// The ledger scanner (db/action-ledger.ts) hands every tool call it flagged
// for a credential, and every tool result findSecrets matched, to
// recordSightings. Each is one row in secret_sightings keyed on its block,
// so a re-ingest, a backfill or a ledger rebuild that meets the same line
// again records nothing and raises nothing.
//
// A new sighting raises an alert (alert_type secret_exposed) when:
//   - it came from the head scan, the one that runs at the end of an ingest
//     pass, not the history backfill; and
//   - its line is no older than secret_alerts_since, the moment this ran on
//     this database for the first time.
// So upgrading an install with a year of history, or a first ingest of an
// old ~/.claude, flags that history in the ledger and on /actions but sends
// nothing: a hundred alerts about last spring is a flood, not a warning.
// What arrives from then on alerts.
//
// One alert per session and kind. The second time a session shows the same
// kind, the sighting joins the open alert and bumps its count; delivery
// sends once. A kind new to the session raises its own. Clearing the alert
// lets the next sighting raise again.
//
// Kinds only. No value, no span, no command, no output goes into a sighting,
// an alert, its details or a log line. Operation Voyeur.

import type Database from 'better-sqlite3';
import { SECRET_ALERT_METRIC, SECRET_ALERT_TYPE, type SecretAlertDetails } from '../secret-alert';

type Db = Database.Database;

export const SECRET_ALERTS_SINCE_KEY = 'secret_alerts_since';

export interface Sighting {
  blockId: number;
  messageId: number;
  sessionId: number | null;
  projectId: number | null;
  /** The line's own time, ISO. */
  timestamp: string;
  location: 'call' | 'result';
  toolName: string | null;
  toolUseId: string | null;
  kinds: string[];
  sessionUuid: string | null;
  projectName: string | null;
  projectDisplayName: string | null;
  harness: string | null;
}

/** When secret alerts began on this database; set on first use. */
export function secretAlertsSince(db: Db, now: Date = new Date()): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SECRET_ALERTS_SINCE_KEY) as { value: string } | undefined;
  if (row?.value) return row.value;
  const iso = now.toISOString();
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(SECRET_ALERTS_SINCE_KEY, iso);
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(SECRET_ALERTS_SINCE_KEY) as { value: string }).value;
}

const OUTPUT_FLAG = 'secret-in-output';

/** The ledger's reason for a result's credential, in the words the ledger uses. */
export const outputReason = (kinds: string[]) => `its output carried a credential (${kinds.join(', ')})`;

/** Kinds already sighted in the output of this tool call, for a ledger row being written. */
export function outputKindsFor(db: Db, toolUseId: string | null, sessionId: number | null): string[] {
  if (!toolUseId) return [];
  const rows = db.prepare(
    `SELECT kinds FROM secret_sightings WHERE tool_use_id = ? AND session_id IS ? AND location = 'result'`,
  ).all(toolUseId, sessionId) as { kinds: string }[];
  return [...new Set(rows.flatMap((r) => r.kinds.split(' ').filter(Boolean)))];
}

export interface SightingResult {
  /** Sightings new to our table. */
  recorded: number;
  /** Alerts raised. */
  alerts: number;
}

/**
 * Record sightings and raise what is due. `alert: false` for the history
 * backfill: sightings are kept (and marked backfilled), nothing is raised.
 */
export function recordSightings(
  db: Db,
  sightings: Sighting[],
  opts: { alert: boolean; now?: Date },
): SightingResult {
  const out: SightingResult = { recorded: 0, alerts: 0 };
  if (!sightings.length) return out;
  const since = secretAlertsSince(db, opts.now);

  const insert = db.prepare(`
    INSERT INTO secret_sightings
      (block_id, message_id, session_id, project_id, timestamp, location, tool_name, tool_use_id, kinds, backfilled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(block_id) DO NOTHING
  `);
  const flagCall = db.prepare(`
    UPDATE action_ledger
       SET flags = CASE WHEN flags = '' THEN '${OUTPUT_FLAG}' ELSE flags || ' ${OUTPUT_FLAG}' END,
           flagged = 1,
           reasons = CASE WHEN reasons = '' THEN @why ELSE reasons || '; ' || @why END
     WHERE tool_use_id = @toolUseId AND session_id IS @sessionId
       AND (' ' || flags || ' ') NOT LIKE '% ${OUTPUT_FLAG} %'
  `);
  const toolOfCall = db.prepare('SELECT tool_name FROM action_ledger WHERE tool_use_id = ? AND session_id IS ? LIMIT 1');
  // An alert still on record for this session and kind. A cleared one does
  // not count, so a leak after a clear raises again.
  const openFor = db.prepare(`
    SELECT s.alert_id FROM secret_sightings s JOIN alerts a ON a.id = s.alert_id
     WHERE s.session_id IS ? AND (' ' || s.kinds || ' ') LIKE ? AND a.alert_type = '${SECRET_ALERT_TYPE}'
     ORDER BY s.alert_id LIMIT 1
  `);
  const raise = db.prepare(`
    INSERT INTO alerts (alert_type, window_minutes, metric, threshold_value, actual_value, project_name, details)
    VALUES ('${SECRET_ALERT_TYPE}', 0, '${SECRET_ALERT_METRIC}', 0, 1, ?, ?)
  `);
  const bump = db.prepare('UPDATE alerts SET actual_value = actual_value + 1 WHERE id = ?');
  const link = db.prepare('UPDATE secret_sightings SET alert_id = ? WHERE block_id = ?');

  db.transaction(() => {
    for (const s of sightings) {
      const kinds = s.kinds.length ? [...new Set(s.kinds)] : ['credential'];
      const res = insert.run(
        s.blockId, s.messageId, s.sessionId, s.projectId, s.timestamp, s.location, s.toolName, s.toolUseId,
        kinds.join(' '), opts.alert ? 0 : 1,
      );
      if (res.changes === 0) continue;
      out.recorded++;

      let tool = s.toolName;
      if (s.location === 'result' && s.toolUseId) {
        flagCall.run({ why: outputReason(kinds), toolUseId: s.toolUseId, sessionId: s.sessionId });
        tool ??= (toolOfCall.get(s.toolUseId, s.sessionId) as { tool_name: string } | undefined)?.tool_name ?? null;
      }

      if (!opts.alert || s.timestamp < since) continue;

      const fresh: string[] = [];
      let joined: number | null = null;
      for (const k of kinds) {
        const hit = openFor.get(s.sessionId, `% ${k} %`) as { alert_id: number } | undefined;
        if (hit && hit.alert_id) joined ??= hit.alert_id;
        else fresh.push(k);
      }
      if (fresh.length) {
        const details: SecretAlertDetails = {
          kinds: fresh,
          location: s.location,
          tool,
          session: s.sessionUuid,
          project: s.projectName,
          projectDisplay: s.projectDisplayName,
          harness: s.harness,
          seenAt: s.timestamp,
          blockId: s.blockId,
          toolUseId: s.toolUseId,
        };
        const id = Number(raise.run(s.projectName, JSON.stringify(details)).lastInsertRowid);
        link.run(id, s.blockId);
        out.alerts++;
      } else if (joined !== null) {
        bump.run(joined);
        link.run(joined, s.blockId);
      }
    }
  })();
  return out;
}

export interface SightingStatus {
  sightings: number;
  /** Sightings that raised or joined an alert. */
  alerted: number;
  since: string | null;
}

export function sightingStatus(db: Db): SightingStatus {
  const r = db.prepare(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN alert_id IS NOT NULL THEN 1 ELSE 0 END) AS a FROM secret_sightings`,
  ).get() as { n: number; a: number | null };
  const since = db.prepare('SELECT value FROM settings WHERE key = ?').get(SECRET_ALERTS_SINCE_KEY) as { value: string } | undefined;
  return { sightings: r.n, alerted: r.a ?? 0, since: since?.value ?? null };
}
