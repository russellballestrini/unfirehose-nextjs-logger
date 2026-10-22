'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GaugeRow } from '@unturf/unfirehose-ui/Gauge';
import { type NodeEcon, PROVIDERS } from '@/lib/mesh-score';
import { nodeVitals, nodeMonthlyCost, type NodeVitals, type NodeCost } from '@/lib/node-vitals';
import type { SshHost } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================================
// Node Card (compact, clickable)
// ============================================================

/** The status dot, name and agent badge across the top of a card. */
function NodeCardHeader({ v, onHide }: { v: NodeVitals; onHide?: () => void }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className={`text-sm ${v.reachable ? 'text-green-400' : 'text-red-400'}`}>
        {v.reachable ? '●' : '○'}
      </span>
      <span className="text-base font-bold font-mono truncate">{v.name}</span>
      {v.hostname && v.hostname !== v.name && (
        <span className="text-xs text-[var(--color-muted)] font-mono truncate">{v.hostname}</span>
      )}
      {/* What kind of node: a switch is not a place to run an agent, and a
          hypervisor's guests are its work. A Linux compute box says nothing. */}
      {v.kind === 'network' && (
        <span className="text-[10px] font-bold uppercase tracking-wide text-sky-400 bg-sky-400/10 px-1.5 py-0.5 rounded" title={[v.platform, v.model].filter(Boolean).join(' · ')}>net</span>
      )}
      {v.kind === 'hypervisor' && (
        <span className="text-[10px] font-bold uppercase tracking-wide text-violet-400 bg-violet-400/10 px-1.5 py-0.5 rounded" title={[v.platform, v.model].filter(Boolean).join(' · ')}>
          {v.vms > 0 ? `${v.vms} vm${v.vms !== 1 ? 's' : ''}` : 'hv'}
        </span>
      )}
      {v.kind === 'compute' && v.platform && (
        <span className="text-[10px] text-[var(--color-muted)] truncate" title={v.model || undefined}>{v.platform}</span>
      )}
      {v.agents > 0 && (
        <span className="ml-auto text-xs font-bold text-[var(--color-accent)] bg-[var(--color-accent)]/10 px-1.5 py-0.5 rounded">
          <span title={v.agentLabel || undefined}>
            {v.agents} agent{v.agents !== 1 ? 's' : ''}
          </span>
        </span>
      )}
      {onHide && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (confirm(`Hide ${v.name} from permacomputer? Re-include by removing it from the mesh_excluded_hosts setting.`)) onHide();
          }}
          title="Hide from permacomputer"
          className={`${v.agents > 0 ? '' : 'ml-auto'} opacity-0 group-hover:opacity-100 text-xs text-[var(--color-muted)] hover:text-red-400 px-1 leading-none transition-opacity`}
        >
          ✕
        </button>
      )}
    </div>
  );
}

/** Cores, memory and — only where there is a card — GPU. */
function NodeCardGauges({ v }: { v: NodeVitals }) {
  return (
    <div className="space-y-2 mb-3">
      <GaugeRow label="VCPU" value={`${v.load1}/${v.cpuCores}`} pct={v.loadPct} />
      <GaugeRow label="RAM" value={`${v.memUsedGB}/${v.memTotalGB}G`} pct={v.memPct} />
      {v.hasGpu && (
        <>
          <GaugeRow label="GPU" value={`${v.gpuUtil}%`} pct={v.gpuUtil} />
          <GaugeRow
            label="VRAM"
            value={`${v.gpuVramUsedGB.toFixed(1)}/${v.gpuVramTotalGB.toFixed(1)}G`}
            pct={v.gpuVramPct}
          />
        </>
      )}
    </div>
  );
}

/**
 * The containers a node runs, as a way into its Containers tab. The card is
 * itself a link to the node's Overview, and an anchor cannot nest in an
 * anchor, so this is a button that navigates -- the same shape as the hide
 * control in the header.
 */
function NodeCardContainers({ v }: { v: NodeVitals }) {
  const router = useRouter();
  if (!(v.containers > 0)) return null;
  const idle = v.containersRunning === 0;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        router.push(`/permacomputer/${encodeURIComponent(v.probeHost)}#Containers`);
      }}
      title={`${v.containersRunning} running of ${v.containers} — open the Containers tab`}
      className={`px-1.5 py-0.5 rounded font-mono hover:underline ${idle ? 'text-[var(--color-muted)] bg-[var(--color-border)]/40' : 'text-emerald-400 bg-emerald-400/10'}`}
    >
      {v.containersRunning}/{v.containers} container{v.containers !== 1 ? 's' : ''}
    </button>
  );
}

/** Where the machine is and who carries its traffic. */
function NodeCardPlace({ v, econ, geoip }: { v: NodeVitals; econ: NodeEcon; geoip?: any }) {
  const provider = PROVIDERS.find((p) => p.value === econ.provider)?.label ?? econ.provider;
  return (
    <div className="flex items-center gap-3 text-xs text-[var(--color-muted)] flex-wrap">
      <span>{v.cpuCores} cores</span>
      <NodeCardContainers v={v} />
      {v.swapUsedGB > 0 && <span className="text-yellow-400">swap {v.swapUsedGB}G</span>}
      {v.uptime && <span>up {v.uptime}</span>}
      {geoip?.city
        ? <span className="text-[var(--color-accent)]/70">{geoip.city}, {geoip.countryCode}</span>
        : econ.location && <span className="text-[var(--color-accent)]/70">{econ.location}</span>}
      {geoip?.isp
        ? <span className="truncate max-w-[120px]">{geoip.isp}</span>
        : econ.provider !== 'home' && <span>{provider}</span>}
    </div>
  );
}

/** Watts and what they cost by the month. */
function NodeCardCost({ cost }: { cost: NodeCost }) {
  return (
    <div className="flex items-center gap-3 text-xs text-[var(--color-muted)] mt-1.5">
      <span>
        {Math.round(cost.watts)}W
        {cost.gpuWatts > 0 && <span className="opacity-60"> ({Math.round(cost.gpuWatts)}W gpu)</span>}
        {' '}<span className="opacity-60">[{cost.source}]</span>
      </span>
      <span>${Math.round(cost.elecMonthly)}/mo elec</span>
      {cost.ispShared && (
        <span className="text-green-400">
          ${Math.round(cost.ispMonthly)}/mo isp <span className="opacity-60">(split)</span>
        </span>
      )}
      {cost.watts > 0 && <span className="opacity-60">${cost.perWatt.toFixed(2)}/W·mo</span>}
      <span className="ml-auto font-bold text-[var(--color-foreground)]">
        ${Math.round(cost.monthly)}/mo
      </span>
    </div>
  );
}

/** Why we could not read a node, and enough of its config to fix that. */
function NodeCardUnreachable({ node, sshHost }: { node: any; sshHost?: SshHost }) {
  return (
    <div className="text-xs text-[var(--color-muted)]">
      {node?.error ?? (node ? 'unreachable' : 'not probed')}
      {sshHost && (
        <div className="mt-1">
          {sshHost.user && <span>user: {sshHost.user} </span>}
          {sshHost.port && sshHost.port !== '22' && <span>port: {sshHost.port}</span>}
        </div>
      )}
    </div>
  );
}

export function NodeCard({ node, sshHost, econ, geoip, egressGroups, onHide }: {
  node: any; sshHost?: SshHost; econ: NodeEcon; geoip?: any; egressGroups?: Map<string, string[]>;
  onHide?: () => void;
}) {
  const v = nodeVitals(node, sshHost);

  return (
    <Link
      href={`/permacomputer/${encodeURIComponent(v.probeHost)}`}
      className="group text-left bg-[var(--color-surface)] rounded border p-4 transition-all cursor-pointer hover:border-[var(--color-accent)]/50 border-[var(--color-border)] block relative"
    >
      <NodeCardHeader v={v} onHide={onHide} />
      {v.reachable ? (
        <>
          <NodeCardGauges v={v} />
          <NodeCardPlace v={v} econ={econ} geoip={geoip} />
          <NodeCardCost cost={nodeMonthlyCost(node, econ, v.name, egressGroups)} />
        </>
      ) : (
        <NodeCardUnreachable node={node} sshHost={sshHost} />
      )}
    </Link>
  );
}
