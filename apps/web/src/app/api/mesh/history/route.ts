import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { Timing } from '@/lib/timing';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GET /api/mesh/history?hours=24&hostname=all
 * Returns time-series data for mesh node metrics (watts, load, ISP cost).
 *
 * POST /api/mesh/history
 * Records a snapshot of current mesh state (called by the mesh polling interval).
 */

export async function GET(req: NextRequest) {
  const t = new Timing();
  const hours = parseInt(req.nextUrl.searchParams.get('hours') ?? '24');
  const hostname = req.nextUrl.searchParams.get('hostname') ?? 'all';
  const db = getDb();
  t.mark('db_open');

  // SQLite datetime('now') uses 'YYYY-MM-DD HH:MM:SS' format (no T, no Z)
  const sinceDate = new Date(Date.now() - hours * 3600_000);
  const since = sinceDate.toISOString().replace('T', ' ').slice(0, 19);

  // Tier dispatch: hot (mesh_snapshots, 15s × 28d) handles recent requests;
  // requests reaching past the 28-day boundary UNION the cold tier
  // (mesh_snapshots_15m, smoothed) so the chart stays continuous. Column
  // shape is the same so downstream aggregation is tier-agnostic.
  const HOT_RETENTION_DAYS = 28;
  const hotBoundary = new Date(Date.now() - HOT_RETENTION_DAYS * 86400_000)
    .toISOString().replace('T', ' ').slice(0, 19);
  const needsCold = since < hotBoundary;
  const SELECT_COLS = `timestamp, hostname, cpu_cores, load_avg_1, load_avg_5, load_avg_15,
       mem_total_gb, mem_used_gb, power_watts, gpu_power_watts, gpu_util,
       gpu_mem_used_mb, gpu_mem_total_mb, power_source, claude_processes`;

  let rows: any[];
  if (!needsCold) {
    const sql = `
      SELECT ${SELECT_COLS} FROM mesh_snapshots
      WHERE timestamp > ?${hostname === 'all' ? '' : ' AND hostname = ?'}
      ORDER BY timestamp ASC
    `;
    rows = hostname === 'all'
      ? db.prepare(sql).all(since)
      : db.prepare(sql).all(since, hostname);
  } else {
    // Cold tier covers everything from `since` up to the 28-day boundary;
    // hot tier covers boundary → now. The UNION ALL keeps order via a final
    // ORDER BY so timeline aggregation sees a single monotonic stream.
    const sql = `
      SELECT ${SELECT_COLS} FROM mesh_snapshots_15m
      WHERE timestamp > ? AND timestamp <= ?${hostname === 'all' ? '' : ' AND hostname = ?'}
      UNION ALL
      SELECT ${SELECT_COLS} FROM mesh_snapshots
      WHERE timestamp > ?${hostname === 'all' ? '' : ' AND hostname = ?'}
      ORDER BY timestamp ASC
    `;
    rows = hostname === 'all'
      ? db.prepare(sql).all(since, hotBoundary, hotBoundary)
      : db.prepare(sql).all(since, hotBoundary, hostname, hotBoundary, hostname);
  }
  t.mark(needsCold ? 'query_tiered' : 'query');

  // Match storage granularity exactly — 15s buckets serve two purposes:
  //   1. Hot-tier rows are already at 15s (the worker probe cadence), so
  //      this is a no-op compression: every row keeps its own bucket.
  //   2. Cold-tier rows arrive at 15-minute boundaries and naturally
  //      land in unique 15s buckets — also passed through unchanged.
  //   3. Multiple POSTs from concurrent dashboard tabs within the same
  //      15s window dedupe to the latest snapshot (the original reason
  //      bucketing exists at all).
  // No further downsampling — uPlot canvas renders 100k+ points cheaply.
  const bucketSec = 15;
  const truncateToBucket = (ts: string): string => {
    // ts is 'YYYY-MM-DD HH:MM:SS' — parse, round down to bucketSec, re-format.
    const isoMs = Date.parse(ts.replace(' ', 'T') + 'Z');
    if (!isoMs) return ts.slice(0, 16);
    const bucketMs = Math.floor(isoMs / (bucketSec * 1000)) * bucketSec * 1000;
    return new Date(bucketMs).toISOString().replace('T', ' ').slice(0, 19);
  };

  // Group by bucket, deduping per hostname (last snapshot wins). The dashboard
  // POSTs snapshots every ~6-15s from multiple pages, so a node can appear several
  // times per bucket — summing every row would multiply the fleet totals. We keep
  // only the latest row per (bucket, hostname), then derive aggregates from that.
  const byTime = new Map<string, Map<string, any>>();
  for (const r of rows) {
    const minute = truncateToBucket(r.timestamp);
    let nodes = byTime.get(minute);
    if (!nodes) { nodes = new Map(); byTime.set(minute, nodes); }
    // rows are ordered ASC, so this leaves the most recent per hostname
    nodes.set(r.hostname, {
      cpuWatts: r.power_watts ?? 0,
      gpuWatts: r.gpu_power_watts ?? 0,
      watts: (r.power_watts ?? 0) + (r.gpu_power_watts ?? 0),
      load: r.load_avg_1 ?? 0,
      cores: r.cpu_cores ?? 0,
      memUsed: r.mem_used_gb ?? 0,
      memTotal: r.mem_total_gb ?? 0,
      claudes: r.claude_processes ?? 0,
      gpuUtil: r.gpu_util ?? undefined,
      gpuMemUsedMB: r.gpu_mem_used_mb ?? 0,
      gpuMemTotalMB: r.gpu_mem_total_mb ?? 0,
    });
  }

  const round1 = (n: number) => Math.round(n * 10) / 10;
  const timeline = [...byTime.entries()].map(([minute, nodes]) => {
    const list = [...nodes.values()];
    const cpuWatts = list.reduce((s, n) => s + n.cpuWatts, 0);
    const gpuWatts = list.reduce((s, n) => s + n.gpuWatts, 0);
    const totalLoad = list.reduce((s, n) => s + n.load, 0);
    const totalCores = list.reduce((s, n) => s + n.cores, 0);
    const memUsed = list.reduce((s, n) => s + n.memUsed, 0);
    const memTotal = list.reduce((s, n) => s + n.memTotal, 0);
    const claudes = list.reduce((s, n) => s + n.claudes, 0);
    const gpuNodes = list.filter(n => n.gpuUtil != null || n.gpuMemTotalMB > 0);
    const gpuUtilSum = gpuNodes.reduce((s, n) => s + (n.gpuUtil ?? 0), 0);
    const gpuMemUsed = gpuNodes.reduce((s, n) => s + n.gpuMemUsedMB, 0);
    const gpuMemTotal = gpuNodes.reduce((s, n) => s + n.gpuMemTotalMB, 0);
    return {
      timestamp: minute,
      totalWatts: round1(cpuWatts + gpuWatts),
      cpuWatts: round1(cpuWatts),
      gpuWatts: round1(gpuWatts),
      avgLoad: totalCores > 0 ? Math.round((totalLoad / totalCores) * 100) / 100 : 0,
      totalLoad: round1(totalLoad),
      totalCores,
      memUsedGB: round1(memUsed),
      memTotalGB: round1(memTotal),
      gpuUtil: gpuNodes.length > 0 ? round1(gpuUtilSum / gpuNodes.length) : 0,
      gpuMemUsedGB: round1(gpuMemUsed / 1024),
      gpuMemTotalGB: round1(gpuMemTotal / 1024),
      claudes,
      nodeCount: list.length,
      nodes: Object.fromEntries(nodes),
    };
  });

  // Distinct hostnames — deduplicate short names that have FQDN variants
  const rawHostnames = [...new Set(rows.map(r => r.hostname))];
  const hostnames = rawHostnames.filter(h =>
    !rawHostnames.some(other => other !== h && other.startsWith(h + '.'))
  );
  t.mark('aggregate');

  return NextResponse.json(
    { timeline, hostnames, hours, count: rows.length },
    { headers: { 'Server-Timing': t.header() } },
  );
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const nodes: any[] = body.nodes ?? [];
  const db = getDb();

  if (nodes.length === 0) {
    return NextResponse.json({ error: 'No nodes provided' }, { status: 400 });
  }

  const insert = db.prepare(`
    INSERT INTO mesh_snapshots (hostname, cpu_cores, load_avg_1, load_avg_5, load_avg_15,
      mem_total_gb, mem_used_gb, power_watts, gpu_power_watts, gpu_util, gpu_mem_used_mb, gpu_mem_total_mb, power_source, claude_processes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const n of nodes) {
      if (!n.reachable) continue;
      insert.run(
        n.hostname,
        n.cpuCores ?? 0,
        n.loadAvg?.[0] ?? 0,
        n.loadAvg?.[1] ?? 0,
        n.loadAvg?.[2] ?? 0,
        n.memTotalGB ?? 0,
        n.memUsedGB ?? 0,
        n.powerWatts ?? 0,
        n.gpuPowerWatts ?? 0,
        n.gpuUtil ?? null,
        n.gpuMemUsedMB ?? null,
        n.gpuMemTotalMB ?? null,
        n.powerSource ?? 'estimate',
        n.claudeProcesses ?? 0,
      );
    }
  });
  tx();

  // No prune here — the worker's rollup tick folds 15s rows past the
  // 28-day boundary into mesh_snapshots_15m and deletes the source rows
  // in the same transaction (snake-eats-tail). This route stays pure
  // append-only.
  return NextResponse.json({ ok: true, recorded: nodes.filter((n: any) => n.reachable).length });
}
