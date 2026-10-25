/**
 * Measured energy, attributed to what used it (ticket 4004).
 *
 * Our sampler writes every node's draw every fifteen seconds (CPU by RAPL or
 * TDP, plus every GPU nvidia-smi reports, summed per node: gpu-sum.ts). Our
 * messages say which model, project and harness hit which inference
 * endpoint, and when. This module joins the two ONCE, in our sampler child,
 * into two small tables; pages and reports read those, never the per-row
 * join. The tokens route taught us that lesson: a join over every message
 * at request time is seconds charged to every other request on a
 * single-threaded server.
 *
 * Per node per 15-minute bucket (aligned with mesh_snapshots_15m):
 *
 *   total   = ∫ (cpu watts + gpu watts) dt     the same integral, and the
 *                                             same gap rule, as our monthly
 *                                             cost report's electricity line
 *   idle    = ∫ min(draw, idleWatts) dt        the node's standing cost: what
 *                                             it burns with nothing to do
 *   active  = ∫ max(0, draw − idleWatts) dt    total = idle + active, exactly
 *
 * and `active` is split across the (model, project, harness) groups whose
 * messages resolved to that node in that bucket, by estimated GPU-seconds
 * (pricing.selfHostWeight: decode ~30x a prefill token). Active draw in a
 * bucket where none of our messages landed stays unattributed: someone
 * else's client of the same vLLM, a training run, a build.
 *
 * How idle is measured: the 10th percentile, weighted by time, of the
 * node's whole draw over the seven UTC days before the bucket's day. A low
 * percentile rather than the minimum, because a probe that failed to read
 * a GPU writes a dip no idle box ever draws; seven days so the window holds
 * nights and a weekend, yet follows a hardware change within a week. A
 * node with under six sampled hours before that day (the first day we see
 * it) widens the window to include the day itself. The limit we accept: a
 * node busy more than 90% of a week reads part of its work as idle.
 *
 * Progress lives in settings, as our precomputed payloads keep theirs:
 *   energy_attribution_at         ISO time of the last refresh
 *   energy_attribution_watermark  MAX(messages.id) read before it began
 *   energy_attribution_through    first bucket not yet final (redone next run)
 * A message ingested late, into a bucket already built, is found by id
 * above the watermark and its bucket is rebuilt.
 */
import type Database from 'better-sqlite3';
import { hostname as osHostname } from 'os';
import { CLOUD_PROVIDERS, ENDPOINT_TO_NODE, selfHostWeight } from './pricing';
import { findSameBox, sameBox } from './hostname-match';
import { kwhRateForHost } from './mesh-econ';

export const ENERGY_BUCKET_MS = 15 * 60_000;
/** A gap between samples longer than this counts as unsampled. Shared with cost-report.ts. */
export const MAX_SAMPLE_GAP_MS = 5 * 60_000;
export const IDLE_PERCENTILE = 0.1;
export const IDLE_WINDOW_DAYS = 7;
export const IDLE_MIN_SAMPLED_HOURS = 6;
export const HOURS_PER_MONTH = 730;

const DAY_MS = 86_400_000;
const LOCAL_ENDPOINT_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export const ENERGY_KEYS = {
  at: 'energy_attribution_at',
  watermark: 'energy_attribution_watermark',
  through: 'energy_attribution_through',
} as const;

// ── Time ──────────────────────────────────────────────────────────────────────

export const sqlTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const parseSqlTime = (s: string) => Date.parse(s.replace(' ', 'T') + 'Z');
export const bucketOf = (ms: number) => Math.floor(ms / ENERGY_BUCKET_MS) * ENERGY_BUCKET_MS;
const dayOf = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;

/** Whether two consecutive samples this far apart bound a measured interval. */
export function integrable(dtMs: number): boolean {
  return dtMs > 0 && dtMs <= MAX_SAMPLE_GAP_MS;
}

// ── Pure pieces ───────────────────────────────────────────────────────────────

/** A stretch of time a node was measured at one draw. */
export interface Interval {
  ts: number;
  hours: number;
  /** Whole node: CPU + every GPU. */
  watts: number;
  gpuWatts: number;
}

export interface HotSample { ts: number; watts: number; gpuWatts: number }
export interface ColdSample extends HotSample { sampleCount: number }

/**
 * One node's samples as measured intervals. A 15 s row holds its draw until
 * the next row (left Riemann, as the cost report integrates), unless the
 * gap is too long to trust; a 15-minute cold row is a quarter hour, or the
 * share of one its sample count says was seen.
 */
export function hostIntervals(hot: HotSample[], cold: ColdSample[] = []): Interval[] {
  const out: Interval[] = [];
  const h = [...hot].sort((a, b) => a.ts - b.ts);
  for (let i = 0; i + 1 < h.length; i++) {
    const dt = h[i + 1].ts - h[i].ts;
    if (integrable(dt)) out.push({ ts: h[i].ts, hours: dt / 3_600_000, watts: h[i].watts, gpuWatts: h[i].gpuWatts });
  }
  for (const c of cold) {
    const hours = 0.25 * Math.min(1, Math.max(0, c.sampleCount) / 60);
    if (hours > 0) out.push({ ts: c.ts, hours, watts: c.watts, gpuWatts: c.gpuWatts });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** The value below which `p` of the total weight lies. Null for no weight. */
export function weightedPercentile(values: { v: number; w: number }[], p: number): number | null {
  const xs = values.filter((x) => x.w > 0 && Number.isFinite(x.v)).sort((a, b) => a.v - b.v);
  const total = xs.reduce((a, x) => a + x.w, 0);
  if (!(total > 0)) return null;
  const target = Math.min(1, Math.max(0, p)) * total;
  let acc = 0;
  for (const x of xs) {
    acc += x.w;
    if (acc >= target) return x.v;
  }
  return xs[xs.length - 1].v;
}

/**
 * The idle draw for buckets on the UTC day starting `dayStart`: p10 of the
 * node's draw over the seven days before it, or, with under six sampled
 * hours there, over those days and the day itself up to `limit`. A zero
 * reading is a probe that read nothing, not an idle node, and is skipped.
 */
export function idleWattsForDay(intervals: Interval[], dayStart: number, limit = Infinity): number | null {
  return idleWindow(intervals, dayStart, limit).watts;
}

/** As idleWattsForDay, saying whether the window had to widen into the day itself. */
export function idleWindow(intervals: Interval[], dayStart: number, limit = Infinity): { watts: number | null; widened: boolean } {
  const pick = (from: number, to: number) =>
    intervals.filter((x) => x.ts >= from && x.ts < to && x.watts > 0).map((x) => ({ v: x.watts, w: x.hours }));
  const from = dayStart - IDLE_WINDOW_DAYS * DAY_MS;
  const before = pick(from, dayStart);
  if (before.reduce((a, x) => a + x.w, 0) >= IDLE_MIN_SAMPLED_HOURS) {
    return { watts: weightedPercentile(before, IDLE_PERCENTILE), widened: false };
  }
  return { watts: weightedPercentile(pick(from, Math.min(dayStart + DAY_MS, limit)), IDLE_PERCENTILE), widened: true };
}

export interface NodeBucket {
  bucket: number;
  sampledHours: number;
  totalWh: number;
  gpuWh: number;
  idleWatts: number | null;
  idleWh: number;
  activeWh: number;
}

/** Integrate a node's intervals starting in [from, to) into 15-minute buckets, idle subtracted. */
export function integrateBuckets(
  intervals: Interval[], from: number, to: number, idleFor: (ts: number) => number | null,
): Map<number, NodeBucket> {
  const out = new Map<number, NodeBucket>();
  for (const x of intervals) {
    if (x.ts < from || x.ts >= to) continue;
    const b = bucketOf(x.ts);
    const idle = idleFor(x.ts);
    const nb = out.get(b) ?? { bucket: b, sampledHours: 0, totalWh: 0, gpuWh: 0, idleWatts: idle, idleWh: 0, activeWh: 0 };
    nb.sampledHours += x.hours;
    nb.totalWh += x.watts * x.hours;
    nb.gpuWh += x.gpuWatts * x.hours;
    if (idle == null) {
      // Nothing to subtract: all of it is standing, none is attributable.
      nb.idleWh += x.watts * x.hours;
    } else {
      nb.idleWh += Math.min(x.watts, idle) * x.hours;
      nb.activeWh += Math.max(0, x.watts - idle) * x.hours;
    }
    out.set(b, nb);
  }
  return out;
}

/**
 * Split a bucket's active Wh across the groups that used the node, by
 * weight (estimated GPU-seconds); by message count when no group carries a
 * weight. Shares sum to activeWh whenever any group exists.
 */
export function splitActive(activeWh: number, groups: { weight: number; messages: number }[]): number[] {
  if (groups.length === 0) return [];
  const w = groups.reduce((a, g) => a + Math.max(0, g.weight), 0);
  if (w > 0) return groups.map((g) => activeWh * (Math.max(0, g.weight) / w));
  const n = groups.reduce((a, g) => a + Math.max(0, g.messages), 0);
  if (n > 0) return groups.map((g) => activeWh * (Math.max(0, g.messages) / n));
  return groups.map(() => activeWh / groups.length);
}

/**
 * The mesh node an inference endpoint names: our fixed endpoint map first,
 * then any node we sample under that name (an alias, or the fqdn the box
 * reports), and a loopback endpoint is the node this process runs on.
 */
export function resolveMeshHost(
  endpoint: string | null | undefined, meshHosts: readonly string[], localHostname: string = osHostname(),
): string | null {
  if (!endpoint) return null;
  let host: string;
  try { host = new URL(endpoint).hostname.toLowerCase(); } catch { return null; }
  if (!host) return null;
  const mapped = ENDPOINT_TO_NODE[host];
  if (mapped) return findSameBox(meshHosts, mapped, (h) => [h]) ?? mapped;
  if (LOCAL_ENDPOINT_HOSTS.has(host)) return meshHosts.find((h) => sameBox(h, localHostname)) ?? null;
  return findSameBox(meshHosts, host, (h) => [h]) ?? null;
}

// ── Settings, against the handle we were given ───────────────────────────────

function readSetting(db: Database.Database, key: string): string | null {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

function writeSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value);
}

// ── Build ─────────────────────────────────────────────────────────────────────

interface Group {
  bucket: number; hostname: string; model: string; projectId: number; harness: string;
  messages: number; input: number; output: number; cacheRead: number; cacheWrite: number; weight: number;
}

/** Rebuild every bucket in [from, to). One transaction; returns node buckets written. */
/**
 * A node's idle for a UTC day, once computed from a full window before
 * that day, never changes: our sampler keeps them across ticks so a tick
 * that rebuilds the current quarter hour reads that quarter hour, not a
 * week of samples.
 */
export type IdleCache = Map<string, number | null>;

/** Rebuild every bucket in [from, to). One transaction; returns node buckets written. */
export function buildEnergyChunk(
  db: Database.Database, from: number, to: number,
  opts: { now?: number; localHostname?: string; idleCache?: IdleCache } = {},
): number {
  const now = opts.now ?? Date.now();
  const cache = opts.idleCache;

  const hotSql = db.prepare(`
    SELECT hostname, timestamp, COALESCE(power_watts, 0) AS cpu, COALESCE(gpu_power_watts, 0) AS gpu
      FROM mesh_snapshots WHERE timestamp >= ? AND timestamp < ?
  `);
  const coldSql = db.prepare(`
    SELECT hostname, timestamp, COALESCE(power_watts, 0) AS cpu, COALESCE(gpu_power_watts, 0) AS gpu, sample_count
      FROM mesh_snapshots_15m WHERE timestamp >= ? AND timestamp < ?
  `);
  const byHost = new Map<string, { hot: HotSample[]; cold: ColdSample[] }>();
  const slot = (h: string) => { let s = byHost.get(h); if (!s) { s = { hot: [], cold: [] }; byHost.set(h, s); } return s; };
  const load = (a: number, b: number) => {
    for (const r of hotSql.all(sqlTime(a), sqlTime(b)) as { hostname: string; timestamp: string; cpu: number; gpu: number }[]) {
      slot(r.hostname).hot.push({ ts: parseSqlTime(r.timestamp), watts: r.cpu + r.gpu, gpuWatts: r.gpu });
    }
    for (const r of coldSql.all(sqlTime(a), sqlTime(b)) as { hostname: string; timestamp: string; cpu: number; gpu: number; sample_count: number }[]) {
      slot(r.hostname).cold.push({ ts: parseSqlTime(r.timestamp), watts: r.cpu + r.gpu, gpuWatts: r.gpu, sampleCount: r.sample_count ?? 0 });
    }
  };
  // The chunk itself, one gap past its end so its last sample has a
  // successor, and the rest of its last day for a node too new to have a
  // week behind it.
  const windowTo = Math.max(to + MAX_SAMPLE_GAP_MS, Math.min(dayOf(to - 1) + DAY_MS, now + 1000));
  load(from, windowTo);
  const days: number[] = [];
  for (let d = dayOf(from); d < to; d += DAY_MS) days.push(d);
  const missing = !cache || [...byHost.keys()].some((h) => days.some((d) => !cache.has(`${h}\0${d}`)));
  if (missing) load(dayOf(from) - IDLE_WINDOW_DAYS * DAY_MS, from);

  const nodeBuckets = new Map<string, Map<number, NodeBucket>>();
  for (const [host, s] of byHost) {
    const intervals = hostIntervals(s.hot, s.cold);
    const idleByDay = new Map<number, number | null>();
    const idleFor = (ts: number) => {
      const d = dayOf(ts);
      if (idleByDay.has(d)) return idleByDay.get(d)!;
      const key = `${host}\0${d}`;
      let watts: number | null;
      if (cache?.has(key)) watts = cache.get(key)!;
      else {
        const w = idleWindow(intervals, d, now);
        watts = w.watts;
        if (cache && !w.widened) cache.set(key, watts);
      }
      idleByDay.set(d, watts);
      return watts;
    };
    const buckets = integrateBuckets(intervals, from, to, idleFor);
    if (buckets.size) nodeBuckets.set(host, buckets);
  }

  // Our messages that named an endpoint, folded to the minute in SQL so the
  // rows that cross into JS are few.
  const meshHosts = [...new Set([
    ...byHost.keys(),
    ...(db.prepare('SELECT hostname FROM mesh_node_facts').all() as { hostname: string }[]).map((r) => r.hostname),
  ])];
  const usage = db.prepare(`
    SELECT m.endpoint, m.provider, m.model,
           COALESCE(s.project_id, 0) AS project_id,
           COALESCE(s.harness, 'claude-code') AS harness,
           substr(m.timestamp, 1, 16) AS minute,
           COUNT(*) AS messages,
           SUM(COALESCE(m.input_tokens, 0)) AS input,
           SUM(COALESCE(m.output_tokens, 0)) AS output,
           SUM(COALESCE(m.cache_read_tokens, 0)) AS cache_read,
           SUM(COALESCE(m.cache_creation_tokens, 0)) AS cache_write
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
     WHERE m.timestamp >= ? AND m.timestamp < ?
       AND m.endpoint IS NOT NULL AND m.model IS NOT NULL AND m.model != '<synthetic>'
     GROUP BY m.endpoint, m.provider, m.model, project_id, harness, minute
  `).all(new Date(from).toISOString(), new Date(to).toISOString()) as {
    endpoint: string; provider: string | null; model: string; project_id: number; harness: string; minute: string;
    messages: number; input: number; output: number; cache_read: number; cache_write: number;
  }[];

  const resolved = new Map<string, string | null>();
  const groups = new Map<string, Group>();
  for (const u of usage) {
    if (u.provider && CLOUD_PROVIDERS.has(u.provider)) continue;
    if (!resolved.has(u.endpoint)) resolved.set(u.endpoint, resolveMeshHost(u.endpoint, meshHosts, opts.localHostname));
    const host = resolved.get(u.endpoint);
    if (!host) continue;
    const ts = Date.parse(u.minute + ':00Z');
    if (!Number.isFinite(ts)) continue;
    const bucket = bucketOf(ts);
    const k = [host, bucket, u.model, u.project_id, u.harness].join('\0');
    const g = groups.get(k) ?? {
      bucket, hostname: host, model: u.model, projectId: u.project_id, harness: u.harness,
      messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, weight: 0,
    };
    g.messages += u.messages; g.input += u.input; g.output += u.output;
    g.cacheRead += u.cache_read; g.cacheWrite += u.cache_write;
    g.weight += selfHostWeight(u.model, u.input, u.output, u.cache_read, u.cache_write);
    groups.set(k, g);
  }
  const groupsByNodeBucket = new Map<string, Group[]>();
  for (const g of groups.values()) {
    const k = `${g.hostname}\0${g.bucket}`;
    const list = groupsByNodeBucket.get(k) ?? [];
    list.push(g);
    groupsByNodeBucket.set(k, list);
  }

  const delNodes = db.prepare('DELETE FROM node_energy_15m WHERE bucket >= ? AND bucket < ?');
  const delGroups = db.prepare('DELETE FROM energy_attribution_15m WHERE bucket >= ? AND bucket < ?');
  const insNode = db.prepare(`
    INSERT INTO node_energy_15m (bucket, hostname, sampled_hours, total_wh, gpu_wh, idle_watts, idle_wh, active_wh, attributed_wh)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insGroup = db.prepare(`
    INSERT INTO energy_attribution_15m (bucket, hostname, model, project_id, harness, messages,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, weight, active_wh, measured)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let written = 0;
  db.transaction(() => {
    delNodes.run(sqlTime(from), sqlTime(to));
    delGroups.run(sqlTime(from), sqlTime(to));
    for (const [host, buckets] of nodeBuckets) {
      for (const nb of buckets.values()) {
        const list = groupsByNodeBucket.get(`${host}\0${nb.bucket}`) ?? [];
        const shares = splitActive(nb.activeWh, list);
        list.forEach((g, i) => insGroup.run(
          sqlTime(g.bucket), host, g.model, g.projectId, g.harness, g.messages,
          g.input, g.output, g.cacheRead, g.cacheWrite, g.weight, shares[i], 1,
        ));
        groupsByNodeBucket.delete(`${host}\0${nb.bucket}`);
        insNode.run(
          sqlTime(nb.bucket), host, nb.sampledHours, nb.totalWh, nb.gpuWh, nb.idleWatts,
          nb.idleWh, nb.activeWh, shares.reduce((a, x) => a + x, 0),
        );
        written++;
      }
    }
    // Tokens a node served while we were not sampling it: kept, unmeasured,
    // so a reader knows to fall back to the flat estimate for them.
    for (const list of groupsByNodeBucket.values()) {
      for (const g of list) {
        insGroup.run(
          sqlTime(g.bucket), g.hostname, g.model, g.projectId, g.harness, g.messages,
          g.input, g.output, g.cacheRead, g.cacheWrite, g.weight, 0, 0,
        );
      }
    }
  })();
  return written;
}

export interface EnergyRefreshResult { chunks: number; buckets: number; through: string | null }

/**
 * Bring both tables up to date. Rebuilds from the first bucket not yet
 * final (or from the earliest bucket holding a message ingested since the
 * last run, when that is older), a chunk at a time, until it reaches now
 * or spends `budgetMs`; the rest waits for the next tick.
 */
export function refreshEnergyAttribution(
  db: Database.Database,
  opts: { now?: number; localHostname?: string; budgetMs?: number; chunkDays?: number; idleCache?: IdleCache } = {},
): EnergyRefreshResult {
  const now = opts.now ?? Date.now();
  const started = Date.now();
  const budget = opts.budgetMs ?? 2_000;
  const chunk = Math.max(1, opts.chunkDays ?? 2) * DAY_MS;
  const current = bucketOf(now);

  const maxId = (db.prepare('SELECT MAX(id) AS id FROM messages').get() as { id: number | null }).id ?? 0;
  const wm = Number(readSetting(db, ENERGY_KEYS.watermark) ?? 0) || 0;
  const throughRaw = readSetting(db, ENERGY_KEYS.through);

  let from: number | null = throughRaw ? parseSqlTime(throughRaw) : null;
  if (from == null || !Number.isFinite(from)) {
    const earliest = db.prepare(`
      SELECT MIN(t) AS t FROM (
        SELECT MIN(timestamp) AS t FROM mesh_snapshots
        UNION ALL SELECT MIN(timestamp) FROM mesh_snapshots_15m
      )
    `).get() as { t: string | null };
    from = earliest.t ? bucketOf(parseSqlTime(earliest.t)) : null;
  }
  if (maxId > wm) {
    const late = db.prepare(
      'SELECT MIN(timestamp) AS t FROM messages WHERE id > ? AND endpoint IS NOT NULL AND timestamp IS NOT NULL',
    ).get(wm) as { t: string | null };
    const lt = late.t ? Date.parse(late.t) : NaN;
    if (Number.isFinite(lt) && (from == null || lt < from)) from = bucketOf(lt);
  }

  const result: EnergyRefreshResult = { chunks: 0, buckets: 0, through: null };
  if (from != null) {
    while (from <= current) {
      const end = Math.min(from + chunk, current + ENERGY_BUCKET_MS);
      result.buckets += buildEnergyChunk(db, from, end, { now, localHostname: opts.localHostname, idleCache: opts.idleCache });
      result.chunks++;
      from = end;
      if (Date.now() - started > budget) break;
    }
    // The bucket now is still filling: final only once the clock is past it.
    const through = Math.min(from, current);
    result.through = sqlTime(through);
    writeSetting(db, ENERGY_KEYS.through, result.through);
  }
  writeSetting(db, ENERGY_KEYS.watermark, String(maxId));
  writeSetting(db, ENERGY_KEYS.at, new Date(now).toISOString());
  return result;
}

// ── Read ──────────────────────────────────────────────────────────────────────

export interface EnergyHost {
  hostname: string;
  /** $/kWh this node is priced at. */
  rateKwh: number;
  /** The baseline subtracted in the newest bucket of the window. */
  idleWatts: number | null;
  /** idleWatts held for a month at rateKwh: what the node costs switched on. */
  standingMonthlyUSD: number | null;
  sampledHours: number;
  totalKwh: number;
  gpuKwh: number;
  standingKwh: number;
  activeKwh: number;
  attributedKwh: number;
  unattributedKwh: number;
  standingUSD: number;
  attributedUSD: number;
  unattributedUSD: number;
  totalUSD: number;
}

export interface EnergyShare {
  key: string;
  kwh: number;
  usd: number;
  messages: number;
  tokens: number;
  /** Tokens in buckets where their node was sampled. The rest have no measurement. */
  measuredTokens: number;
  hosts: string[];
}

export interface EnergyGroup {
  hostname: string; model: string;
  /** Display name, and the project row's own name (for folding onto a repo). */
  project: string; projectName: string; harness: string;
  kwh: number; usd: number; messages: number; tokens: number; measuredTokens: number;
}

export interface EnergyAttribution {
  from: string;
  to: string;
  hosts: EnergyHost[];
  byModel: EnergyShare[];
  byProject: EnergyShare[];
  byHarness: EnergyShare[];
  /** Every (node, model, project, harness) row the shares above fold. */
  groups: EnergyGroup[];
  /** When our sampler last refreshed the tables; null before its first run. */
  computedAt: string | null;
}

/** The economics settings a price needs, when the caller did not hand them over. */
function readEconSettings(db: Database.Database): Record<string, string> {
  const rows = db.prepare(
    `SELECT key, value FROM settings WHERE key LIKE 'mesh\\_node\\_econ\\_%' ESCAPE '\\' OR key = 'mesh_default_electricity_kwh'`,
  ).all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/**
 * Energy over [from, to) by node, model, project and harness, priced at
 * each node's rate. Reads only the pre-aggregated tables: a few rows per
 * node per quarter hour, whatever the message count.
 */
export function readEnergyAttribution(
  db: Database.Database,
  opts: { from: number; to: number; hostname?: string; settings?: Record<string, string> },
): EnergyAttribution {
  const settings = opts.settings ?? readEconSettings(db);
  const from = sqlTime(bucketOf(opts.from));
  const to = sqlTime(opts.to);
  const hostClause = opts.hostname ? ' AND hostname = ?' : '';
  const args: unknown[] = opts.hostname ? [from, to, opts.hostname] : [from, to];

  const nodes = db.prepare(`
    SELECT hostname, SUM(sampled_hours) AS hours, SUM(total_wh) AS total, SUM(gpu_wh) AS gpu,
           SUM(idle_wh) AS idle, SUM(active_wh) AS active, SUM(attributed_wh) AS attributed
      FROM node_energy_15m WHERE bucket >= ? AND bucket < ?${hostClause}
     GROUP BY hostname ORDER BY hostname
  `).all(...args) as { hostname: string; hours: number; total: number; gpu: number; idle: number; active: number; attributed: number }[];
  // SQLite hands back the row MAX picked for a bare column: the newest idle.
  const newest = new Map((db.prepare(`
    SELECT hostname, idle_watts, MAX(bucket) AS b FROM node_energy_15m
     WHERE bucket >= ? AND bucket < ?${hostClause} GROUP BY hostname
  `).all(...args) as { hostname: string; idle_watts: number | null }[]).map((r) => [r.hostname, r.idle_watts]));

  const rateOf = new Map<string, number>();
  const rate = (h: string) => {
    let r = rateOf.get(h);
    if (r == null) { r = kwhRateForHost(settings, h); rateOf.set(h, r); }
    return r;
  };

  const hosts: EnergyHost[] = nodes.map((n) => {
    const r = rate(n.hostname);
    const idleW = newest.get(n.hostname) ?? null;
    const kwh = (wh: number) => (wh ?? 0) / 1000;
    const unattributed = Math.max(0, (n.active ?? 0) - (n.attributed ?? 0));
    return {
      hostname: n.hostname,
      rateKwh: r,
      idleWatts: idleW,
      standingMonthlyUSD: idleW != null ? (idleW / 1000) * HOURS_PER_MONTH * r : null,
      sampledHours: n.hours ?? 0,
      totalKwh: kwh(n.total),
      gpuKwh: kwh(n.gpu),
      standingKwh: kwh(n.idle),
      activeKwh: kwh(n.active),
      attributedKwh: kwh(n.attributed),
      unattributedKwh: kwh(unattributed),
      standingUSD: kwh(n.idle) * r,
      attributedUSD: kwh(n.attributed) * r,
      unattributedUSD: kwh(unattributed) * r,
      totalUSD: kwh(n.total) * r,
    };
  });

  const groups = db.prepare(`
    SELECT a.hostname, a.model, a.harness,
           COALESCE(p.display_name, p.name, '(no project)') AS project,
           COALESCE(p.name, '(no project)') AS project_name,
           SUM(a.messages) AS messages,
           SUM(a.input_tokens + a.output_tokens + a.cache_read_tokens + a.cache_write_tokens) AS tokens,
           SUM(CASE WHEN a.measured = 1 THEN a.input_tokens + a.output_tokens + a.cache_read_tokens + a.cache_write_tokens ELSE 0 END) AS measured_tokens,
           SUM(a.active_wh) AS wh
      FROM energy_attribution_15m a
      LEFT JOIN projects p ON p.id = a.project_id
     WHERE a.bucket >= ? AND a.bucket < ?${opts.hostname ? ' AND a.hostname = ?' : ''}
     GROUP BY a.hostname, a.model, a.harness, project, project_name
  `).all(...args) as { hostname: string; model: string; harness: string; project: string; project_name: string; messages: number; tokens: number; measured_tokens: number; wh: number }[];

  const fold = (keyOf: (g: (typeof groups)[number]) => string): EnergyShare[] => {
    const m = new Map<string, EnergyShare & { hostSet: Set<string> }>();
    for (const g of groups) {
      const k = keyOf(g);
      const s = m.get(k) ?? { key: k, kwh: 0, usd: 0, messages: 0, tokens: 0, measuredTokens: 0, hosts: [], hostSet: new Set<string>() };
      const kwh = (g.wh ?? 0) / 1000;
      s.kwh += kwh;
      s.usd += kwh * rate(g.hostname);
      s.messages += g.messages ?? 0;
      s.tokens += g.tokens ?? 0;
      s.measuredTokens += g.measured_tokens ?? 0;
      s.hostSet.add(g.hostname);
      m.set(k, s);
    }
    return [...m.values()]
      .map(({ hostSet, ...s }) => ({ ...s, hosts: [...hostSet].sort() }))
      .sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
  };

  return {
    from, to, hosts,
    byModel: fold((g) => g.model),
    byProject: fold((g) => g.project),
    byHarness: fold((g) => g.harness),
    groups: groups.map((g) => ({
      hostname: g.hostname, model: g.model, project: g.project, projectName: g.project_name, harness: g.harness,
      kwh: (g.wh ?? 0) / 1000, usd: ((g.wh ?? 0) / 1000) * rate(g.hostname),
      messages: g.messages ?? 0, tokens: g.tokens ?? 0, measuredTokens: g.measured_tokens ?? 0,
    })),
    computedAt: readSetting(db, ENERGY_KEYS.at),
  };
}
