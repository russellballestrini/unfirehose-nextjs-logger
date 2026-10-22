'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { PROVIDERS, getEffectiveIspCost, nodeElecMonthly } from '@/lib/mesh-score';
import { useMeshScore, type MeshScoreInputs } from './useMeshScore';

// ============================================================
// Mesh Economics Panel
// ============================================================

export function MeshEconomicsPanel(inputs: MeshScoreInputs) {
  const { allNodes } = inputs;
  const { econNodes, score } = useMeshScore(inputs);
  const configuredCount = econNodes.filter(n => n.econ.location).length;

  // Aggregate by provider — all-in, the same ISP-plus-electricity sum the
  // headline uses, so the bars add up to Monthly Cost. This was ISP-only while
  // the percentages divided by the all-in total, so a fleet of home boxes
  // showed Home ISP at 60% with nothing accounting for the other 40%.
  const byProvider = useMemo(() => {
    const map = new Map<string, { count: number; cost: number; isp: number; elec: number }>();
    for (const n of econNodes) {
      const p = n.econ.provider;
      const cur = map.get(p) ?? { count: 0, cost: 0, isp: 0, elec: 0 };
      const isp = getEffectiveIspCost(n.hostname, n.econ.ispCostMonthly, score.egressGroups);
      const elec = nodeElecMonthly(n.econ, n.meshNode);
      map.set(p, { count: cur.count + 1, cost: cur.cost + isp + elec, isp: cur.isp + isp, elec: cur.elec + elec });
    }
    return [...map.entries()].sort((a, b) => b[1].cost - a[1].cost);
  }, [econNodes, score.egressGroups]);

  // Aggregate by location
  const byLocation = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of econNodes) {
      const loc = n.econ.location || 'unconfigured';
      map.set(loc, (map.get(loc) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [econNodes]);

  if (allNodes.length === 0) return null;

  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-bold text-[var(--color-muted)]">Mesh Economics</h3>
        {configuredCount < allNodes.length && (
          <span className="text-xs text-yellow-400">
            {allNodes.length - configuredCount} node{allNodes.length - configuredCount !== 1 ? 's' : ''} unconfigured — click a node → Economics tab
          </span>
        )}
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-9 gap-4">
        <div>
          <div className="text-xs text-[var(--color-muted)]">Monthly Cost</div>
          <div className="text-base font-bold font-mono">${Math.round(score.totalMonthlyCost)}/mo</div>
          <div className="text-[10px] text-[var(--color-muted)] font-mono">
            ${Math.round(score.totalElecCost)} elec + ${Math.round(score.totalIspCost)} isp
          </div>
        </div>
        <div>
          <div className="text-xs text-[var(--color-muted)]">Cost/Node</div>
          <div className="text-base font-bold font-mono">
            ${allNodes.length > 0 ? Math.round(score.totalMonthlyCost / allNodes.length) : 0}/mo
          </div>
        </div>
        <div>
          <div className="text-xs text-[var(--color-muted)]">Power</div>
          <div className="text-base font-bold font-mono">{Math.round(score.totalWatts)}W</div>
          {score.totalGpuWatts > 0 && (
            <div className="text-[10px] text-[var(--color-muted)] font-mono">{Math.round(score.totalGpuWatts)}W gpu</div>
          )}
        </div>
        <div>
          <div className="text-xs text-[var(--color-muted)]">$/W·mo</div>
          <div className="text-base font-bold font-mono">
            {score.totalWatts > 0 ? `$${(score.totalMonthlyCost / score.totalWatts).toFixed(2)}` : 'n/a'}
          </div>
        </div>
        <div>
          <div className="text-xs text-[var(--color-muted)]">Avg Distance</div>
          <div className="text-base font-bold font-mono">
            {score.avgDistance > 0 ? `${score.avgDistance.toLocaleString()} km` : 'n/a'}
          </div>
        </div>
        <div>
          <div className="text-xs text-[var(--color-muted)]">Geo Diversity</div>
          <div className={`text-base font-bold ${score.geoDiversityBonus > 0 ? 'text-green-400' : ''}`}>
            +{score.geoDiversityBonus}
          </div>
        </div>
        <div>
          <div className="text-xs text-[var(--color-muted)]">Pipe Diversity</div>
          <div className={`text-base font-bold ${score.pipeDiversityBonus > 0 ? 'text-green-400' : score.sameLocationPenalty > 0 ? 'text-yellow-400' : ''}`}>
            {score.pipeDiversityBonus > 0 ? `+${score.pipeDiversityBonus}` : '0'}
            {score.sameLocationPenalty > 0 && <span className="text-red-400 text-sm ml-1">-{score.sameLocationPenalty}</span>}
          </div>
        </div>
        <div>
          <div className="text-xs text-[var(--color-muted)]">Shared Pipes</div>
          <div className="text-base font-bold font-mono">
            {[...score.egressGroups.values()].filter(g => g.length > 1).length > 0
              ? [...score.egressGroups.entries()].filter(([, g]) => g.length > 1).map(([ip, g]) => (
                  <span key={ip} className="text-xs text-yellow-400">{g.length}x split</span>
                ))
              : <span className="text-[var(--color-muted)]">none</span>
            }
          </div>
        </div>
        <div>
          <div className="text-xs text-[var(--color-muted)]">Mesh Score</div>
          <div className="text-base font-bold text-[var(--color-accent)]">{score.totalScore}</div>
        </div>
      </div>

      {/* Provider + Location breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* By provider */}
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-3">
          <div className="text-xs text-[var(--color-muted)] mb-2">By Provider</div>
          <div className="space-y-1.5">
            {byProvider.map(([prov, { count, cost, isp, elec }]) => {
              const label = PROVIDERS.find(p => p.value === prov)?.label ?? prov;
              const pct = score.totalMonthlyCost > 0 ? Math.round((cost / score.totalMonthlyCost) * 100) : 0;
              return (
                <div key={prov} className="flex items-center gap-2"
                     title={`$${Math.round(elec)} elec + $${Math.round(isp)} isp`}>
                  <span className="text-xs w-28 truncate">{label}</span>
                  <div className="flex-1 h-1.5 bg-[var(--color-surface)] rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs font-mono w-16 text-right">${Math.round(cost)}/mo</span>
                  <span className="text-xs text-[var(--color-muted)] w-6">{count}x</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* By location */}
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-3">
          <div className="text-xs text-[var(--color-muted)] mb-2">By Location</div>
          <div className="space-y-1.5">
            {byLocation.map(([loc, count]) => (
              <div key={loc} className="flex items-center gap-2">
                <span className={`text-xs flex-1 truncate ${loc === 'unconfigured' ? 'text-[var(--color-muted)] italic' : ''}`}>{loc}</span>
                <span className="text-xs font-mono">{count} node{count !== 1 ? 's' : ''}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Node scores */}
      {score.nodeScores.length > 0 && (
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-3">
          <div className="text-xs text-[var(--color-muted)] mb-2">
            Permacomputer Node Scores (PNS) — hexagonal harmonics on the 7-lattice.{' '}
            <Link href="/docs/architecture/node-score" className="underline opacity-60 hover:opacity-100">formula</Link>
          </div>
          <div className="space-y-1">
            {/* Scores live on the 7-lattice, so ties are the norm; the name
                breaks them, and the copy keeps the sort out of shared state. */}
            {[...score.nodeScores].sort((a, b) => b.score - a.score || a.hostname.localeCompare(b.hostname)).map(ns => {
              const maxScore = Math.max(...score.nodeScores.map(s => s.score), 1);
              const tier = ns.score >= 189 ? 'Anchor'
                         : ns.score >= 126 ? 'Contributor'
                         : ns.score >= 63  ? 'Supporter'
                         :                    'Hobbyist';
              const tierColor = ns.score >= 189 ? 'text-[var(--color-accent)]'
                              : ns.score >= 126 ? 'text-green-400'
                              : ns.score >= 63  ? 'text-yellow-400'
                              :                    'text-[var(--color-muted)]';
              const c = ns.components;
              return (
                <div key={ns.hostname} className="flex items-center gap-2">
                  <span className="text-xs font-mono w-32 truncate">{ns.hostname}</span>
                  <div className="flex-1 h-1.5 bg-[var(--color-surface)] rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${(ns.score / maxScore) * 100}%` }} />
                  </div>
                  <span className="text-xs font-mono w-10 text-right">{ns.score}</span>
                  <span className={`text-xs font-mono w-20 ${tierColor}`}>{tier}</span>
                  {ns.donation && (
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--color-muted)]/10 text-[var(--color-muted)]" title="3rd+ node at same location — donated compute, no payout per doctrine">
                      donated
                    </span>
                  )}
                  <span
                    className="text-xs text-[var(--color-muted)] font-mono whitespace-nowrap"
                    title={`Wisdom: silicon age (cap 42)\nStorage: disks/RAID (cap 42)\nMemory: RAM tier (cap 77)\nEfficiency: watts/core (cap 42, raw ${c.efficiencyRaw})\nGPU: VRAM ${c.gpuVram} + compute-class ${c.gpuCompute} (cap 49)\nDistance: peer km × link (cap 42)\nDiversity: unique pipes at same loc (cap ±21)\nUptime: √days × 3 (cap 21)`}
                  >
                    W:{c.wisdom} S:{c.storage} M:{c.memory} E:{c.efficiency}{c.efficiencyRaw > c.efficiency ? `(${c.efficiencyRaw})` : ''} G:{c.gpu} D:{c.distance} V:{c.diversity} U:{c.uptime}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
