import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './test/db-helper';
import {
  weightedPercentile, idleWattsForDay, idleWindow, hostIntervals, integrateBuckets, splitActive,
  resolveMeshHost, resolveUsageHost, refreshEnergyAttribution, readEnergyAttribution, buildEnergyChunk, measuredIdleWindow,
  ENERGY_BUCKET_MS, ENERGY_KEYS, ENERGY_RULES_VERSION, QUIET_MATCH_MS, sqlTime, type Interval, type IdleCache,
} from './energy-attribution';
import { selfHostWeight } from './pricing';
import { nodeEconKey } from './mesh-econ';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN = 60_000;
/** A Monday, midnight UTC: bucket and day boundaries fall on round numbers. */
const T0 = Date.parse('2026-10-12T00:00:00Z');

const flat = (from: number, to: number, watts: number, stepMs = MIN): Interval[] => {
  const out: Interval[] = [];
  for (let t = from; t < to; t += stepMs) out.push({ ts: t, hours: stepMs / HOUR, watts, gpuWatts: 0 });
  return out;
};

describe('weightedPercentile', () => {
  it('is the value below which that share of the weight lies', () => {
    const xs = [{ v: 10, w: 1 }, { v: 20, w: 8 }, { v: 300, w: 1 }];
    expect(weightedPercentile(xs, 0.1)).toBe(10);
    expect(weightedPercentile(xs, 0.5)).toBe(20);
    expect(weightedPercentile(xs, 1)).toBe(300);
  });
  it('weighs by time: a long quiet stretch outvotes many short spikes', () => {
    const xs = [...Array(50)].map(() => ({ v: 400, w: 0.01 })).concat([{ v: 90, w: 10 }]);
    expect(weightedPercentile(xs, 0.1)).toBe(90);
  });
  it('no weight is no answer', () => {
    expect(weightedPercentile([], 0.1)).toBeNull();
    expect(weightedPercentile([{ v: 5, w: 0 }], 0.1)).toBeNull();
  });
});

describe('idle: p10 of the trailing week', () => {
  it('reads the week before the day, so the day it prices does not move it', () => {
    // 90 W most of the time, 400 W a fifth of it: the week's p10 is the idle draw.
    const week = flat(T0 - 7 * DAY, T0, 90).map((x, i) => (i % 5 === 0 ? { ...x, watts: 400 } : x));
    const today = flat(T0, T0 + DAY, 400);
    expect(idleWattsForDay([...week, ...today], T0)).toBe(90);
    expect(idleWindow([...week, ...today], T0).widened).toBe(false);
  });

  it('a probe that read nothing is not an idle node', () => {
    const week = flat(T0 - 7 * DAY, T0, 120).map((x, i) => (i % 4 === 0 ? { ...x, watts: 0 } : x));
    expect(idleWattsForDay(week, T0)).toBe(120);
  });

  it('a node first seen today widens the window into today', () => {
    const today = flat(T0, T0 + 10 * HOUR, 60).concat(flat(T0 + 10 * HOUR, T0 + 12 * HOUR, 300));
    const w = idleWindow(today, T0);
    expect(w).toEqual({ watts: 60, widened: true });
    // ... up to now, never past it.
    expect(idleWattsForDay(today, T0, T0 + 9 * HOUR)).toBe(60);
  });

  it('nothing sampled is no idle at all', () => {
    expect(idleWattsForDay([], T0)).toBeNull();
  });
});

describe('integration', () => {
  it('holds each 15 s sample until the next, and drops a gap over five minutes', () => {
    const hot = [
      { ts: T0, watts: 100, gpuWatts: 40 },
      { ts: T0 + 15_000, watts: 100, gpuWatts: 40 },
      { ts: T0 + 5 * MIN + 15_000, watts: 200, gpuWatts: 0 }, // exactly five minutes on: kept
      { ts: T0 + 20 * MIN, watts: 300, gpuWatts: 0 },          // ~15 min gap: unsampled
    ];
    const iv = hostIntervals(hot);
    expect(iv.map((x) => x.ts)).toEqual([T0, T0 + 15_000]);
    expect(iv[1].hours).toBeCloseTo(5 / 60, 9);
  });

  it('counts a cold 15-minute row as the share of a quarter hour it sampled', () => {
    const iv = hostIntervals([], [{ ts: T0, watts: 200, gpuWatts: 50, sampleCount: 30 }]);
    expect(iv).toEqual([{ ts: T0, hours: 0.125, watts: 200, gpuWatts: 50 }]);
  });

  it('subtracts idle: standing + active is everything drawn, and a dip below idle is not negative', () => {
    const iv: Interval[] = [
      { ts: T0, hours: 0.1, watts: 300, gpuWatts: 200 },
      { ts: T0 + 6 * MIN, hours: 0.1, watts: 50, gpuWatts: 10 },
      { ts: T0 + 16 * MIN, hours: 0.25, watts: 80, gpuWatts: 0 },
    ];
    const b = integrateBuckets(iv, T0, T0 + HOUR, () => 80);
    const first = b.get(T0)!;
    expect(first.totalWh).toBeCloseTo(35, 9);
    expect(first.gpuWh).toBeCloseTo(21, 9);
    expect(first.idleWh).toBeCloseTo(8 + 5, 9);       // min(300,80)·0.1 + min(50,80)·0.1
    expect(first.activeWh).toBeCloseTo(22, 9);        // (300-80)·0.1, nothing for the dip
    expect(first.idleWh + first.activeWh).toBeCloseTo(first.totalWh, 9);
    expect(first.idleWatts).toBe(80);
    const second = b.get(T0 + ENERGY_BUCKET_MS)!;
    expect(second.activeWh).toBe(0);
    expect(second.idleWh).toBeCloseTo(20, 9);
  });

  it('with no idle known, all of it is standing', () => {
    const b = integrateBuckets([{ ts: T0, hours: 0.25, watts: 100, gpuWatts: 0 }], T0, T0 + HOUR, () => null);
    expect(b.get(T0)).toMatchObject({ idleWh: 25, activeWh: 0, idleWatts: null });
  });
});

describe('grade B: energy from counters beside the estimate (4013)', () => {
  const RANGE = 262_143_328_850;
  // 15 s apart; RAPL +1.2e9 µJ (80 W), NVML +4.5e6 mJ (300 W); watts estimate says 90 + 280.
  const hot = (n: number) => Array.from({ length: n }, (_, i) => ({
    ts: T0 + i * 15_000, watts: 370, gpuWatts: 280,
    cpuEnergy: [{ uj: 1e9 + i * 1.2e9, max: RANGE }], gpuEnergyMj: 1e9 + i * 4.5e6,
  }));

  it('an interval between two counted samples carries exact measured watt-hours', () => {
    const [iv] = hostIntervals(hot(2));
    expect(iv.watts).toBe(370);                       // the estimate stays
    expect(iv.measuredWh).toBeCloseTo((1200 + 4500) / 3600, 9);
    expect(iv.measuredGpuWh).toBeCloseTo(4500 / 3600, 9);
  });

  it('a RAPL wrap mid-interval is one range, not a negative', () => {
    const a = { ts: T0, watts: 370, gpuWatts: 0, cpuEnergy: [{ uj: RANGE - 600e6, max: RANGE }] };
    const b = { ts: T0 + 15_000, watts: 370, gpuWatts: 0, cpuEnergy: [{ uj: 600e6, max: RANGE }] };
    expect(hostIntervals([a, b])[0].measuredWh).toBeCloseTo(1200e6 / 3.6e9, 9);
  });

  it('a GPU box with no NVML counter is not measured, however good its RAPL', () => {
    const a = { ts: T0, watts: 370, gpuWatts: 280, cpuEnergy: [{ uj: 0, max: RANGE }] };
    const b = { ts: T0 + 15_000, watts: 370, gpuWatts: 280, cpuEnergy: [{ uj: 1.2e9, max: RANGE }] };
    expect(hostIntervals([a, b])[0].measuredWh).toBeUndefined();
  });

  it('a bucket is grade B when counters covered it, C when a stretch was uncounted', () => {
    const all = integrateBuckets(hostIntervals(hot(61)), T0, T0 + ENERGY_BUCKET_MS, () => 100);
    const b = all.get(T0)!;
    expect(b.grade).toBe('B');
    expect(b.measuredHours).toBeCloseTo(b.sampledHours, 9);
    expect(b.measuredWh).toBeCloseTo(60 * (1200 + 4500) / 3600, 6);
    // Drop the counters from the last third: coverage falls to 2/3.
    const partial = hot(61).map((s, i) => (i >= 40 ? { ...s, cpuEnergy: null, gpuEnergyMj: null } : s));
    expect(integrateBuckets(hostIntervals(partial), T0, T0 + ENERGY_BUCKET_MS, () => 100).get(T0)!.grade).toBe('C');
  });

  it('a cold row carries its measured energy and counts toward coverage', () => {
    const [iv] = hostIntervals([], [{ ts: T0, watts: 100, gpuWatts: 0, sampleCount: 60, measuredWh: 20, measuredGpuWh: 0 }]);
    expect(iv.measuredWh).toBe(20);
    expect(integrateBuckets([iv], T0, T0 + ENERGY_BUCKET_MS, () => null).get(T0)!.grade).toBe('B');
  });
});

describe('measured idle: what the engine called quiet (4013)', () => {
  // A saturated week: 95 % of the time at 360 W, 5 % at 100 W. The p10 of
  // the draw is 360; the engine's quiet reports pick the 100 W stretches out.
  const day = T0;
  const intervals: Interval[] = [];
  const quiet: { ts: number; quiet: boolean }[] = [];
  for (let t = day - 7 * DAY; t < day; t += MIN) {
    const isQuiet = (Math.floor((t - (day - 7 * DAY)) / MIN) % 20) === 0;   // one minute in twenty
    intervals.push({ ts: t, hours: 1 / 60, watts: isQuiet ? 100 : 360, gpuWatts: 0 });
    quiet.push({ ts: t, quiet: isQuiet });
  }

  it('reads 100 W where the percentile would have read 360', () => {
    expect(measuredIdleWindow(intervals, quiet, day).watts).toBeCloseTo(100, 6);
    expect(idleWattsForDay(intervals, day)).toBe(360);
  });

  it('is nothing with under six quiet hours, so the caller falls back', () => {
    const thin = quiet.map((q, i) => ({ ...q, quiet: q.quiet && i < 200 }));   // ~10 quiet minutes
    expect(measuredIdleWindow(intervals, thin, day).watts).toBeNull();
  });

  it('a report labels the interval it falls in, never the one a full minute later', () => {
    // Even minutes 100 W with a quiet report, odd minutes 360 W with none.
    // If the report could reach the next interval the answer would be 230.
    const alt: Interval[] = []; const reports: { ts: number; quiet: boolean }[] = [];
    for (let t = day - 7 * DAY, i = 0; t < day; t += MIN, i++) {
      alt.push({ ts: t, hours: 1 / 60, watts: i % 2 === 0 ? 100 : 360, gpuWatts: 0 });
      if (i % 2 === 0) reports.push({ ts: t, quiet: true });
    }
    expect(measuredIdleWindow(alt, reports, day).watts).toBeCloseTo(100, 6);
  });
});

describe('splitActive', () => {
  it('splits by estimated GPU-seconds, so decode outweighs a cache-heavy prompt', () => {
    const decode = selfHostWeight('hermes-3', 0, 1000, 0, 0);
    const cached = selfHostWeight('hermes-3', 0, 0, 1000, 0);
    expect(decode).toBeGreaterThan(cached * 100);
    const shares = splitActive(100, [{ weight: 3, messages: 1 }, { weight: 1, messages: 9 }]);
    expect(shares).toEqual([75, 25]);
  });
  it('falls back to message count, and always sums to what was drawn', () => {
    expect(splitActive(90, [{ weight: 0, messages: 2 }, { weight: 0, messages: 1 }])).toEqual([60, 30]);
    expect(splitActive(10, [])).toEqual([]);
  });
});

describe('resolveMeshHost', () => {
  const mesh = ['ai.foxhop.net', '3090-ai.foxhop.net', 'gpu-node', 'ryu.foxhop.net'];
  it('takes our endpoint map first, then any node by name or fqdn', () => {
    expect(resolveMeshHost('https://ai.foxhop.net/v1', mesh)).toBe('ai.foxhop.net');
    expect(resolveMeshHost('http://gpu-node:8000/v1', mesh)).toBe('gpu-node');
    expect(resolveMeshHost('http://ryu:8000/v1', mesh)).toBe('ryu.foxhop.net');
  });
  it('a loopback endpoint is the node this runs on', () => {
    expect(resolveMeshHost('http://127.0.0.1:8080/v1', mesh, 'gpu-node')).toBe('gpu-node');
    expect(resolveMeshHost('http://localhost:8080/v1', mesh, 'elsewhere')).toBeNull();
  });
  it('an endpoint no node answers to is nobody’s', () => {
    expect(resolveMeshHost('https://openrouter.ai/api/v1', mesh)).toBeNull();
    expect(resolveMeshHost('not a url', mesh)).toBeNull();
    expect(resolveMeshHost(null, mesh)).toBeNull();
  });
});

describe('resolveUsageHost: a message with no endpoint', () => {
  const hosts = ['neoblanka', '4090-ai.lab', '3090-ai.lab', 'cammy.lab'];
  const quant = 'turboderp/Qwen3.8-27B-exl3';

  it('still prefers an endpoint when there is one', () => {
    expect(resolveUsageHost({ endpoint: 'http://cammy.lab:8000/v1', provider: 'qwen', model: quant }, hosts)).toBe('cammy.lab');
  });

  it('takes the provider map from Settings next', () => {
    expect(resolveUsageHost({ endpoint: null, provider: 'qwen', model: quant }, hosts, 'neoblanka', { qwen: '3090-ai.lab' })).toBe('3090-ai.lab');
  });

  it('falls back to the model hardware hint when one host carries that token', () => {
    expect(resolveUsageHost({ endpoint: null, provider: 'local', model: quant }, hosts)).toBe('4090-ai.lab');
    expect(resolveUsageHost({ endpoint: null, provider: 'hermes', model: 'solidrust/Hermes-3-Llama-3.1-8B-AWQ' }, hosts)).toBe('3090-ai.lab');
  });

  it('does not guess between two hosts that carry the token', () => {
    expect(resolveUsageHost({ endpoint: null, provider: 'local', model: quant }, [...hosts, '4090-b.lab'])).toBeNull();
  });

  it('never puts a hosted model or a cloud provider on our GPU', () => {
    // Listed as cloud-served: same family, somebody else's electricity.
    expect(resolveUsageHost({ endpoint: null, provider: 'local', model: 'qwen/qwen3.8-27b' }, hosts)).toBeNull();
    expect(resolveUsageHost({ endpoint: null, provider: 'openrouter', model: quant }, hosts)).toBeNull();
    expect(resolveUsageHost({ endpoint: null, provider: 'local', model: 'claude-opus-5' }, hosts)).toBeNull();
  });
});

// ── Against a database ───────────────────────────────────────────────────────

const NODE = 'gpu-node';
const ENDPOINT = `http://${NODE}:8000/v1`;
/** Busy 13:00–14:00 on the day we price; idle all week before. */
const BUSY_FROM = T0 + 13 * HOUR;
const BUSY_TO = T0 + 14 * HOUR;

function seedSnapshots(db: Database.Database, from: number, to: number, watts: (ts: number) => [number, number], host = NODE, stepMs = MIN) {
  const ins = db.prepare(`INSERT INTO mesh_snapshots (timestamp, hostname, power_watts, gpu_power_watts) VALUES (?, ?, ?, ?)`);
  db.transaction(() => {
    for (let t = from; t < to; t += stepMs) {
      const [cpu, gpu] = watts(t);
      ins.run(sqlTime(t), host, cpu, gpu);
    }
  })();
}

/** cpu 60 W, two GPUs idling at 20 W each, summed: 100 W idle; serving, the GPUs draw 300 W together. */
const drawAt = (ts: number): [number, number] => (ts >= BUSY_FROM && ts < BUSY_TO ? [60, 300] : [60, 40]);

function seedMessages(db: Database.Database) {
  const p1 = db.prepare(`INSERT INTO projects (name, display_name, path) VALUES ('-home-x-git-alpha', 'alpha', '/x/alpha')`).run().lastInsertRowid;
  const p2 = db.prepare(`INSERT INTO projects (name, display_name, path) VALUES ('-home-x-git-beta', 'beta', '/x/beta')`).run().lastInsertRowid;
  const s1 = db.prepare(`INSERT INTO sessions (session_uuid, project_id, harness, created_at) VALUES ('s1', ?, 'uncloseai', datetime('now'))`).run(p1).lastInsertRowid;
  const s2 = db.prepare(`INSERT INTO sessions (session_uuid, project_id, harness, created_at) VALUES ('s2', ?, 'agnt', datetime('now'))`).run(p2).lastInsertRowid;
  const msg = db.prepare(`INSERT INTO messages (session_id, type, timestamp, model, input_tokens, output_tokens, endpoint, provider)
                          VALUES (?, 'assistant', ?, ?, ?, ?, ?, 'local')`);
  // In the first busy quarter hour: alpha generates 3000 tokens, beta 1000.
  msg.run(s1, new Date(BUSY_FROM + 2 * MIN).toISOString(), 'hermes-3-8b', 0, 3000, ENDPOINT);
  msg.run(s2, new Date(BUSY_FROM + 5 * MIN).toISOString(), 'hermes-3-8b', 0, 1000, ENDPOINT);
  // A cloud call in the same window is not ours to attribute to the node.
  msg.run(s1, new Date(BUSY_FROM + 6 * MIN).toISOString(), 'claude-sonnet-4-5', 100, 100, null);
  return { s1: Number(s1), s2: Number(s2) };
}

describe('refreshEnergyAttribution', () => {
  let db: Database.Database;
  const NOW = T0 + 20 * HOUR;
  beforeEach(() => {
    db = createTestDb();
    seedSnapshots(db, T0 - 7 * DAY, NOW, drawAt);
  });

  const nodeRow = (bucket: number) =>
    db.prepare('SELECT * FROM node_energy_15m WHERE hostname = ? AND bucket = ?').get(NODE, sqlTime(bucket)) as Record<string, number>;

  it('splits a node’s draw into standing and active, and active across the sessions that used it', () => {
    seedMessages(db);
    const r = refreshEnergyAttribution(db, { now: NOW, budgetMs: Infinity, chunkDays: 3 });
    expect(r.through).toBe(sqlTime(NOW));

    // A quiet quarter hour: 100 W for 0.25 h, all of it standing.
    const quiet = nodeRow(T0 + 3 * HOUR);
    expect(quiet.idle_watts).toBe(100);
    expect(quiet.total_wh).toBeCloseTo(25, 6);
    expect(quiet.idle_wh).toBeCloseTo(25, 6);
    expect(quiet.active_wh).toBeCloseTo(0, 6);

    // The first busy quarter hour: 360 W, 100 W of it standing.
    const busy = nodeRow(BUSY_FROM);
    expect(busy.total_wh).toBeCloseTo(90, 6);
    expect(busy.gpu_wh).toBeCloseTo(75, 6);
    expect(busy.idle_wh).toBeCloseTo(25, 6);
    expect(busy.active_wh).toBeCloseTo(65, 6);
    expect(busy.attributed_wh).toBeCloseTo(65, 6);

    // Same model, same hardware profile: three quarters by GPU-seconds to alpha.
    const groups = db.prepare(`SELECT harness, active_wh, measured FROM energy_attribution_15m ORDER BY harness`).all() as { harness: string; active_wh: number; measured: number }[];
    expect(groups.map((g) => g.harness)).toEqual(['agnt', 'uncloseai']);
    expect(groups[1].active_wh).toBeCloseTo(65 * 0.75, 6);
    expect(groups[0].active_wh).toBeCloseTo(65 * 0.25, 6);
    expect(groups.every((g) => g.measured === 1)).toBe(true);

    // The rest of the busy hour had no message of ours: active, unattributed.
    const later = nodeRow(BUSY_FROM + 30 * MIN);
    expect(later.active_wh).toBeCloseTo(65, 6);
    expect(later.attributed_wh).toBe(0);
  });

  it('attributes a message that recorded no endpoint, through the provider map or the hardware hint', () => {
    // fox's box: 167,008 messages in 30 days, none with an endpoint.
    const GPU = '4090-ai.lab';
    seedSnapshots(db, T0 - 7 * DAY, NOW, drawAt, GPU);
    const p = db.prepare(`INSERT INTO projects (name, display_name, path) VALUES ('-home-x-git-gamma', 'gamma', '/x/gamma')`).run().lastInsertRowid;
    const sid = db.prepare(`INSERT INTO sessions (session_uuid, project_id, harness, created_at) VALUES ('s3', ?, 'uncloseai', datetime('now'))`).run(p).lastInsertRowid;
    db.prepare(`INSERT INTO messages (session_id, type, timestamp, model, input_tokens, output_tokens, endpoint, provider)
                VALUES (?, 'assistant', ?, 'turboderp/Qwen3.8-27B-exl3', 500, 2000, NULL, 'qwen')`)
      .run(sid, new Date(BUSY_FROM + 3 * MIN).toISOString());

    refreshEnergyAttribution(db, { now: NOW, budgetMs: Infinity, chunkDays: 3 });
    const rows = db.prepare('SELECT hostname, harness, active_wh FROM energy_attribution_15m WHERE hostname = ?').all(GPU) as { hostname: string; harness: string; active_wh: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].harness).toBe('uncloseai');
    expect(rows[0].active_wh).toBeCloseTo(65, 6);
    expect(db.prepare('SELECT value FROM settings WHERE key = ?').get(ENERGY_KEYS.rules)).toEqual({ value: String(ENERGY_RULES_VERSION) });
  });

  it('recomputes history when the rules version moves', () => {
    seedMessages(db);
    // Rows built by rules 1 would have left our busy hour unattributed; the
    // cursor says it is all done.
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(ENERGY_KEYS.through, sqlTime(NOW));
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(ENERGY_KEYS.rules, '1');
    refreshEnergyAttribution(db, { now: NOW, budgetMs: Infinity, chunkDays: 3 });
    expect(nodeRow(BUSY_FROM).attributed_wh).toBeCloseTo(65, 6);
  });

  it('writes grade B rows with measured watt-hours when the samples carry counters', () => {
    const RANGE = 262_143_328_850;
    const ins = db.prepare(`INSERT INTO mesh_snapshots (timestamp, hostname, power_watts, gpu_power_watts, cpu_energy_json, gpu_energy_mj) VALUES (?, 'counted', 90, 280, ?, ?)`);
    db.transaction(() => {
      let i = 0;
      for (let t = T0 - 7 * DAY; t < NOW; t += MIN, i++) {
        ins.run(sqlTime(t), JSON.stringify([{ uj: (1e9 + i * 4.8e9) % RANGE, max: RANGE }]), 1e9 + i * 18e6);
      }
    })();
    refreshEnergyAttribution(db, { now: NOW, budgetMs: Infinity, chunkDays: 3 });
    const row = db.prepare('SELECT * FROM node_energy_15m WHERE hostname = ? AND bucket = ?').get('counted', sqlTime(T0 + 3 * HOUR)) as Record<string, number | string>;
    expect(row.grade).toBe('B');
    // 80 W CPU + 300 W GPU for a quarter hour, from counters: 95 Wh.
    expect(row.measured_wh as number).toBeCloseTo(95, 6);
    expect(row.measured_gpu_wh as number).toBeCloseTo(75, 6);
    // The estimate column is what it always was: 370 W for a quarter hour.
    expect(row.total_wh as number).toBeCloseTo(92.5, 6);
  });

  it('takes idle from the engine\u2019s quiet reports when it has them, and says so', () => {
    seedMessages(db);
    // vLLM on the node reports an empty queue except during the busy hour.
    const ins = db.prepare(`INSERT INTO vllm_cache_samples (timestamp, hostname, model, queries, hits, running, waiting) VALUES (?, ?, 'hermes-3-8b', 1, 0, ?, 0)`);
    db.transaction(() => { for (let t = T0 - 7 * DAY; t < NOW; t += MIN) ins.run(sqlTime(t), NODE, t >= BUSY_FROM && t < BUSY_TO ? 2 : 0); })();
    refreshEnergyAttribution(db, { now: NOW, budgetMs: Infinity, chunkDays: 3 });
    const row = nodeRow(BUSY_FROM) as Record<string, number | string>;
    expect(row.idle_source).toBe('measured');
    expect(row.idle_watts).toBeCloseTo(100, 6);
  });

  it('reads back priced at each node’s own rate, by node, model, project and harness', () => {
    seedMessages(db);
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(nodeEconKey(NODE), JSON.stringify({ electricityCostKwh: 0.5 }));
    refreshEnergyAttribution(db, { now: NOW, budgetMs: Infinity });
    const e = readEnergyAttribution(db, { from: T0, to: T0 + DAY });
    expect(e.hosts).toHaveLength(1);
    const h = e.hosts[0];
    expect(h.rateKwh).toBe(0.5);
    expect(h.idleWatts).toBe(100);
    expect(h.standingMonthlyUSD).toBeCloseTo(0.1 * 730 * 0.5, 6);
    expect(h.standingKwh + h.activeKwh).toBeCloseTo(h.totalKwh, 9);
    expect(h.attributedKwh + h.unattributedKwh).toBeCloseTo(h.activeKwh, 9);
    expect(h.activeKwh).toBeCloseTo(0.26, 6);      // 260 W above idle for the hour
    expect(h.attributedKwh).toBeCloseTo(0.065, 6);
    expect(h.attributedUSD).toBeCloseTo(0.0325, 6);
    expect(e.byProject.map((p) => p.key)).toEqual(['alpha', 'beta']);
    expect(e.byProject[0].usd).toBeCloseTo(0.0325 * 0.75, 6);
    expect(e.byHarness.map((p) => p.key)).toEqual(['uncloseai', 'agnt']);
    expect(e.byModel).toHaveLength(1);
    expect(e.byModel[0]).toMatchObject({ key: 'hermes-3-8b', tokens: 4000, measuredTokens: 4000, hosts: [NODE] });
    expect(e.computedAt).toBe(new Date(NOW).toISOString());
    // One node asked for, one node answered.
    expect(readEnergyAttribution(db, { from: T0, to: T0 + DAY, hostname: 'other' }).hosts).toEqual([]);
  });

  it('rebuilds a bucket a late-ingested message falls in', () => {
    const { s1 } = seedMessages(db);
    refreshEnergyAttribution(db, { now: NOW, budgetMs: Infinity });
    expect(nodeRow(BUSY_FROM + 30 * MIN).attributed_wh).toBe(0);
    // A session file read hours later: its message lands in a bucket already built.
    db.prepare(`INSERT INTO messages (session_id, type, timestamp, model, output_tokens, endpoint) VALUES (?, 'assistant', ?, 'hermes-3-8b', 500, ?)`)
      .run(s1, new Date(BUSY_FROM + 31 * MIN).toISOString(), ENDPOINT);
    refreshEnergyAttribution(db, { now: NOW + 5 * MIN, budgetMs: Infinity });
    expect(nodeRow(BUSY_FROM + 30 * MIN).attributed_wh).toBeCloseTo(65, 6);
    expect(db.prepare(`SELECT value FROM settings WHERE key = ?`).get(ENERGY_KEYS.watermark)).toEqual({ value: '4' });
  });

  it('keeps tokens a node served while unsampled, unmeasured, so a reader falls back to the estimate', () => {
    const { s1 } = seedMessages(db);
    db.prepare(`INSERT INTO messages (session_id, type, timestamp, model, output_tokens, endpoint) VALUES (?, 'assistant', ?, 'hermes-3-8b', 700, ?)`)
      .run(s1, new Date(NOW + 2 * HOUR).toISOString(), ENDPOINT);
    refreshEnergyAttribution(db, { now: NOW + 3 * HOUR, budgetMs: Infinity });
    const e = readEnergyAttribution(db, { from: T0, to: NOW + 3 * HOUR });
    expect(e.byModel[0]).toMatchObject({ tokens: 4700, measuredTokens: 4000 });
  });

  it('the bucket still filling is redone next tick; finished ones are not', () => {
    seedMessages(db);
    refreshEnergyAttribution(db, { now: NOW, budgetMs: Infinity });
    // Samples land in the bucket that was filling.
    seedSnapshots(db, NOW, NOW + 10 * MIN, () => [60, 40]);
    const r = refreshEnergyAttribution(db, { now: NOW + 10 * MIN, budgetMs: Infinity });
    expect(r.chunks).toBe(1);
    // Ten samples a minute apart: nine measured minutes, the newest awaits its successor.
    expect(nodeRow(NOW).sampled_hours).toBeCloseTo(9 / 60, 6);
  });

  it('a tick that knows the day’s idle reads only the quarter hour it rebuilds', () => {
    const cache: IdleCache = new Map();
    buildEnergyChunk(db, BUSY_FROM, BUSY_FROM + ENERGY_BUCKET_MS, { now: NOW, idleCache: cache });
    expect(cache.get(`${NODE}\0${T0}`)).toEqual({ watts: 100, source: 'p10' });
    // Delete the week before: with the idle cached the bucket still prices the same.
    db.prepare('DELETE FROM mesh_snapshots WHERE timestamp < ?').run(sqlTime(T0));
    buildEnergyChunk(db, BUSY_FROM, BUSY_FROM + ENERGY_BUCKET_MS, { now: NOW, idleCache: cache });
    expect(nodeRow(BUSY_FROM).idle_watts).toBe(100);
    expect(nodeRow(BUSY_FROM).active_wh).toBeCloseTo(65, 6);
  });

  it('nothing sampled and nothing sent is a quiet no-op', () => {
    const empty = createTestDb();
    const r = refreshEnergyAttribution(empty, { now: NOW });
    expect(r).toEqual({ chunks: 0, buckets: 0, through: null });
    expect(readEnergyAttribution(empty, { from: T0, to: NOW }).hosts).toEqual([]);
  });
});
