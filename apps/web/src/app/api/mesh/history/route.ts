import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { Timing } from '@/lib/timing';
import { rollupTimeline, decimatePeaks, distinctHostnames } from '@/lib/mesh-history';

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
       gpu_mem_used_mb, gpu_mem_total_mb, power_source, claude_processes,
       agent_processes, harness_counts`;

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
  const timeline = rollupTimeline(rows, 15);

  // Both fleet pages read the per-node breakdown, so it stays unless a caller
  // says it does not need it. Downsampling alone takes 24h from 7.97 MB to
  // 892 KB; asking for one hostname takes it further.
  const wantNodes = req.nextUrl.searchParams.get('nodes') !== '0';
  const points = Math.max(50, Math.min(5000,
    parseInt(req.nextUrl.searchParams.get('points') ?? '600', 10) || 600));

  let series = decimatePeaks(timeline, points);
  if (!wantNodes) {
    series = series.map(({ nodes: _nodes, ...rest }) => rest);
  }

  const hostnames = distinctHostnames(rows);
  t.mark('aggregate');

  return NextResponse.json(
    { timeline: series, hostnames, hours, count: rows.length, sampled: series.length, of: timeline.length },
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
      mem_total_gb, mem_used_gb, power_watts, gpu_power_watts, gpu_util, gpu_mem_used_mb, gpu_mem_total_mb, power_source, claude_processes,
      agent_processes, harness_counts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        // Total across harnesses, and the breakdown. A node with five
        // uncloseai-cli agents and no claude used to persist a zero here.
        (() => {
          const c = n.harnessCounts as Record<string, number> | undefined;
          const total = c ? Object.values(c).reduce((a, b) => a + b, 0) : 0;
          return total || (n.claudeProcesses ?? 0);
        })(),
        n.harnessCounts ? JSON.stringify(n.harnessCounts) : null,
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
