'use client';

import { MiniStat } from '@unturf/unfirehose-ui/KV';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================================
// Mesh Summary Bar
// ============================================================

export function MeshSummaryBar({ summary, geoipLoading, geoipCount }: { summary: any; geoipLoading?: boolean; geoipCount?: number }) {
  const memPct = summary.totalMemGB > 0 ? Math.round((summary.totalMemUsedGB / summary.totalMemGB) * 100) : 0;
  const allGreen = summary.reachableNodes === summary.totalNodes;

  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
      <div className="flex items-center gap-6 flex-wrap">
        <div className="flex items-center gap-2">
          <span className={`text-lg ${allGreen ? 'text-green-400' : 'text-yellow-400'}`}>
            {allGreen ? '●' : '◐'}
          </span>
          <span className="text-base font-bold">
            {summary.reachableNodes}/{summary.totalNodes} nodes
          </span>
        </div>
        <MiniStat label="agents" value={summary.totalAgents ?? summary.totalClaudes} accent />
        <MiniStat label="cores" value={summary.totalCores} />
        <div className="flex items-center gap-2">
          <span className="text-base text-[var(--color-muted)]">mem</span>
          <div className="w-24 h-2 bg-[var(--color-background)] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${memPct}%`,
                backgroundColor: memPct > 85 ? '#ef4444' : memPct > 60 ? '#eab308' : 'var(--color-accent)',
              }}
            />
          </div>
          <span className="text-base font-mono">{summary.totalMemUsedGB}/{summary.totalMemGB}G</span>
        </div>
        <span className={`text-base font-bold ${allGreen ? 'text-green-400' : 'text-yellow-400'}`}>
          {allGreen ? 'all green' : 'degraded'}
        </span>
        {geoipLoading && <span className="text-xs text-[var(--color-muted)] animate-pulse">geoip...</span>}
        {!geoipLoading && geoipCount !== undefined && geoipCount > 0 && (
          <span className="text-xs text-[var(--color-muted)]">{geoipCount} geolocated</span>
        )}
      </div>
    </div>
  );
}
