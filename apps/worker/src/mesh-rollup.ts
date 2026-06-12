/**
 * Mesh snapshot rollup: fold 15s samples past the 28-day hot-retention
 * boundary into 15-min smoothed buckets in mesh_snapshots_15m. The "snake
 * eats its tail": insert one cold-tier row, delete the 60 hot-tier rows
 * that fed it — all in a single transaction.
 *
 * Smoothing algorithm
 * ───────────────────
 * Plain bucket-means produce visible step changes at the rollup boundary
 * because each bucket is computed in isolation. We instead use a Gaussian-
 * weighted moving average across FIVE adjacent buckets:
 *
 *   prev (already cold)  current     next₁    next₂    next₃    (still hot)
 *        0.15              0.40       0.25     0.15     0.05    ← weights
 *
 * For each numeric metric, the cold-tier value is
 *
 *     Σ wᵢ · μᵢ  /  Σ wᵢ        (wᵢ summed only where μᵢ exists)
 *
 * where μᵢ is the plain mean of the i-th bucket's 15s samples (or the
 * already-smoothed value of the previous cold-tier row). This anchors the
 * rollup with continuity from the previous cold row AND looks ahead at the
 * trend of buckets that haven't aged out yet — so the transition is smooth
 * in both directions.
 *
 * Sample-count, per-bucket max for selected metrics, and the original 15s
 * source rows are also recorded (max kept for optional banding on charts).
 *
 * Metrics that don't smooth well:
 *   • claude_processes — integer count, MAX (peak concurrency) is more
 *     interesting than smoothed mean for capacity charts.
 *   • cpu_cores / mem_total_gb / power_source — host-static; copy from
 *     first sample.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Database } from 'better-sqlite3';

const HOT_RETENTION_DAYS = 28;
const BUCKET_SECONDS = 15 * 60;          // 15 min
const BUCKET_MS = BUCKET_SECONDS * 1000;

// Gaussian-ish weights centered on the bucket being rolled up. Sum = 1.0
// when all five samples exist; renormalized when some are missing.
const W_PREV = 0.15;
const W_CUR  = 0.40;
const W_N1   = 0.25;
const W_N2   = 0.15;
const W_N3   = 0.05;

const SMOOTH_COLS = [
  'load_avg_1', 'load_avg_5', 'load_avg_15',
  'mem_used_gb', 'power_watts', 'gpu_power_watts',
  'gpu_util', 'gpu_mem_used_mb',
] as const;

type SmoothCol = (typeof SMOOTH_COLS)[number];

interface MeshRow {
  timestamp: string;
  hostname: string;
  cpu_cores: number | null;
  load_avg_1: number | null;
  load_avg_5: number | null;
  load_avg_15: number | null;
  mem_total_gb: number | null;
  mem_used_gb: number | null;
  power_watts: number | null;
  gpu_power_watts: number | null;
  gpu_util: number | null;
  gpu_mem_used_mb: number | null;
  gpu_mem_total_mb: number | null;
  power_source: string | null;
  claude_processes: number | null;
}

/**
 * Round a SQLite "YYYY-MM-DD HH:MM:SS" timestamp DOWN to the start of its
 * 15-min bucket. Returns the same SQL string format.
 */
export function bucketStart(sqlTs: string): string {
  // SQLite stores in UTC by default; treat as such.
  const ms = new Date(sqlTs.replace(' ', 'T') + 'Z').getTime();
  const aligned = Math.floor(ms / BUCKET_MS) * BUCKET_MS;
  return new Date(aligned).toISOString().slice(0, 19).replace('T', ' ');
}

export function bucketEnd(bs: string): string {
  const ms = new Date(bs.replace(' ', 'T') + 'Z').getTime() + BUCKET_MS;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function mean(rows: MeshRow[], col: SmoothCol): number | null {
  let sum = 0, n = 0;
  for (const r of rows) {
    const v = r[col];
    if (v != null) { sum += v; n++; }
  }
  return n > 0 ? sum / n : null;
}

function maxOf(rows: MeshRow[], col: SmoothCol): number | null {
  let m: number | null = null;
  for (const r of rows) {
    const v = r[col];
    if (v != null && (m == null || v > m)) m = v;
  }
  return m;
}

/**
 * Roll up the single oldest eligible bucket (across all hosts) into the
 * cold tier. Returns true if a bucket was processed, false if no eligible
 * 15s rows exist yet. Self-balancing — multiple invocations drain backlog.
 */
export function rollupOneBucket(db: Database): boolean {
  // Find the oldest 15s row whose bucket has fully aged (bucket-end is past
  // 28d). Looking at timestamp alone would let us start folding a bucket
  // before its last sample crossed the boundary, producing partial rollups.
  const oldest = db.prepare(`
    SELECT timestamp, hostname
    FROM mesh_snapshots
    WHERE timestamp < datetime('now', '-${HOT_RETENTION_DAYS} days', '-${BUCKET_SECONDS} seconds')
    ORDER BY timestamp ASC
    LIMIT 1
  `).get() as { timestamp: string; hostname: string } | undefined;

  if (!oldest) return false;

  const host = oldest.hostname;
  const bs = bucketStart(oldest.timestamp);
  const be = bucketEnd(bs);

  // 60 × 15s samples in the bucket being folded.
  const samples = db.prepare(`
    SELECT * FROM mesh_snapshots
    WHERE hostname = ? AND timestamp >= ? AND timestamp < ?
    ORDER BY timestamp ASC
  `).all(host, bs, be) as MeshRow[];

  if (samples.length === 0) return false;

  // Continuity anchor — the most recent cold-tier row before this bucket.
  const prev = db.prepare(`
    SELECT * FROM mesh_snapshots_15m
    WHERE hostname = ? AND timestamp < ?
    ORDER BY timestamp DESC
    LIMIT 1
  `).get(host, bs) as Partial<MeshRow> | undefined;

  // Look-ahead — the next 3 buckets' worth of 15s samples (still in hot
  // tier). Group by bucket start.
  const fEnd = new Date(new Date(be.replace(' ', 'T') + 'Z').getTime() + 3 * BUCKET_MS)
    .toISOString().slice(0, 19).replace('T', ' ');
  const futureSamples = db.prepare(`
    SELECT * FROM mesh_snapshots
    WHERE hostname = ? AND timestamp >= ? AND timestamp < ?
    ORDER BY timestamp ASC
  `).all(host, be, fEnd) as MeshRow[];

  const fb: [MeshRow[], MeshRow[], MeshRow[]] = [[], [], []];
  for (const s of futureSamples) {
    const fbs = bucketStart(s.timestamp);
    if (fbs === be) fb[0].push(s);
    else if (new Date(fbs.replace(' ', 'T') + 'Z').getTime() === new Date(be.replace(' ', 'T') + 'Z').getTime() + BUCKET_MS) fb[1].push(s);
    else if (new Date(fbs.replace(' ', 'T') + 'Z').getTime() === new Date(be.replace(' ', 'T') + 'Z').getTime() + 2 * BUCKET_MS) fb[2].push(s);
  }

  // Smoothed values per numeric metric.
  const smoothed: Partial<Record<SmoothCol, number | null>> = {};
  for (const col of SMOOTH_COLS) {
    const mPrev = (prev?.[col] as number | undefined) ?? null;
    const mCur  = mean(samples, col);
    const mN1   = fb[0].length ? mean(fb[0], col) : null;
    const mN2   = fb[1].length ? mean(fb[1], col) : null;
    const mN3   = fb[2].length ? mean(fb[2], col) : null;

    const entries: [number, number | null][] = [
      [W_PREV, mPrev], [W_CUR, mCur], [W_N1, mN1], [W_N2, mN2], [W_N3, mN3],
    ];
    let wSum = 0, vSum = 0;
    for (const [w, v] of entries) {
      if (v != null) { wSum += w; vSum += w * v; }
    }
    smoothed[col] = wSum > 0 ? vSum / wSum : null;
  }

  // Range stats — plain max over THIS bucket only (no smoothing).
  const maxVals = {
    load_avg_1_max: maxOf(samples, 'load_avg_1'),
    power_watts_max: maxOf(samples, 'power_watts'),
    gpu_util_max: maxOf(samples, 'gpu_util'),
    mem_used_gb_max: maxOf(samples, 'mem_used_gb'),
  };

  // claude_processes — peak concurrency (max integer).
  let claudePeak = 0;
  for (const s of samples) {
    const c = s.claude_processes ?? 0;
    if (c > claudePeak) claudePeak = c;
  }

  // Host-static fields — copy from first sample.
  const meta = samples[0];

  const insertCold = db.prepare(`
    INSERT INTO mesh_snapshots_15m (
      timestamp, hostname, cpu_cores,
      load_avg_1, load_avg_5, load_avg_15,
      mem_total_gb, mem_used_gb,
      power_watts, gpu_power_watts, gpu_util,
      gpu_mem_used_mb, gpu_mem_total_mb,
      power_source, claude_processes,
      sample_count,
      load_avg_1_max, power_watts_max, gpu_util_max, mem_used_gb_max
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteHot = db.prepare(`
    DELETE FROM mesh_snapshots
    WHERE hostname = ? AND timestamp >= ? AND timestamp < ?
  `);

  const tx = db.transaction(() => {
    insertCold.run(
      bs, host, meta.cpu_cores,
      smoothed.load_avg_1, smoothed.load_avg_5, smoothed.load_avg_15,
      meta.mem_total_gb, smoothed.mem_used_gb,
      smoothed.power_watts, smoothed.gpu_power_watts, smoothed.gpu_util,
      smoothed.gpu_mem_used_mb, meta.gpu_mem_total_mb,
      meta.power_source, claudePeak,
      samples.length,
      maxVals.load_avg_1_max, maxVals.power_watts_max, maxVals.gpu_util_max, maxVals.mem_used_gb_max,
    );
    deleteHot.run(host, bs, be);
  });
  tx();

  return true;
}

/**
 * Drain as many eligible buckets as possible in one go. Useful at startup
 * (catching up on backlog) and as the body of the per-minute scheduler tick.
 * Caps to `maxPerCall` so a huge backlog doesn't lock the DB for minutes.
 */
export function rollupDrain(db: Database, maxPerCall = 16): number {
  let n = 0;
  while (n < maxPerCall) {
    if (!rollupOneBucket(db)) break;
    n++;
  }
  return n;
}
