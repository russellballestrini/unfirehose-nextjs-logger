import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unfirehose/core/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GET /api/mesh/history?hours=24&hostname=all
 * Returns time-series data for mesh node metrics (watts, load, ISP cost).
 *
 * POST /api/mesh/history
 * Records a snapshot of current mesh state (called by the mesh polling interval).
 */

export async function GET(req: NextRequest) {
  const hours = parseInt(req.nextUrl.searchParams.get('hours') ?? '24');
  const hostname = req.nextUrl.searchParams.get('hostname') ?? 'all';
  const db = getDb();

  // SQLite datetime('now') uses 'YYYY-MM-DD HH:MM:SS' format (no T, no Z)
  const sinceDate = new Date(Date.now() - hours * 3600_000);
  const since = sinceDate.toISOString().replace('T', ' ').slice(0, 19);

  let rows: any[];
  if (hostname === 'all') {
    rows = db.prepare(`
      SELECT timestamp, hostname, cpu_cores, load_avg_1, load_avg_5, load_avg_15,
             mem_total_gb, mem_used_gb, power_watts, gpu_power_watts, power_source, claude_processes
      FROM mesh_snapshots
      WHERE timestamp > ?
      ORDER BY timestamp ASC
    `).all(since);
  } else {
    rows = db.prepare(`
      SELECT timestamp, hostname, cpu_cores, load_avg_1, load_avg_5, load_avg_15,
             mem_total_gb, mem_used_gb, power_watts, gpu_power_watts, power_source, claude_processes
      FROM mesh_snapshots
      WHERE timestamp > ? AND hostname = ?
      ORDER BY timestamp ASC
    `).all(since, hostname);
  }

  // Group by timestamp for aggregate charts
  const byTime = new Map<string, any>();
  for (const r of rows) {
    // Round to nearest minute for aggregation
    const minute = r.timestamp.slice(0, 16);
    if (!byTime.has(minute)) {
      byTime.set(minute, {
        timestamp: minute,
        totalWatts: 0,
        totalGpuWatts: 0,
        totalLoad: 0,
        totalCores: 0,
        totalMemUsed: 0,
        totalMemTotal: 0,
        totalClaudes: 0,
        nodeCount: 0,
        nodes: {} as Record<string, any>,
      });
    }
    const entry = byTime.get(minute)!;
    entry.totalWatts += r.power_watts ?? 0;
    entry.totalGpuWatts += r.gpu_power_watts ?? 0;
    entry.totalLoad += r.load_avg_1 ?? 0;
    entry.totalCores += r.cpu_cores ?? 0;
    entry.totalMemUsed += r.mem_used_gb ?? 0;
    entry.totalMemTotal += r.mem_total_gb ?? 0;
    entry.totalClaudes += r.claude_processes ?? 0;
    entry.nodeCount += 1;
    entry.nodes[r.hostname] = {
      watts: (r.power_watts ?? 0) + (r.gpu_power_watts ?? 0),
      load: r.load_avg_1 ?? 0,
      cores: r.cpu_cores ?? 0,
      memUsed: r.mem_used_gb ?? 0,
      claudes: r.claude_processes ?? 0,
    };
  }

  const timeline = [...byTime.values()].map(e => ({
    timestamp: e.timestamp,
    totalWatts: Math.round((e.totalWatts + e.totalGpuWatts) * 10) / 10,
    cpuWatts: Math.round(e.totalWatts * 10) / 10,
    gpuWatts: Math.round(e.totalGpuWatts * 10) / 10,
    avgLoad: e.nodeCount > 0 ? Math.round((e.totalLoad / e.totalCores) * 100) / 100 : 0,
    totalLoad: Math.round(e.totalLoad * 10) / 10,
    totalCores: e.totalCores,
    memUsedGB: Math.round(e.totalMemUsed * 10) / 10,
    memTotalGB: Math.round(e.totalMemTotal * 10) / 10,
    claudes: e.totalClaudes,
    nodeCount: e.nodeCount,
    nodes: e.nodes,
  }));

  // Distinct hostnames
  const hostnames = [...new Set(rows.map(r => r.hostname))];

  return NextResponse.json({ timeline, hostnames, hours, count: rows.length });
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
      mem_total_gb, mem_used_gb, power_watts, gpu_power_watts, power_source, claude_processes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        n.powerSource ?? 'estimate',
        n.claudeProcesses ?? 0,
      );
    }
  });
  tx();

  // Prune snapshots older than 30 days
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('DELETE FROM mesh_snapshots WHERE timestamp < ?').run(cutoff);

  return NextResponse.json({ ok: true, recorded: nodes.filter((n: any) => n.reachable).length });
}
