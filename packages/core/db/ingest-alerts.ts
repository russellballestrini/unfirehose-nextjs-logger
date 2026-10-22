// Usage alerts: threshold checks run after each pass, alert queries,
// threshold rules, calibration and plan presets. Extracted from ingest.ts.
import { getDb } from './schema';
import { setSetting } from './ingest-settings';

export function checkThresholds(db: ReturnType<typeof getDb>): number {
  const thresholds = db
    .prepare('SELECT * FROM alert_thresholds WHERE enabled = 1')
    .all() as Array<{
    id: number;
    window_minutes: number;
    metric: string;
    threshold_value: number;
  }>;

  let triggered = 0;
  const now = new Date();

  for (const t of thresholds) {
    const windowStart = new Date(now.getTime() - t.window_minutes * 60 * 1000);
    const windowStartStr = windowStart.toISOString().slice(0, 16);

    let actual = 0;
    if (t.metric === 'total_tokens') {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) as total
           FROM usage_minutes WHERE minute >= ?`
        )
        .get(windowStartStr) as { total: number };
      actual = row.total;
    } else {
      const col = t.metric; // input_tokens, output_tokens
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(${col}), 0) as total FROM usage_minutes WHERE minute >= ?`
        )
        .get(windowStartStr) as { total: number };
      actual = row.total;
    }

    if (actual > t.threshold_value) {
      // Check if we already alerted in this window (don't spam)
      const recentAlert = db
        .prepare(
          `SELECT id FROM alerts
           WHERE alert_type = 'threshold_breach' AND window_minutes = ? AND metric = ?
           AND triggered_at >= datetime('now', '-' || ? || ' minutes')`
        )
        .get(t.window_minutes, t.metric, t.window_minutes) as
        | { id: number }
        | undefined;

      if (!recentAlert) {
        db.prepare(
          `INSERT INTO alerts (alert_type, window_minutes, metric, threshold_value, actual_value, details)
           VALUES ('threshold_breach', ?, ?, ?, ?, ?)`
        ).run(
          t.window_minutes,
          t.metric,
          t.threshold_value,
          actual,
          JSON.stringify({
            windowStart: windowStartStr,
            ratio: (actual / t.threshold_value).toFixed(2),
          })
        );
        triggered++;
      }
    }
  }

  return triggered;
}

export function getRecentAlerts(limit = 20, offset = 0) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM alerts ORDER BY triggered_at DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
}

export function getAlertsCount() {
  const db = getDb();
  return (db.prepare('SELECT COUNT(*) as c FROM alerts').get() as { c: number }).c;
}

// better-sqlite3's .all() is typed unknown[], so callers that touched a row
// field failed to compile. Naming the shape here fixes it at the source rather
// than casting at each call site.
export function getUnacknowledgedAlerts(): Array<{ id: number; [k: string]: unknown }> {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM alerts WHERE acknowledged = 0 ORDER BY triggered_at DESC`
    )
    .all() as Array<{ id: number; [k: string]: unknown }>;
}

/**
 * Acknowledge every open alert in one statement.
 *
 * The route used to fetch the open list and acknowledge each row in its own
 * UPDATE — 2,741 round trips to say one thing.
 */
export function acknowledgeAllAlerts(): number {
  const db = getDb();
  return db.prepare('UPDATE alerts SET acknowledged = 1 WHERE acknowledged = 0').run().changes;
}

/**
 * Remove alerts. Acknowledging one leaves it in the recent list and in the
 * breach history for good; there was no way to be rid of it. 'acknowledged'
 * clears what has already been seen; 'all' clears everything, open included.
 * The breach history is derived from these rows and empties with them.
 */
export function clearAlerts(scope: 'acknowledged' | 'all' = 'acknowledged'): number {
  const db = getDb();
  const sql = scope === 'all' ? 'DELETE FROM alerts' : 'DELETE FROM alerts WHERE acknowledged = 1';
  return db.prepare(sql).run().changes;
}

export function acknowledgeAlert(id: number) {
  const db = getDb();
  db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').run(id);
}

export function getAlertThresholds() {
  const db = getDb();
  return db.prepare('SELECT * FROM alert_thresholds ORDER BY window_minutes, metric').all();
}

export function updateAlertThreshold(
  id: number,
  value: number,
  enabled: boolean
) {
  const db = getDb();
  db.prepare(
    'UPDATE alert_thresholds SET threshold_value = ?, enabled = ? WHERE id = ?'
  ).run(value, enabled ? 1 : 0, id);
}

/** Acknowledge every open alert measured against a (window, metric) rule.
 *  Called when that rule's threshold changes — those alerts compared usage to
 *  a number we have just declared wrong, so they carry no signal. Returns
 *  how many were acknowledged. */
export function acknowledgeAlertsForThreshold(windowMinutes: number, metric: string): number {
  const db = getDb();
  return db.prepare(
    `UPDATE alerts SET acknowledged = 1
     WHERE acknowledged = 0 AND alert_type = 'threshold_breach'
       AND window_minutes = ? AND metric = ?`
  ).run(windowMinutes, metric).changes;
}

export interface ThresholdCalibration {
  id: number;
  window_minutes: number;
  metric: string;
  previous: number;
  p95: number;
  threshold: number;
  /** Rolling-window samples the percentile was read from. */
  samples: number;
  /** Open alerts acknowledged because the rule moved. */
  acknowledged: number;
}

/** Round to two significant figures so a threshold reads as a number a
 *  human would have typed (1.8e8 → 180,000,000, not 183,838,739). */
function roundToTwoSig(x: number): number {
  if (x <= 0) return 0;
  const unit = 10 ** (Math.floor(Math.log10(x)) - 1);
  return Math.round(x / unit) * unit;
}

/**
 * Set every alert threshold to `factor` × the p95 of its own rolling window
 * over the last `days` of usage_minutes. Hand-guessed plan-tier defaults
 * either never fire or fire every window; our own history says what
 * "unusual" means here. Rules whose window never saw a token are left alone
 * — there is nothing to calibrate against. Alerts open against a moved rule
 * are acknowledged.
 */
export function calibrateAlertThresholds(days = 7, factor = 1.5, now = new Date()): ThresholdCalibration[] {
  const db = getDb();
  const totalMinutes = Math.max(1, Math.round(days * 1440));
  const endMs = Math.floor(now.getTime() / 60000) * 60000;
  const startMs = endMs - totalMinutes * 60000;
  const startStr = new Date(startMs).toISOString().slice(0, 16);

  const rows = db.prepare(
    `SELECT minute,
            SUM(input_tokens) AS input,
            SUM(output_tokens) AS output,
            SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS total
     FROM usage_minutes WHERE minute >= ? GROUP BY minute`
  ).all(startStr) as Array<{ minute: string; input: number; output: number; total: number }>;

  // Dense per-minute series with zeros for idle minutes, so a quiet night
  // counts against the percentile the way it counts against our bill.
  const n = totalMinutes + 1;
  const series: Record<string, Float64Array> = {
    input_tokens: new Float64Array(n),
    output_tokens: new Float64Array(n),
    total_tokens: new Float64Array(n),
  };
  for (const r of rows) {
    const idx = Math.round((Date.parse(r.minute + ':00Z') - startMs) / 60000);
    if (idx < 0 || idx >= n) continue;
    series.input_tokens[idx] += r.input;
    series.output_tokens[idx] += r.output;
    series.total_tokens[idx] += r.total;
  }

  const prefix = (arr: Float64Array) => {
    const p = new Float64Array(arr.length + 1);
    for (let i = 0; i < arr.length; i++) p[i + 1] = p[i] + arr[i];
    return p;
  };
  const prefixes: Record<string, Float64Array> = Object.fromEntries(
    Object.entries(series).map(([k, v]) => [k, prefix(v)])
  );

  const thresholds = db.prepare('SELECT * FROM alert_thresholds ORDER BY window_minutes, metric')
    .all() as Array<{ id: number; window_minutes: number; metric: string; threshold_value: number }>;
  const update = db.prepare('UPDATE alert_thresholds SET threshold_value = ? WHERE id = ?');

  const results: ThresholdCalibration[] = [];
  db.transaction(() => {
    for (const t of thresholds) {
      const pre = prefixes[t.metric];
      const w = t.window_minutes;
      if (!pre || w <= 0 || w >= n) continue;
      const sums: number[] = [];
      for (let i = w; i < n; i++) sums.push(pre[i] - pre[i - w]);
      sums.sort((a, b) => a - b);
      const p95 = sums[Math.floor(0.95 * (sums.length - 1))];
      if (!(p95 > 0)) continue;
      const threshold = roundToTwoSig(p95 * factor);
      let acknowledged = 0;
      if (threshold !== t.threshold_value) {
        update.run(threshold, t.id);
        acknowledged = acknowledgeAlertsForThreshold(w, t.metric);
      }
      results.push({
        id: t.id, window_minutes: w, metric: t.metric,
        previous: t.threshold_value, p95, threshold, samples: sums.length, acknowledged,
      });
    }
  })();

  setSetting('alert_calibration', JSON.stringify({ at: now.toISOString(), days, factor, results }));
  return results;
}

export interface AlertDailyCount {
  day: string;
  window_minutes: number;
  metric: string;
  count: number;
  unacknowledged: number;
  peak: number;
}

/** Breaches per day per rule — a page can say "3 today" instead of listing
 *  every row. Newest day first. */
export function getAlertDailyCounts(days = 14): AlertDailyCount[] {
  const db = getDb();
  return db.prepare(
    `SELECT substr(triggered_at, 1, 10) AS day, window_minutes, metric,
            COUNT(*) AS count,
            SUM(CASE WHEN acknowledged = 0 THEN 1 ELSE 0 END) AS unacknowledged,
            MAX(actual_value) AS peak
     FROM alerts
     WHERE alert_type = 'threshold_breach'
       AND triggered_at >= datetime('now', '-' || ? || ' days')
     GROUP BY day, window_minutes, metric
     ORDER BY day DESC, window_minutes DESC, metric`
  ).all(days) as AlertDailyCount[];
}

// === Alert Detail Queries ===

export function getAlertById(id: number) {
  const db = getDb();
  return db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as {
    id: number;
    triggered_at: string;
    alert_type: string;
    window_minutes: number;
    metric: string;
    threshold_value: number;
    actual_value: number;
    project_name: string | null;
    details: string | null;
    acknowledged: number;
  } | undefined;
}

// Plan-based threshold multipliers
const PLAN_THRESHOLDS: Record<string, Record<string, number>> = {
  // Free: conservative, single-agent light usage
  free:    { '15:output_tokens': 500000,  '15:input_tokens': 5000000,   '60:output_tokens': 1500000,  '60:input_tokens': 15000000, '1:output_tokens': 50000,  '1:input_tokens': 500000,   '5:output_tokens': 200000,  '5:input_tokens': 2000000,   '5:total_tokens': 2500000,   '15:total_tokens': 5000000,   '60:total_tokens': 15000000  },
  // Starter $14/mo: individual, a few agents
  starter: { '15:output_tokens': 1000000, '15:input_tokens': 10000000,  '60:output_tokens': 3000000,  '60:input_tokens': 30000000, '1:output_tokens': 100000, '1:input_tokens': 1000000,  '5:output_tokens': 400000,  '5:input_tokens': 4000000,   '5:total_tokens': 5000000,   '15:total_tokens': 10000000,  '60:total_tokens': 30000000  },
  // Pro $69/mo: power user, multiple concurrent agents
  pro:     { '15:output_tokens': 1750000, '15:input_tokens': 17500000,  '60:output_tokens': 5250000,  '60:input_tokens': 52500000, '1:output_tokens': 175000, '1:input_tokens': 1750000,  '5:output_tokens': 700000,  '5:input_tokens': 7000000,   '5:total_tokens': 8750000,   '15:total_tokens': 17500000,  '60:total_tokens': 52500000  },
  // Max $200/mo: heavy multi-agent, 20+ concurrent
  max:     { '15:output_tokens': 2500000, '15:input_tokens': 25000000,  '60:output_tokens': 7500000,  '60:input_tokens': 75000000, '1:output_tokens': 250000, '1:input_tokens': 2500000,  '5:output_tokens': 1000000, '5:input_tokens': 10000000,  '5:total_tokens': 12500000,  '15:total_tokens': 25000000,  '60:total_tokens': 75000000  },
  // Ultra $420/mo: maximum capacity, fleet operations
  ultra:   { '15:output_tokens': 5000000, '15:input_tokens': 50000000,  '60:output_tokens': 15000000, '60:input_tokens': 150000000, '1:output_tokens': 500000, '1:input_tokens': 5000000,  '5:output_tokens': 2000000, '5:input_tokens': 20000000,  '5:total_tokens': 25000000,  '15:total_tokens': 50000000,  '60:total_tokens': 150000000 },
};

export function applyPlanThresholds(plan: string) {
  const db = getDb();
  const thresholds = PLAN_THRESHOLDS[plan];
  if (!thresholds) return;

  const update = db.prepare(
    'UPDATE alert_thresholds SET threshold_value = ? WHERE window_minutes = ? AND metric = ?'
  );

  db.transaction(() => {
    for (const [key, value] of Object.entries(thresholds)) {
      const [win, metric] = key.split(':');
      update.run(value, Number(win), metric);
    }
  })();

  setSetting('anthropic_plan', plan);
}
