'use client';

import { fetcher } from '@unturf/unfirehose-ui/fetcher';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import { HarnessPicker } from '@unturf/unfirehose-ui/HarnessPicker';
import { useStickyState } from '@unturf/unfirehose-ui/useStickyState';
import { harnessCommand } from '@unturf/unfirehose/harness-models';
import { UPlotTimeChart, type UPlotSeries } from '@/components/UPlotTimeChart';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SETTINGS_KEYS = {
  unsandboxPublicKey: 'unsandbox_public_key',
  unsandboxSecretKey: 'unsandbox_secret_key',
  unsandboxEnabled: 'unsandbox_enabled',
};

// HARNESSES and the model list come from the shared picker — this panel used
// to offer only Claude Code and Custom, and sent 'claude' regardless of which
// was picked (see the boot body below).

interface SshHost {
  name: string;
  hostname?: string;
  port?: string;
  user?: string;
  identityFile?: string;
  forwardAgent?: string;
}

import {
  type NodeEcon,
  EXCLUDED_HOSTS_KEY,
  PRESET_LOCATIONS,
  PROVIDERS,
  applyGeoRegionElectricity,
  computeEgressGroups,
  computeMeshScore,
  getDefaultEcon,
  getEffectiveIspCost,
  nodeEconKey,
  parseExcludedHosts,
} from '@/lib/mesh-score';
import { fmtLocalDateTime } from '@/lib/local-time';
import { StatCard } from '@unturf/unfirehose-ui/StatCard';
import { GaugeRow, GaugeBlock, GaugeCard, GaugePill } from '@unturf/unfirehose-ui/Gauge';
import { MiniStat } from '@unturf/unfirehose-ui/KV';
import {
  nodeVitals, nodeMonthlyCost, estimateContainerWatts,
  type NodeVitals, type NodeCost,
} from '@/lib/node-vitals';

// ============================================================

export default function PermacomputerPage() {
  // Live-chart cadence — 6s while the page is open. Worker keeps a 15s
  // headless baseline; this page accelerates so on-screen charts are smooth.
  const { data: mesh, mutate: mutateMesh } = useSWR('/api/mesh', fetcher, {
    refreshInterval: 6000,
    focusThrottleInterval: 6000,
  });

  // Persist mesh snapshots whenever fresh probe data lands. Without this, the
  // history table only fills while /usage is open, so /permacomputer charts
  // would never populate from this page alone. We don't call mutate() afterward
  // — SWR's own refreshInterval already polls /api/mesh/history every 30s, and
  // calling mutate() here would trigger an extra refetch on top of that, which
  // showed up as constant DOM churn / scroll-jump.
  const lastSnapshotRef = useRef<string>('');
  useEffect(() => {
    const nodes = mesh?.nodes;
    if (!nodes?.length) return;
    const key = nodes.map((n: any) => `${n.hostname}:${n.loadAvg?.[0]}`).join(',');
    if (key === lastSnapshotRef.current) return;
    lastSnapshotRef.current = key;
    fetch('/api/mesh/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes }),
    }).catch(() => {});
  }, [mesh]);

  const { data: sshData, mutate: mutateSsh } = useSWR<{ hosts: SshHost[]; keys: string[]; hash?: string }>('/api/ssh-config', fetcher);
  const { data: settings, mutate: mutateSettings } = useSWR('/api/settings', fetcher);
  const { data: unsandboxStatus } = useSWR('/api/unsandbox', fetcher, { refreshInterval: 60000 });
  const { data: unsandboxServices } = useSWR(
    unsandboxStatus?.connected ? '/api/unsandbox?action=services' : null,
    fetcher, { refreshInterval: 60000 }
  );
  const unsandboxService = (unsandboxServices?.services ?? []).find(
    (s: any) => s.name?.includes('unfirehose') || s.name?.includes('firehose')
  );
  const geoipEnabled = settings?.mesh_geoip_auto !== 'false';
  const { data: geoipData, isLoading: geoipLoading } = useSWR(
    geoipEnabled ? '/api/mesh/geoip' : null,
    fetcher,
    { refreshInterval: 0, revalidateOnFocus: false }
  );
  const hosts = useMemo(() => sshData?.hosts ?? [], [sshData]);
  const meshNodes: any[] = useMemo(() => mesh?.nodes ?? [], [mesh]);
  const localHostname: string | undefined = mesh?.localHostname;
  const reachable = meshNodes.filter((n: any) => n.reachable);

  // Load per-node economics: settings defaults → geo-region override → per-node override
  const getNodeEcon = useCallback((hostname: string): NodeEcon => {
    const defaults = getDefaultEcon(settings);
    // Local mesh node (e.g. "neoblanka") has econ saved under "localhost"
    let raw = settings?.[nodeEconKey(hostname)];
    if (!raw && localHostname && hostname === localHostname) {
      raw = settings?.[nodeEconKey('localhost')];
    }
    if (!raw) return { ...defaults };
    try {
      const perNode = { ...defaults, ...JSON.parse(raw) };
      // Apply geo-region electricity if the per-node value matches the global default (not manually overridden)
      const parsed = JSON.parse(raw);
      if (parsed.electricityCostKwh === undefined) {
        return applyGeoRegionElectricity(perNode, settings);
      }
      return perNode;
    } catch { return { ...defaults }; }
  }, [settings, localHostname]);

  // GeoIP lookup by hostname
  const getNodeGeoIP = useCallback((hostname: string) => {
    const nodes: any[] = geoipData?.nodes ?? [];
    return nodes.find((n: any) => n.hostname === hostname || (n.hostname === 'localhost' && localHostname && hostname === localHostname));
  }, [geoipData, localHostname]);

  const saveNodeEcon = useCallback(async (hostname: string, econ: NodeEcon) => {
    const key = nodeEconKey(hostname);
    const value = JSON.stringify(econ);
    mutateSettings((prev: any) => ({ ...prev, [key]: value }), { revalidate: false });
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set', key, value }) });
  }, [mutateSettings]);

  // Auto-apply GeoIP on first load for nodes without saved econ
  const autoAppliedRef = useRef(new Set<string>());
  useEffect(() => {
    if (!geoipData?.nodes || !settings) return;
    const geoNodes: any[] = geoipData.nodes;
    for (const geo of geoNodes) {
      if (geo.error || !geo.lat || autoAppliedRef.current.has(geo.hostname)) continue;
      const key = nodeEconKey(geo.hostname);
      if (settings[key]) continue; // already has per-node config
      autoAppliedRef.current.add(geo.hostname);
      const defaults = getDefaultEcon(settings);
      const locationLabel = [geo.city, geo.regionCode, geo.countryCode].filter(Boolean).join(', ');
      const econ: NodeEcon = {
        ...defaults,
        lat: geo.lat,
        lon: geo.lon,
        location: locationLabel,
        notes: `${geo.isp}${geo.as ? ` (${geo.as})` : ''}`,
      };
      const withRegion = applyGeoRegionElectricity(econ, settings);
      saveNodeEcon(geo.hostname, withRegion);
    }
  }, [geoipData, settings, saveNodeEcon]);

  // Build combined node list: mesh nodes + SSH hosts the user has econ-configured.
  // SSH-only hosts with no econ (e.g. git servers parsed from ~/.ssh/config) are
  // skipped — they shouldn't get billed a default $110/mo just for existing.
  // Hosts in mesh_excluded_hosts are filtered out at every layer.
  const allNodes = useMemo(() => {
    const nodes: { meshNode: any; sshHost?: SshHost; key: string }[] = [];
    const seen = new Set<string>();
    const excluded = parseExcludedHosts(settings);

    for (const mn of meshNodes) {
      if (excluded.has(mn.hostname)) continue;
      const host = hosts.find(h =>
        h.name === mn.hostname || h.hostname === mn.hostname ||
        h.name?.startsWith(mn.hostname + '.') || h.hostname?.startsWith(mn.hostname + '.')
      );
      const key = mn.hostname;
      seen.add(key);
      if (host) { seen.add(host.name); if (host.hostname) seen.add(host.hostname); }
      nodes.push({ meshNode: mn, sshHost: host, key });
    }

    // SSH hosts not in mesh — only include if user has explicitly configured econ.
    for (const h of hosts) {
      if (excluded.has(h.name)) continue;
      if (seen.has(h.name) || seen.has(h.hostname ?? '')) continue;
      if (!getNodeEcon(h.name).location) continue;
      nodes.push({ meshNode: null, sshHost: h, key: h.name });
    }

    return nodes;
  }, [meshNodes, hosts, settings, getNodeEcon]);

  const hideNode = useCallback(async (hostname: string) => {
    const excluded = parseExcludedHosts(settings);
    excluded.add(hostname);
    const value = JSON.stringify([...excluded]);
    mutateSettings((prev: any) => ({ ...prev, [EXCLUDED_HOSTS_KEY]: value }), { revalidate: false });
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set', key: EXCLUDED_HOSTS_KEY, value }) });
  }, [settings, mutateSettings]);

  const geoipNodes: any[] = useMemo(() => geoipData?.nodes ?? [], [geoipData]);
  const firstMeshHostname = meshNodes[0]?.hostname;
  const egressGroups = useMemo(() => computeEgressGroups(
    allNodes.map(n => ({ hostname: n.key, sshHostname: n.sshHost?.hostname })),
    geoipNodes,
    firstMeshHostname,
  ), [allNodes, geoipNodes, firstMeshHostname]);

  return (
    <div className="space-y-6">
      <PageContext
        pageType="permacomputer"
        summary={`Permacomputer. ${allNodes.length + (unsandboxStatus?.connected ? 1 : 0)} nodes, ${reachable.length + (unsandboxService ? 1 : 0)} reachable, ${mesh?.summary?.totalAgents ?? mesh?.summary?.totalClaudes ?? 0} agents.`}
        metrics={{ nodes: allNodes.length + (unsandboxStatus?.connected ? 1 : 0), reachable: reachable.length + (unsandboxService ? 1 : 0), agents: mesh?.summary?.totalAgents ?? mesh?.summary?.totalClaudes ?? 0 }}
      />

      <div>
        <h2 className="text-lg font-bold">Permacomputer</h2>
        <p className="text-base text-[var(--color-muted)]">
          Your personal compute mesh. Click a node for deep diagnostics.
        </p>
      </div>

      {/* Mesh Summary Bar */}
      {mesh?.summary && <MeshSummaryBar summary={mesh.summary} geoipLoading={geoipLoading} geoipCount={geoipData?.nodes?.filter((n: any) => !n.error).length ?? 0} />}

      {/* Mesh Economics */}
      <MeshEconomicsPanel allNodes={allNodes} meshNodes={meshNodes} getNodeEcon={getNodeEcon} geoipNodes={geoipData?.nodes ?? []} />

      {/* Node Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        <AddNodeButton hosts={hosts} keys={sshData?.keys ?? []} configHash={sshData?.hash} mutate={() => { mutateSsh(); mutateMesh(); }} seedEcon={saveNodeEcon} settings={settings} />
        {allNodes.map(({ meshNode, sshHost, key }) => (
          <NodeCard
            key={key}
            node={meshNode}
            sshHost={sshHost}
            econ={getNodeEcon(key)}
            geoip={getNodeGeoIP(key)}
            egressGroups={egressGroups}
            onHide={() => hideNode(key)}
          />
        ))}
        {unsandboxStatus?.connected && (
          <UnsandboxNodeCard status={unsandboxStatus} service={unsandboxService} />
        )}
      </div>

      {/* Unsandbox */}
      <UnsandboxPanel />
    </div>
  );
}

// ============================================================
// Mesh Summary Bar
// ============================================================

function MeshSummaryBar({ summary, geoipLoading, geoipCount }: { summary: any; geoipLoading?: boolean; geoipCount?: number }) {
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

/** Where the machine is and who carries its traffic. */
function NodeCardPlace({ v, econ, geoip }: { v: NodeVitals; econ: NodeEcon; geoip?: any }) {
  const provider = PROVIDERS.find((p) => p.value === econ.provider)?.label ?? econ.provider;
  return (
    <div className="flex items-center gap-3 text-xs text-[var(--color-muted)] flex-wrap">
      <span>{v.cpuCores} cores</span>
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

function NodeCard({ node, sshHost, econ, geoip, egressGroups, onHide }: {
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

/** What a cloud container reports about itself, once it has been probed. */
function UnsandboxProbeBody({ probe, status }: { probe: any; status: any }) {
  const v = nodeVitals(probe);
  const gpuModel = probe?.gpuModel;
  const gpuMemMB = probe?.gpuMemTotalMB ?? 0;
  const gpuW = probe?.gpuPowerWatts ?? 0;
  const watts = estimateContainerWatts(probe);

  return (
    <>
      <div className="space-y-2 mb-3">
        <GaugeRow label="VCPU" value={`${v.load1}/${v.cpuCores}`} pct={v.loadPct} />
        <GaugeRow label="RAM" value={`${v.memUsedGB}/${v.memTotalGB}G`} pct={v.memPct} />
      </div>

      <div className="flex items-center gap-3 text-xs text-[var(--color-muted)] flex-wrap">
        <span>{v.cpuCores} cores</span>
        {v.swapUsedGB > 0 && <span className="text-yellow-400">swap {v.swapUsedGB}G</span>}
        {v.uptime && v.uptime !== 'unknown' && <span>up {v.uptime}</span>}
        <span className="text-[var(--color-accent)]/70">unsandbox.com</span>
        {probe.cpuModel && probe.cpuModel !== 'unknown' && (
          <span className="truncate max-w-[150px]">{probe.cpuModel}</span>
        )}
      </div>

      {gpuModel && (
        <div className="flex items-center gap-3 text-xs text-[var(--color-muted)] mt-1">
          <span className="text-purple-400">GPU</span>
          <span className="truncate max-w-[180px]">{gpuModel}</span>
          {gpuMemMB > 0 && <span>{Math.round(gpuMemMB / 1024)}GB</span>}
          {gpuW > 0 && <span>{Math.round(gpuW)}W</span>}
        </div>
      )}

      <div className="flex items-center gap-3 text-xs text-[var(--color-muted)] mt-1.5">
        {watts > 0 && <span>{watts}W <span className="opacity-60">[est]</span></span>}
        {status.rateLimit && <span>{status.rateLimit} rpm</span>}
        {status.maxSessions && <span>{status.maxSessions} sess</span>}
        <span className="ml-auto font-bold text-[var(--color-foreground)]">
          {status.tier <= 1 ? 'free' : `tier ${status.tier}`}
        </span>
      </div>
    </>
  );
}

/** A service is deployed but has not answered a probe yet. */
function UnsandboxServiceBody({ service, status, running }: { service: any; status: any; running: boolean }) {
  return (
    <>
      <div className="space-y-1.5 mb-3">
        <div className="flex items-center gap-2 text-xs">
          <span className={`font-bold ${running ? 'text-green-400' : 'text-yellow-400'}`}>
            {service.status ?? 'deployed'}
          </span>
          <span className="text-[var(--color-muted)]">{service.name}</span>
        </div>
        {service.domain && (
          <div className="text-xs text-[var(--color-muted)] font-mono truncate">{service.domain}</div>
        )}
      </div>
      <div className="flex items-center gap-3 text-xs text-[var(--color-muted)] flex-wrap">
        {status.rateLimit && <span>{status.rateLimit} rpm</span>}
        {status.maxSessions && <span>{status.maxSessions} session{status.maxSessions !== 1 ? 's' : ''}</span>}
        <span className="text-[var(--color-accent)]/70">unsandbox.com</span>
      </div>
    </>
  );
}

function UnsandboxNodeCard({ status, service }: { status: any; service?: any }) {
  const hasService = !!service;
  const running = hasService && (service.status === 'running' || service.status === 'active');
  const { data: probeData } = useSWR(
    status?.connected ? 'unsandbox-probe' : null,
    async () => {
      const res = await fetch('/api/unsandbox', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'probe' }),
      });
      return res.json();
    },
    { refreshInterval: 120000, revalidateOnFocus: false },
  );
  const probe = probeData?.probe;

  return (
    <Link
      href="/permacomputer/unsandbox"
      className="text-left bg-[var(--color-surface)] rounded border p-4 transition-all cursor-pointer hover:border-[var(--color-accent)]/50 border-[var(--color-border)] block"
    >
      <div className="flex items-center gap-2 mb-3">
        <span className={`text-sm ${running || probe ? 'text-green-400' : hasService ? 'text-yellow-400' : 'text-[var(--color-accent)]'}`}>
          {running || probe ? '●' : hasService ? '◐' : '○'}
        </span>
        <span className="text-base font-bold font-mono truncate">unsandbox</span>
        <span className="text-xs text-[var(--color-muted)] font-mono">cloud</span>
        <span className="ml-auto text-xs font-bold text-[var(--color-accent)] bg-[var(--color-accent)]/10 px-1.5 py-0.5 rounded">
          tier {status.tier}
        </span>
      </div>

      {probe ? (
        <UnsandboxProbeBody probe={probe} status={status} />
      ) : hasService ? (
        <UnsandboxServiceBody service={service} status={status} running={running} />
      ) : (
        <div className="text-xs text-[var(--color-muted)]">
          <span className="text-green-400">connected</span> — no unfirehose service deployed yet
          <div className="mt-1.5 text-[var(--color-accent)]">click to set up →</div>
        </div>
      )}
    </Link>
  );
}

// ============================================================
// Add Node Button (inline card)
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function AddNodeButton({ hosts: _hosts, keys, configHash, mutate, seedEcon, settings }: { hosts: SshHost[]; keys: string[]; configHash?: string; mutate: () => void; seedEcon?: (hostname: string, econ: NodeEcon) => Promise<void>; settings?: any }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<SshHost>({ name: '', hostname: '', port: '22', user: '', identityFile: '', forwardAgent: 'yes' });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!form.name) return;
    setSaving(true);
    try {
      const res = await fetch('/api/ssh-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, hash: configHash }) });
      if (res.status === 409) {
        mutate();
        alert('SSH config changed on disk since this page loaded — reloaded it. Please re-apply your entry.');
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error ?? 'Failed to save host');
        return;
      }
      if (res.ok) {
        // Seed a placeholder econ so the new node shows up immediately under the
        // "configured-only" filter. User refines from the node detail page.
        if (seedEcon) {
          const econ: NodeEcon = { ...getDefaultEcon(settings), location: form.name };
          await seedEcon(form.name, econ);
        }
        mutate();
        setAdding(false);
        setForm({ name: '', hostname: '', port: '22', user: '', identityFile: '', forwardAgent: 'yes' });
      }
    } finally { setSaving(false); }
  };

  if (!adding) {
    return (
      <button
        onClick={() => setAdding(true)}
        className="border border-dashed border-[var(--color-border)] rounded p-4 flex items-center justify-center gap-2 text-base text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:border-[var(--color-accent)]/50 transition-colors cursor-pointer min-h-[120px]"
      >
        <span className="text-lg">+</span> Add Node
      </button>
    );
  }

  return (
    <div className="border border-[var(--color-accent)]/30 rounded p-4 space-y-3 col-span-1 md:col-span-2 xl:col-span-3">
      <HostForm form={form} setForm={setForm} keys={keys} onSave={save} onCancel={() => setAdding(false)} saving={saving} isNew />
    </div>
  );
}

// ============================================================
// Overview Tab
// ============================================================

function OverviewTab({ detail }: { detail: any }) {
  const sys = detail.system;
  const mem = detail.memory;
  const load = detail.loadAvg;
  const cores = sys?.cpuCores ?? 1;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _uptimeHours = Math.round((detail.uptimeSeconds ?? 0) / 3600);

  // Build load sparkline from 1/5/15 min averages
  const loadPoints = load ? [load[0], load[1], load[2]] : [0, 0, 0];
  const maxLoad = Math.max(...loadPoints, cores) || 1;

  const memPct = mem ? Math.round((mem.usedGB / mem.totalGB) * 100) : 0;
  const swapPct = mem && mem.swapTotalGB > 0 ? Math.round((mem.swapUsedGB / mem.swapTotalGB) * 100) : 0;

  return (
    <div className="space-y-5">
      {/* System info */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="CPU" value={sys?.cpuModel?.replace(/\(R\)|\(TM\)/g, '').replace(/CPU\s+/i, '').trim() ?? 'n/a'} sub={`${cores} cores${sys?.cpuMhz ? ` @ ${Math.round(sys.cpuMhz)}MHz` : ''}`} compact />
        <StatCard label="Architecture" value={sys?.arch ?? 'n/a'} sub={sys?.kernel ?? ''} compact />
        <StatCard label="OS" value={sys?.os ?? 'Linux'} sub={`up ${formatDuration(detail.uptimeSeconds)}`} compact />
        {(() => {
          // Was "Claudes" and counted only claude, so a node running five
          // uncloseai-cli agents reported none.
          const procs: any[] = detail.harnessProcesses ?? detail.claudeProcesses ?? [];
          const counts: Record<string, number> = detail.harnessCounts
            ?? (detail.claudeProcesses?.length ? { claude: detail.claudeProcesses.length } : {});
          const sub = procs.length
            ? Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')
            : 'none running';
          return <StatCard label="Agents" value={procs.length} sub={sub} tone="accent" compact />;
        })()}
      </div>

      {/* Load & Memory gauges */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Load */}
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-4">
          <div className="text-xs text-[var(--color-muted)] mb-2">Load Average</div>
          <div className="flex items-end gap-1 h-16 mb-2">
            {['1m', '5m', '15m'].map((label, i) => {
              const val = loadPoints[i];
              const pct = Math.min(100, (val / maxLoad) * 100);
              const color = val > cores ? '#ef4444' : val > cores * 0.7 ? '#eab308' : 'var(--color-accent)';
              return (
                <div key={label} className="flex-1 flex flex-col items-center gap-1">
                  <span className="text-xs font-mono font-bold" style={{ color }}>{val.toFixed(2)}</span>
                  <div className="w-full bg-[var(--color-surface)] rounded-sm overflow-hidden" style={{ height: '100%' }}>
                    <div className="w-full rounded-sm transition-all" style={{ height: `${pct}%`, backgroundColor: color, marginTop: `${100 - pct}%` }} />
                  </div>
                  <span className="text-xs text-[var(--color-muted)]">{label}</span>
                </div>
              );
            })}
          </div>
          <div className="text-xs text-[var(--color-muted)]">
            runnable: {detail.runnable} / threshold: {cores} cores
          </div>
        </div>

        {/* Memory */}
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-4">
          <div className="text-xs text-[var(--color-muted)] mb-2">Memory</div>
          {mem && (
            <>
              <GaugeBlock label="RAM" pct={memPct} value={`${mem.usedGB}/${mem.totalGB}G`} sub={`${mem.availableGB}G available`} />
              <div className="flex gap-3 text-xs text-[var(--color-muted)] mt-2 mb-3">
                <span>buffers: {mem.buffersGB}G</span>
                <span>cached: {mem.cachedGB}G</span>
                <span>shmem: {mem.shmemGB}G</span>
                {mem.dirtyMB > 0 && <span className="text-yellow-400">dirty: {mem.dirtyMB}MB</span>}
              </div>
              {mem.swapTotalGB > 0 && (
                <GaugeBlock label="Swap" pct={swapPct} value={`${mem.swapUsedGB}/${mem.swapTotalGB}G`} sub={mem.swapCachedGB > 0 ? `${mem.swapCachedGB}G cached` : ''} warn={swapPct > 50} />
              )}
            </>
          )}
        </div>
      </div>

      {/* Temperatures */}
      {detail.temperatures?.length > 0 && (
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-4">
          <div className="text-xs text-[var(--color-muted)] mb-2">Thermal Zones</div>
          <div className="flex gap-4 flex-wrap">
            {detail.temperatures.map((t: any, i: number) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs text-[var(--color-muted)]">{t.zone}</span>
                <span className={`text-sm font-mono font-bold ${t.tempC > 80 ? 'text-red-400' : t.tempC > 60 ? 'text-yellow-400' : 'text-green-400'}`}>
                  {t.tempC}°C
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Processes Tab
// ============================================================

function ProcessesTab({ detail }: { detail: any }) {
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);

  const allProcesses: any[] = useMemo(() => detail.processes ?? [], [detail.processes]);
  const claudePs: any[] = detail.harnessProcesses ?? detail.claudeProcesses ?? [];

  const filtered = useMemo(() => {
    let list = allProcesses;
    if (filter) {
      const q = filter.toLowerCase();
      list = list.filter((p: any) => p.command?.toLowerCase().includes(q) || p.user?.toLowerCase().includes(q));
    }
    return showAll ? list : list.slice(0, 30);
  }, [allProcesses, filter, showAll]);

  return (
    <div className="space-y-4">
      {/* Claude processes hero section */}
      {claudePs.length > 0 && (
        <div className="bg-[var(--color-accent)]/5 border border-[var(--color-accent)]/20 rounded p-4 space-y-2">
          <div className="text-xs font-bold text-[var(--color-accent)]">
            {claudePs.length} Claude process{claudePs.length !== 1 ? 'es' : ''} running
          </div>
          <div className="space-y-1">
            {claudePs.map((p: any, i: number) => (
              <div key={i} className="flex items-center gap-3 text-xs font-mono">
                <span className="text-[var(--color-accent)] w-12">PID {p.pid}</span>
                <span className="text-[var(--color-muted)] w-12">{p.user}</span>
                <GaugePill label="cpu" value={p.cpu} max={100} />
                <GaugePill label="mem" value={p.mem} max={100} />
                <span className="text-[var(--color-muted)] w-16">RSS {formatBytes(p.rss * 1024)}</span>
                <span className="text-[var(--color-muted)] w-16">{p.time}</span>
                <span className="text-[var(--color-foreground)] truncate flex-1">{p.command}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Process filter */}
      <div className="flex items-center gap-3">
        <input
          type="text" value={filter} onChange={e => setFilter(e.target.value)}
          placeholder="filter processes..."
          className="flex-1 bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-xs font-mono"
        />
        <span className="text-xs text-[var(--color-muted)]">{filtered.length} of {allProcesses.length}</span>
      </div>

      {/* Process table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-[var(--color-muted)] border-b border-[var(--color-border)]">
              <th className="text-left py-1 pr-2">USER</th>
              <th className="text-right py-1 pr-2">PID</th>
              <th className="text-right py-1 pr-2">%CPU</th>
              <th className="text-right py-1 pr-2">%MEM</th>
              <th className="text-right py-1 pr-2">RSS</th>
              <th className="text-left py-1 pr-2">STAT</th>
              <th className="text-left py-1 pr-2">TIME</th>
              <th className="text-left py-1">COMMAND</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p: any, i: number) => {
              const isClaude = p.command?.toLowerCase().includes('claude');
              return (
                <tr key={i} className={`border-b border-[var(--color-border)]/30 hover:bg-[var(--color-surface-hover)] ${isClaude ? 'bg-[var(--color-accent)]/5' : ''}`}>
                  <td className="py-0.5 pr-2 text-[var(--color-muted)]">{p.user}</td>
                  <td className="py-0.5 pr-2 text-right">{p.pid}</td>
                  <td className={`py-0.5 pr-2 text-right ${p.cpu > 50 ? 'text-red-400 font-bold' : p.cpu > 10 ? 'text-yellow-400' : ''}`}>{p.cpu}</td>
                  <td className={`py-0.5 pr-2 text-right ${p.mem > 20 ? 'text-red-400 font-bold' : p.mem > 5 ? 'text-yellow-400' : ''}`}>{p.mem}</td>
                  <td className="py-0.5 pr-2 text-right text-[var(--color-muted)]">{formatBytes(p.rss * 1024)}</td>
                  <td className="py-0.5 pr-2 text-[var(--color-muted)]">{p.stat}</td>
                  <td className="py-0.5 pr-2 text-[var(--color-muted)]">{p.time}</td>
                  <td className={`py-0.5 truncate max-w-md ${isClaude ? 'text-[var(--color-accent)]' : ''}`}>{p.command}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!showAll && allProcesses.length > 30 && (
        <button onClick={() => setShowAll(true)} className="text-xs text-[var(--color-accent)] hover:underline cursor-pointer">
          Show all {allProcesses.length} processes
        </button>
      )}
    </div>
  );
}

// ============================================================
// GPU Tab
// ============================================================

function GpuTab({ detail }: { detail: any }) {
  const nvidia: any[] = detail.gpu?.nvidia ?? [];
  const nvidiaPs: any[] = detail.gpu?.nvidiaProcesses ?? [];
  const amd: any[] = detail.gpu?.amd ?? [];

  return (
    <div className="space-y-4">
      {nvidia.map((gpu: any, i: number) => (
        <div key={i} className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-base font-bold">{gpu.name}</span>
              <span className="text-xs text-[var(--color-muted)] ml-2">GPU {gpu.index}</span>
            </div>
            <span className="text-xs font-mono text-[var(--color-muted)]">{gpu.pstate}</span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <GaugeCard label="GPU Utilization" pct={gpu.gpuUtil} value={`${gpu.gpuUtil}%`} />
            <GaugeCard label="Memory" pct={gpu.memTotalMB > 0 ? Math.round((gpu.memUsedMB / gpu.memTotalMB) * 100) : 0} value={`${gpu.memUsedMB}/${gpu.memTotalMB}MB`} />
            <GaugeCard label="Power" pct={gpu.powerLimitW > 0 ? Math.round((gpu.powerDrawW / gpu.powerLimitW) * 100) : 0} value={`${gpu.powerDrawW}/${gpu.powerLimitW}W`} />
            <div className="bg-[var(--color-surface)] rounded p-3">
              <div className="text-xs text-[var(--color-muted)] mb-1">Thermal</div>
              <div className={`text-lg font-mono font-bold ${gpu.tempC > 80 ? 'text-red-400' : gpu.tempC > 65 ? 'text-yellow-400' : 'text-green-400'}`}>
                {gpu.tempC}°C
              </div>
              <div className="text-xs text-[var(--color-muted)]">fan {gpu.fanPct}%</div>
            </div>
          </div>
        </div>
      ))}

      {nvidiaPs.length > 0 && (
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-4">
          <div className="text-xs text-[var(--color-muted)] mb-2">GPU Processes</div>
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-[var(--color-muted)] border-b border-[var(--color-border)]">
                <th className="text-right py-1 pr-3">PID</th>
                <th className="text-left py-1 pr-3">Process</th>
                <th className="text-right py-1">GPU Mem</th>
              </tr>
            </thead>
            <tbody>
              {nvidiaPs.map((p: any, i: number) => (
                <tr key={i} className="border-b border-[var(--color-border)]/30">
                  <td className="py-0.5 pr-3 text-right">{p.pid}</td>
                  <td className="py-0.5 pr-3">{p.name}</td>
                  <td className="py-0.5 text-right">{p.memMB}MB</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {amd.length > 0 && (
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-4">
          <div className="text-xs text-[var(--color-muted)] mb-2">AMD GPU</div>
          <pre className="text-xs font-mono overflow-x-auto">{JSON.stringify(amd, null, 2)}</pre>
        </div>
      )}

      {!nvidia.length && !amd.length && (
        <div className="text-base text-[var(--color-muted)]">No GPU detected on this node.</div>
      )}
    </div>
  );
}

// ============================================================
// Disk Tab
// ============================================================

function DiskTab({ detail }: { detail: any }) {
  const disks: any[] = detail.disk ?? [];

  return (
    <div className="space-y-3">
      {disks.map((d: any, i: number) => (
        <div key={i} className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-3">
          <div className="flex items-center justify-between mb-2">
            <div>
              <span className="text-xs font-mono font-bold">{d.mount}</span>
              <span className="text-xs text-[var(--color-muted)] ml-2">{d.device}</span>
            </div>
            <span className="text-xs font-mono">{d.used} / {d.size}</span>
          </div>
          <div className="h-2 bg-[var(--color-surface)] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${d.usePct}%`,
                backgroundColor: d.usePct > 90 ? '#ef4444' : d.usePct > 75 ? '#eab308' : 'var(--color-accent)',
              }}
            />
          </div>
          <div className="flex justify-between mt-1 text-xs text-[var(--color-muted)]">
            <span>{d.usePct}% used</span>
            <span>{d.avail} free</span>
          </div>
        </div>
      ))}
      {disks.length === 0 && <div className="text-base text-[var(--color-muted)]">No disk data available.</div>}
    </div>
  );
}

// ============================================================
// Network Tab
// ============================================================

function NetworkTab({ detail }: { detail: any }) {
  const ifaces: any[] = detail.network?.interfaces ?? [];
  const throughput: any[] = detail.network?.throughput ?? [];

  return (
    <div className="space-y-4">
      {/* Interfaces */}
      <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-4">
        <div className="text-xs text-[var(--color-muted)] mb-2">Interfaces</div>
        <div className="space-y-1">
          {ifaces.map((iface: any, i: number) => (
            <div key={i} className="flex items-center gap-3 text-xs font-mono">
              <span className={`w-16 font-bold ${iface.state === 'UP' ? 'text-green-400' : 'text-[var(--color-muted)]'}`}>{iface.name}</span>
              <span className={`w-10 ${iface.state === 'UP' ? 'text-green-400' : 'text-red-400'}`}>{iface.state}</span>
              <span className="text-[var(--color-muted)] flex-1 truncate">{iface.addrs}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Throughput */}
      {throughput.length > 0 && (
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-4">
          <div className="text-xs text-[var(--color-muted)] mb-2">Cumulative Throughput (since boot)</div>
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-[var(--color-muted)] border-b border-[var(--color-border)]">
                <th className="text-left py-1">Interface</th>
                <th className="text-right py-1">RX</th>
                <th className="text-right py-1">TX</th>
                <th className="text-right py-1">RX pkts</th>
                <th className="text-right py-1">TX pkts</th>
              </tr>
            </thead>
            <tbody>
              {throughput.map((n: any, i: number) => (
                <tr key={i} className="border-b border-[var(--color-border)]/30">
                  <td className="py-0.5 font-bold">{n.iface}</td>
                  <td className="py-0.5 text-right text-green-400">{formatBytes(n.rxBytes)}</td>
                  <td className="py-0.5 text-right text-blue-400">{formatBytes(n.txBytes)}</td>
                  <td className="py-0.5 text-right text-[var(--color-muted)]">{formatNumber(n.rxPackets)}</td>
                  <td className="py-0.5 text-right text-[var(--color-muted)]">{formatNumber(n.txPackets)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Sessions Tab
// ============================================================

function SessionsTab({ detail }: { detail: any }) {
  const tmux: any[] = detail.sessions?.tmux ?? [];
  const screen: any[] = detail.sessions?.screen ?? [];
  const docker: any[] = detail.containers ?? [];

  return (
    <div className="space-y-4">
      {/* Tmux */}
      <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-4">
        <div className="text-xs text-[var(--color-muted)] mb-2">tmux sessions</div>
        {tmux.length > 0 ? (
          <div className="space-y-1">
            {tmux.map((s: any, i: number) => (
              <div key={i} className="flex items-center gap-3 text-xs font-mono">
                <span className="text-green-400">●</span>
                <span className="font-bold">{s.name}</span>
                <span className="text-[var(--color-muted)]">{s.windows} window{s.windows !== 1 ? 's' : ''}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-[var(--color-muted)]">No tmux sessions</div>
        )}
      </div>

      {/* Screen */}
      {screen.length > 0 && (
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-4">
          <div className="text-xs text-[var(--color-muted)] mb-2">screen sessions</div>
          <div className="space-y-1">
            {screen.map((s: any, i: number) => (
              <div key={i} className="flex items-center gap-3 text-xs font-mono">
                <span className="text-green-400">●</span>
                <span className="font-bold">{s.name}</span>
                <span className="text-[var(--color-muted)]">PID {s.pid}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Docker */}
      {docker.length > 0 && (
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-4">
          <div className="text-xs text-[var(--color-muted)] mb-2">Docker Containers</div>
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-[var(--color-muted)] border-b border-[var(--color-border)]">
                <th className="text-left py-1">Name</th>
                <th className="text-left py-1">Image</th>
                <th className="text-left py-1">Status</th>
                <th className="text-left py-1">Ports</th>
              </tr>
            </thead>
            <tbody>
              {docker.map((c: any, i: number) => (
                <tr key={i} className="border-b border-[var(--color-border)]/30">
                  <td className="py-0.5 font-bold">{c.name}</td>
                  <td className="py-0.5 text-[var(--color-muted)]">{c.image}</td>
                  <td className={`py-0.5 ${c.status?.includes('Up') ? 'text-green-400' : 'text-yellow-400'}`}>{c.status}</td>
                  <td className="py-0.5 text-[var(--color-muted)]">{c.ports}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tmux.length === 0 && screen.length === 0 && docker.length === 0 && (
        <div className="text-base text-[var(--color-muted)]">No active sessions or containers.</div>
      )}
    </div>
  );
}

// ============================================================
// Mesh Economics Panel
// ============================================================

// Fleet-wide live metrics. Power & cost share the blended $/kWh derived in
// computeMeshScore so charts stay consistent with the headline numbers.
// Every chart overlays per-host lines on top of a bold fleet aggregate.
const HOST_COLORS = ['#f97316', '#a78bfa', '#60a5fa', '#22c55e', '#f43f5e', '#facc15', '#38bdf8', '#ec4899', '#84cc16', '#fb923c'];

function FleetMetricsChart({ blendedKwhRate }: { blendedKwhRate: number }) {
  // Remembered across refreshes — this was useState(24), so picking 6h and
  // reloading snapped back to 24h.
  const [hours, setHours] = useStickyState<number>('fleet_metrics_hours', 24);
  // 30s refresh — matches snapshot sample rate; per-minute aggregation means new
  // points land roughly every minute but the cadence keeps the tail "live".
  const { data } = useSWR(`/api/mesh/history?hours=${hours}&hostname=all`, fetcher, {
    refreshInterval: 6000,
    focusThrottleInterval: 6000,
    keepPreviousData: true,
  });

  const { chartData, hosts, hostsWithGpu } = useMemo(() => {
    const timeline: any[] = data?.timeline ?? [];
    const hostSet = new Set<string>();
    const gpuHostSet = new Set<string>();
    const rows = timeline.map((t) => {
      const row: any = {
        timestamp: t.timestamp,
        tsMs: new Date(String(t.timestamp).replace(' ', 'T') + 'Z').getTime(),
        watts: t.totalWatts ?? 0,
        cpuWatts: t.cpuWatts ?? 0,
        gpuWatts: t.gpuWatts ?? 0,
        cpuPct: Math.round((t.avgLoad ?? 0) * 100 * 10) / 10,
        memUsedGB: t.memUsedGB ?? 0,
        memTotalGB: t.memTotalGB ?? 0,
        memPct: t.memTotalGB > 0 ? Math.round((t.memUsedGB / t.memTotalGB) * 100 * 10) / 10 : 0,
        gpuUtil: t.gpuUtil ?? 0,
        gpuVramUsedGB: t.gpuMemUsedGB ?? 0,
        gpuVramTotalGB: t.gpuMemTotalGB ?? 0,
        gpuVramPct: t.gpuMemTotalGB > 0 ? Math.round((t.gpuMemUsedGB / t.gpuMemTotalGB) * 100 * 10) / 10 : 0,
        elecCostPerHour: Math.round(((t.totalWatts ?? 0) / 1000) * blendedKwhRate * 100) / 100,
      };
      for (const [host, n] of Object.entries<any>(t.nodes ?? {})) {
        hostSet.add(host);
        const cores = n.cores || 1;
        row[`cpu:${host}`] = Math.round((n.load / cores) * 100 * 10) / 10;
        row[`mem:${host}`] = n.memTotal > 0 ? Math.round((n.memUsed / n.memTotal) * 100 * 10) / 10 : 0;
        row[`watts:${host}`] = Math.round((n.watts ?? 0) * 10) / 10;
        if (n.gpuMemTotalMB > 0 || (n.gpuUtil != null && n.gpuUtil > 0)) {
          gpuHostSet.add(host);
          row[`gpuUtil:${host}`] = n.gpuUtil ?? 0;
          row[`gpuVram:${host}`] = n.gpuMemTotalMB > 0
            ? Math.round(((n.gpuMemUsedMB ?? 0) / n.gpuMemTotalMB) * 100 * 10) / 10
            : 0;
        }
      }
      return row;
    });
    return {
      chartData: rows,
      hosts: [...hostSet].sort(),
      hostsWithGpu: [...gpuHostSet].sort(),
    };
  }, [data, blendedKwhRate]);

  const hasData = chartData.length > 0;
  const last = hasData ? chartData[chartData.length - 1] : null;
  // While history is empty we don't know which hosts have GPUs — keep panels
  // visible so the user sees what's coming. Once data lands, hide if truly no GPU.
  const hasGpu = !hasData || hostsWithGpu.length > 0;
  // Per-host series builders for each chart. Fleet aggregate is rendered
  // first (accent red, thick line); per-host lines follow in their fleet
  // colors with thinner strokes. hostColor must be declared BEFORE the
  // series-builder consts that reference it (lexical TDZ).
  const hostColor = (host: string, list: string[]) => HOST_COLORS[list.indexOf(host) % HOST_COLORS.length];
  const SYNC = 'permacomputer-fleet';
  const wattsSeries: UPlotSeries[] = [
    { key: 'watts', label: 'Fleet', stroke: '#d40000', width: 2.5 },
    ...hosts.map(h => ({ key: `watts:${h}`, label: h, stroke: hostColor(h, hosts), width: 1 } as UPlotSeries)),
  ];
  const cpuSeries: UPlotSeries[] = [
    { key: 'cpuPct', label: 'Fleet avg', stroke: '#d40000', width: 2.5 },
    ...hosts.map(h => ({ key: `cpu:${h}`, label: h, stroke: hostColor(h, hosts), width: 1 } as UPlotSeries)),
  ];
  const memSeries: UPlotSeries[] = [
    { key: 'memPct', label: 'Fleet', stroke: '#d40000', width: 2.5 },
    ...hosts.map(h => ({ key: `mem:${h}`, label: h, stroke: hostColor(h, hosts), width: 1 } as UPlotSeries)),
  ];
  const gpuUtilSeries: UPlotSeries[] = [
    { key: 'gpuUtil', label: 'GPU avg', stroke: '#d40000', width: 2.5 },
    ...hostsWithGpu.map(h => ({ key: `gpuUtil:${h}`, label: h, stroke: hostColor(h, hostsWithGpu), width: 1 } as UPlotSeries)),
  ];
  const gpuVramSeries: UPlotSeries[] = [
    { key: 'gpuVramPct', label: 'VRAM avg', stroke: '#d40000', width: 2.5 },
    ...hostsWithGpu.map(h => ({ key: `gpuVram:${h}`, label: h, stroke: hostColor(h, hostsWithGpu), width: 1 } as UPlotSeries)),
  ];
  const tipLabel = fmtLocalDateTime;
  const tz = typeof window !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
  const ranges: { label: string; h: number }[] = [
    { label: '6h', h: 6 }, { label: '24h', h: 24 }, { label: '7d', h: 168 },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold text-[var(--color-muted)]">
          Fleet Metrics <span className="font-normal text-[10px] opacity-60">{hosts.length} nodes &middot; 30s refresh &middot; {tz}</span>
        </h4>
        <div className="flex gap-1">
          {ranges.map((r) => (
            <button
              key={r.h}
              onClick={() => setHours(r.h)}
              className={`text-xs px-2 py-0.5 rounded ${hours === r.h ? 'bg-[var(--color-accent)] text-black' : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)]'}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {!hasData && (
        <div className="bg-[var(--color-background)] border border-dashed border-[var(--color-border)] rounded p-4 text-xs text-[var(--color-muted)]">
          No mesh snapshots in the selected window. Keep this page open — fresh probes are recorded every 30s and charts populate as data arrives.
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Power — fleet total + per-host */}
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-3">
          <h5 className="text-xs font-bold mb-2 text-[var(--color-muted)]">
            Power <span className="font-normal ml-1">{hasData ? `${Math.round(last!.watts)}W now` : '— no data'}</span>
          </h5>
          <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={null} yUnit="W" series={wattsSeries} />
        </div>

        {/* Electricity cost — derived from blended fleet rate */}
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-3">
          <h5 className="text-xs font-bold mb-2 text-[var(--color-muted)]">
            Electricity Cost <span className="font-normal ml-1">{hasData ? `$${last!.elecCostPerHour}/hr now` : '— no data'}</span>
          </h5>
          <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={null}
            series={[{ key: 'elecCostPerHour', label: '$/hr', stroke: '#facc15', fill: 'rgba(250,204,21,0.20)' }]}
          />
        </div>

        {/* CPU % — load-as-percent per host + fleet avg */}
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-3">
          <h5 className="text-xs font-bold mb-2 text-[var(--color-muted)]">
            CPU % <span className="font-normal ml-1">{hasData ? `${last!.cpuPct}% fleet avg` : '— no data'}</span>
          </h5>
          <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={null} yUnit="%" yMin={0} series={cpuSeries} />
        </div>

        {/* Memory % — used/total per host + fleet aggregate */}
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-3">
          <h5 className="text-xs font-bold mb-2 text-[var(--color-muted)]">
            Memory % <span className="font-normal ml-1">{hasData ? `${last!.memPct}% · ${last!.memUsedGB}/${last!.memTotalGB} GB` : '— no data'}</span>
          </h5>
          <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={null} yUnit="%" yMin={0} yMax={100} series={memSeries} />
        </div>

        {/* GPU Util — per-host + cross-GPU-node avg */}
        {hasGpu && (
          <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-3">
            <h5 className="text-xs font-bold mb-2 text-[var(--color-muted)]">
              GPU Utilization <span className="font-normal ml-1">{hasData ? `${last!.gpuUtil}% avg · ${hostsWithGpu.length} gpu` : '— no data'}</span>
            </h5>
            <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={null} yUnit="%" yMin={0} yMax={100} series={gpuUtilSeries} />
          </div>
        )}

        {/* GPU VRAM — per-host VRAM% + cross-node avg */}
        {hasGpu && (
          <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-3">
            <h5 className="text-xs font-bold mb-2 text-[var(--color-muted)]">
              GPU VRAM <span className="font-normal ml-1">{hasData ? `${last!.gpuVramPct}% · ${last!.gpuVramUsedGB}/${last!.gpuVramTotalGB} GB` : '— no data'}</span>
            </h5>
            <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={null} yUnit="%" yMin={0} yMax={100} series={gpuVramSeries} />
          </div>
        )}

      </div>
    </div>
  );
}

function MeshEconomicsPanel({ allNodes, meshNodes, getNodeEcon, geoipNodes }: {
  allNodes: { meshNode: any; sshHost?: SshHost; key: string }[];
  meshNodes: any[];
  getNodeEcon: (hostname: string) => NodeEcon;
  geoipNodes: any[];
}) {
  const firstMeshHostname = meshNodes[0]?.hostname;
  const econNodes = useMemo(() =>
    allNodes.map(n => ({
      hostname: n.key,
      sshHostname: n.sshHost?.hostname,
      econ: getNodeEcon(n.key),
      meshNode: n.meshNode,
    })),
    [allNodes, getNodeEcon]
  );

  const score = useMemo(() => computeMeshScore(econNodes, geoipNodes, firstMeshHostname), [econNodes, geoipNodes, firstMeshHostname]);
  const configuredCount = econNodes.filter(n => n.econ.location).length;

  // Aggregate by provider — ISP subscription cost only (stable/configured).
  // Electricity is per-node and lives in the fleet metrics chart, not here.
  const byProvider = useMemo(() => {
    const map = new Map<string, { count: number; cost: number }>();
    for (const n of econNodes) {
      const p = n.econ.provider;
      const cur = map.get(p) ?? { count: 0, cost: 0 };
      const nodeCost = getEffectiveIspCost(n.hostname, n.econ.ispCostMonthly, score.egressGroups);
      map.set(p, { count: cur.count + 1, cost: cur.cost + nodeCost });
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

      {/* Fleet metrics — power, cost, CPU%, memory, GPU util, GPU VRAM */}
      <FleetMetricsChart blendedKwhRate={score.blendedKwhRate} />

      {/* Provider + Location breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* By provider */}
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-3">
          <div className="text-xs text-[var(--color-muted)] mb-2">By Provider</div>
          <div className="space-y-1.5">
            {byProvider.map(([prov, { count, cost }]) => {
              const label = PROVIDERS.find(p => p.value === prov)?.label ?? prov;
              const pct = score.totalMonthlyCost > 0 ? Math.round((cost / score.totalMonthlyCost) * 100) : 0;
              return (
                <div key={prov} className="flex items-center gap-2">
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
            {score.nodeScores.sort((a, b) => b.score - a.score).map(ns => {
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

// ============================================================
// Economics Tab (per-node)
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function EconomicsTab({ hostname: _hostname, econ, onSave, meshNode, geoip, settings }: {
  hostname: string; econ: NodeEcon; onSave: (e: NodeEcon) => void; meshNode?: any; geoip?: any; settings?: any;
}) {
  const [form, setForm] = useState<NodeEcon>(econ);
  const [saved, setSaved] = useState(false);
  const { data: rates } = useSWR(
    form.ispCostMonthly > 0 ? '/api/mesh/rates' : null,
    fetcher,
    { refreshInterval: 0 }
  );

  const save = () => {
    onSave(form);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const setLocation = (loc: string) => {
    const preset = PRESET_LOCATIONS.find(p => p.value === loc);
    if (preset) {
      setForm({ ...form, location: loc, lat: preset.lat, lon: preset.lon });
    } else {
      setForm({ ...form, location: loc });
    }
  };

  // Auto-populate from GeoIP data
  const applyGeoIP = () => {
    if (!geoip || geoip.error) return;
    const locationLabel = [geoip.city, geoip.regionCode, geoip.countryCode].filter(Boolean).join(', ');
    const updated: NodeEcon = {
      ...form,
      lat: geoip.lat || form.lat,
      lon: geoip.lon || form.lon,
      location: locationLabel || form.location,
      notes: form.notes || `${geoip.isp}${geoip.as ? ` (${geoip.as})` : ''}`,
    };
    // Apply geo-region electricity rate if available
    const withRegion = applyGeoRegionElectricity(updated, settings);
    setForm(withRegion);
  };

  // Power cost estimate
  const watts = meshNode?.powerWatts ?? 0;
  const gpuWatts = meshNode?.gpuPowerWatts ?? 0;
  const totalWatts = watts + gpuWatts;
  const monthlyKwh = totalWatts > 0 ? (totalWatts * 24 * 30.44) / 1000 : 0;
  const monthlyPowerCost = monthlyKwh * form.electricityCostKwh;
  const totalMonthlyCost = form.ispCostMonthly + monthlyPowerCost;

  return (
    <div className="space-y-5">
      {/* Cost inputs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <label className="text-xs text-[var(--color-muted)] block mb-1">ISP / Egress Cost ($/mo)</label>
          <input type="number" value={form.ispCostMonthly} onChange={e => setForm({ ...form, ispCostMonthly: parseFloat(e.target.value) || 0 })}
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono" />
        </div>
        <div>
          <label className="text-xs text-[var(--color-muted)] block mb-1">Electricity ($/kWh)</label>
          <input type="number" step="0.01" value={form.electricityCostKwh} onChange={e => setForm({ ...form, electricityCostKwh: parseFloat(e.target.value) || 0 })}
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono" />
        </div>
        <div>
          <label className="text-xs text-[var(--color-muted)] block mb-1">Link Speed (Mbps)</label>
          <input type="number" value={form.linkMbps} onChange={e => setForm({ ...form, linkMbps: parseFloat(e.target.value) || 0 })}
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono" />
        </div>
        <div>
          <label className="text-xs text-[var(--color-muted)] block mb-1">Provider</label>
          <select value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })}
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base">
            {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
      </div>

      {/* Location */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="md:col-span-2">
          <label className="text-xs text-[var(--color-muted)] block mb-1">Location</label>
          <div className="flex gap-2">
            <select value={PRESET_LOCATIONS.find(p => p.value === form.location) ? form.location : '__custom__'}
              onChange={e => { if (e.target.value !== '__custom__') setLocation(e.target.value); }}
              className="flex-1 bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base">
              <option value="__custom__">Custom location...</option>
              {PRESET_LOCATIONS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
            <input type="text" value={form.location} onChange={e => setForm({ ...form, location: e.target.value })}
              placeholder="e.g. us-east-1 or home-boston"
              className="flex-1 bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-xs font-mono" />
          </div>
        </div>
        <div>
          <label className="text-xs text-[var(--color-muted)] block mb-1">Latitude</label>
          <input type="number" step="0.1" value={form.lat} onChange={e => setForm({ ...form, lat: parseFloat(e.target.value) || 0 })}
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono" />
        </div>
        <div>
          <label className="text-xs text-[var(--color-muted)] block mb-1">Longitude</label>
          <input type="number" step="0.1" value={form.lon} onChange={e => setForm({ ...form, lon: parseFloat(e.target.value) || 0 })}
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono" />
        </div>
      </div>

      {/* Notes */}
      <div>
        <label className="text-xs text-[var(--color-muted)] block mb-1">Notes</label>
        <input type="text" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
          placeholder="e.g. Comcast 1Gbps, basement rack, UPS battery backup"
          className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base" />
      </div>

      {/* GeoIP auto-populate */}
      {geoip && !geoip.error && (
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs text-[var(--color-muted)]">GeoIP Detection</div>
            <button onClick={applyGeoIP}
              className="px-3 py-1 text-xs font-bold rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors cursor-pointer">
              Apply GeoIP Data
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            <div><span className="text-[var(--color-muted)]">IP:</span> <span className="font-mono">{geoip.ip}</span></div>
            <div><span className="text-[var(--color-muted)]">Location:</span> {geoip.city}, {geoip.region}, {geoip.countryCode}</div>
            <div><span className="text-[var(--color-muted)]">ISP:</span> {geoip.isp}</div>
            <div><span className="text-[var(--color-muted)]">Coords:</span> <span className="font-mono">{geoip.lat}, {geoip.lon}</span></div>
          </div>
          {geoip.org && geoip.org !== geoip.isp && (
            <div className="text-xs"><span className="text-[var(--color-muted)]">Org:</span> {geoip.org} <span className="text-[var(--color-muted)]">AS:</span> {geoip.as}</div>
          )}
        </div>
      )}
      {geoip?.error && (
        <div className="text-xs text-yellow-400">GeoIP: {geoip.error}</div>
      )}

      {/* Save */}
      <div className="flex items-center gap-3">
        <button onClick={save}
          className="px-4 py-1.5 text-base font-bold rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors cursor-pointer">
          Save Economics
        </button>
        {saved && <span className="text-xs text-green-400 font-bold">Saved</span>}
      </div>

      {/* Cost breakdown */}
      <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-4 space-y-3">
        <div className="text-xs text-[var(--color-muted)] mb-2">Monthly Cost Breakdown</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <div className="text-xs text-[var(--color-muted)]">ISP / Egress</div>
            <div className="text-base font-mono font-bold">${form.ispCostMonthly.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-xs text-[var(--color-muted)]">Power ({totalWatts}W × 730h)</div>
            <div className="text-base font-mono font-bold">${monthlyPowerCost.toFixed(2)}</div>
            <div className="text-xs text-[var(--color-muted)]">{monthlyKwh.toFixed(1)} kWh @ ${form.electricityCostKwh}/kWh</div>
          </div>
          <div>
            <div className="text-xs text-[var(--color-muted)]">Total Monthly</div>
            <div className="text-base font-mono font-bold text-[var(--color-accent)]">${totalMonthlyCost.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-xs text-[var(--color-muted)]">Annual</div>
            <div className="text-base font-mono font-bold">${(totalMonthlyCost * 12).toFixed(0)}</div>
          </div>
        </div>

        {/* Cost per unit */}
        {meshNode && (
          <div className="border-t border-[var(--color-border)] pt-3 grid grid-cols-3 gap-4">
            <div>
              <div className="text-xs text-[var(--color-muted)]">$/core/mo</div>
              <div className="text-sm font-mono">${meshNode.cpuCores ? (totalMonthlyCost / meshNode.cpuCores).toFixed(2) : 'n/a'}</div>
            </div>
            <div>
              <div className="text-xs text-[var(--color-muted)]">$/GB RAM/mo</div>
              <div className="text-sm font-mono">${meshNode.memTotalGB ? (totalMonthlyCost / meshNode.memTotalGB).toFixed(2) : 'n/a'}</div>
            </div>
            <div>
              <div className="text-xs text-[var(--color-muted)]">$/watt/mo</div>
              <div className="text-sm font-mono">${totalWatts > 0 ? (totalMonthlyCost / totalWatts).toFixed(2) : 'n/a'}</div>
            </div>
          </div>
        )}

        {/* Currency conversions */}
        {rates && (
          <div className="border-t border-[var(--color-border)] pt-3">
            <div className="text-xs text-[var(--color-muted)] mb-2">Currency Conversions (monthly)</div>
            <div className="flex flex-wrap gap-3">
              {Object.entries(rates.fiat ?? {}).map(([cur, rate]: [string, any]) => (
                <div key={cur} className="text-xs font-mono">
                  <span className="text-[var(--color-muted)]">{cur}</span>{' '}
                  <span>{(totalMonthlyCost * (rate as number)).toFixed(2)}</span>
                </div>
              ))}
              {Object.entries(rates.crypto ?? {}).map(([cur, rate]: [string, any]) => (
                <div key={cur} className="text-xs font-mono">
                  <span className="text-[var(--color-accent)]">{cur}</span>{' '}
                  <span>{(totalMonthlyCost * (rate as number)).toFixed(6)}</span>
                </div>
              ))}
            </div>
            {rates.source && <div className="text-xs text-[var(--color-muted)] mt-1">via {rates.source} — {rates.updatedAt}</div>}
          </div>
        )}
      </div>

      {/* Comparison to cloud */}
      {meshNode && (
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-4 space-y-2">
          <div className="text-xs text-[var(--color-muted)] mb-2">Cloud Comparison (equivalent specs)</div>
          {(() => {
            const cores = meshNode.cpuCores ?? 0;
            const ram = meshNode.memTotalGB ?? 0;
            // Rough cloud equivalents
            const comparisons = [
              { name: 'AWS EC2 (m7i)', monthlyCost: cores * 18 + ram * 2.5 },
              { name: 'GCP (n2-standard)', monthlyCost: cores * 16 + ram * 2.1 },
              { name: 'Azure (D-series v5)', monthlyCost: cores * 17 + ram * 2.3 },
              { name: 'Hetzner (dedicated)', monthlyCost: cores * 5 + ram * 1.2 },
              { name: 'OVH (Rise)', monthlyCost: cores * 4 + ram * 1.0 },
            ];
            return comparisons.map(c => {
              const savings = c.monthlyCost - totalMonthlyCost;
              const savingsPct = c.monthlyCost > 0 ? Math.round((savings / c.monthlyCost) * 100) : 0;
              return (
                <div key={c.name} className="flex items-center gap-3">
                  <span className="text-xs w-40">{c.name}</span>
                  <span className="text-xs font-mono w-20">${c.monthlyCost.toFixed(0)}/mo</span>
                  <span className={`text-xs font-bold ${savings > 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {savings > 0 ? `save $${savings.toFixed(0)} (${savingsPct}%)` : `+$${Math.abs(savings).toFixed(0)} more`}
                  </span>
                </div>
              );
            });
          })()}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Shared UI Components
// ============================================================

// ============================================================
// Helpers
// ============================================================

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)}${units[i]}`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDuration(seconds: number): string {
  if (!seconds) return 'n/a';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ============================================================
// Unsandbox Panel
// ============================================================

function UnsandboxPanel() {
  const router = useRouter();
  const { data: settings, mutate: mutateSettings } = useSWR('/api/settings', fetcher);
  const { data: status, mutate: mutateStatus } = useSWR('/api/unsandbox', fetcher, { refreshInterval: 60000 });
  const [showSecret, setShowSecret] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; tier?: number; error?: string } | null>(null);
  const [booting, setBooting] = useState(false);
  const [bootResult, setBootResult] = useState<any>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootPrompt, setBootPrompt] = useState('');
  const [bootLog, setBootLog] = useState<string[]>([]);

  const publicKey = settings?.[SETTINGS_KEYS.unsandboxPublicKey] ?? '';
  const secretKey = settings?.[SETTINGS_KEYS.unsandboxSecretKey] ?? '';
  const enabled = settings?.[SETTINGS_KEYS.unsandboxEnabled] === 'true';

  const saveSetting = async (key: string, value: string) => {
    mutateSettings((prev: Record<string, string> | undefined) => ({ ...prev, [key]: value }), { revalidate: false });
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set', key, value }) });
    mutateStatus();
  };

  const testConnection = async () => {
    setTesting(true); setTestResult(null);
    try {
      const res = await fetch('/api/unsandbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'test' }) });
      const result = await res.json();
      setTestResult(result);
      if (result.ok) {
        // Success — redirect to unsandbox node page
        setTimeout(() => router.push('/permacomputer/unsandbox'), 400);
      }
    } catch (err) { setTestResult({ ok: false, error: String(err) }); }
    finally { setTesting(false); }
  };

  const bootOnUnsandbox = async () => {
    setBooting(true); setBootResult(null); setBootError(null); setBootLog([]);
    try {
      const res = await fetch('/api/boot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: 'unsandbox', projectPath: '/workspace', harness: 'claude', prompt: bootPrompt.trim() || undefined }),
      });
      const data = await res.json();
      if (res.ok) setBootResult(data); else setBootError(data.error || 'Boot failed');
    } catch (err) { setBootError(String(err)); }
    finally { setBooting(false); }
  };

  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-bold text-[var(--color-muted)]">unsandbox.com</h3>
          <p className="text-base text-[var(--color-muted)] mt-0.5">
            Cloud compute for agent harnesses. Free tier or paid for sessions + semitrust network.
          </p>
        </div>
        <label className="flex items-center gap-2 text-base shrink-0">
          <input type="checkbox" checked={enabled} className="accent-[var(--color-accent)]"
            onChange={(e) => saveSetting(SETTINGS_KEYS.unsandboxEnabled, String(e.target.checked))} />
          <span className={enabled ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'}>
            {enabled ? 'Enabled' : 'Disabled'}
          </span>
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Public Key</label>
          <input type="text" defaultValue={publicKey} placeholder="unsb-pk-xxxx-xxxx-xxxx-xxxx"
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono"
            autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other"
            onBlur={(e) => { if (e.target.value !== publicKey) saveSetting(SETTINGS_KEYS.unsandboxPublicKey, e.target.value.trim()); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        </div>
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Secret Key</label>
          <div className="flex gap-2">
            <input type={showSecret ? 'text' : 'password'} defaultValue={secretKey} placeholder="unsb-sk-xxxx-xxxx-xxxx-xxxx"
              className="flex-1 bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono"
              autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other"
              onBlur={(e) => { if (e.target.value !== secretKey) saveSetting(SETTINGS_KEYS.unsandboxSecretKey, e.target.value.trim()); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
            <button onClick={() => setShowSecret(!showSecret)}
              className="px-2 text-base text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors cursor-pointer">
              {showSecret ? 'hide' : 'show'}
            </button>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        {status?.connected && (
          <Link href="/permacomputer/unsandbox" className="flex items-center gap-3 text-base hover:opacity-80 transition-opacity">
            <span className="text-green-400">● connected</span>
            <span className="text-[var(--color-muted)]">tier {status.tier}</span>
            <span className="text-[var(--color-muted)]">{status.rateLimit} rpm</span>
            <span className="text-[var(--color-muted)]">{status.maxSessions} session{status.maxSessions !== 1 ? 's' : ''}</span>
            {status.network && <span className="text-[var(--color-muted)]">{status.network}</span>}
            <span className="text-[var(--color-accent)] text-xs font-bold">open &rarr;</span>
          </Link>
        )}
        {status && !status.connected && publicKey && (
          <span className="text-base text-red-400">○ {status.error || 'disconnected'}</span>
        )}
        <button onClick={testConnection} disabled={testing || !publicKey || !secretKey}
          className="px-3 py-1 text-base rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:border-[var(--color-muted)] transition-colors disabled:opacity-50 cursor-pointer">
          {testing ? 'testing...' : 'test connection'}
        </button>
        {testResult && (
          <span className={`text-base font-bold ${testResult.ok ? 'text-green-400' : 'text-red-400'}`}>
            {testResult.ok ? `tier ${testResult.tier}` : testResult.error}
          </span>
        )}
      </div>

      {enabled && publicKey && secretKey && (
        <div className="border-t border-[var(--color-border)] pt-3 space-y-3">
          <h4 className="text-base font-bold text-[var(--color-muted)]">Boot on unsandbox</h4>
          <div className="flex gap-2">
            <input type="text" value={bootPrompt} onChange={e => setBootPrompt(e.target.value)}
              placeholder="initial prompt (optional)"
              className="flex-1 bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base"
              onKeyDown={e => { if (e.key === 'Enter') bootOnUnsandbox(); }} />
            <button onClick={bootOnUnsandbox} disabled={booting}
              className="px-4 py-1.5 text-base font-bold rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors disabled:opacity-50 cursor-pointer whitespace-nowrap">
              {booting ? 'Booting...' : 'Boot Claude on unsandbox'}
            </button>
          </div>
          {bootLog.length > 0 && (
            <div className="font-mono text-xs bg-[var(--color-background)] rounded border border-[var(--color-border)] p-2 space-y-0.5 max-h-40 overflow-y-auto">
              {bootLog.map((line, i) => (
                <div key={i} className={line.includes('error') || line.includes('Failed') ? 'text-red-400' : line.includes('complete') || line.includes('ready') || line.includes('installed') || line.includes('running') ? 'text-green-400' : 'text-[var(--color-muted)]'}>{line}</div>
              ))}
            </div>
          )}
          {bootResult && (
            <div className="text-base text-green-400 font-mono">
              session: {bootResult.sessionId}
              {bootResult.domain && <span className="ml-2 text-[var(--color-muted)]">{bootResult.domain}</span>}
            </div>
          )}
          {bootError && <div className="text-base text-red-400">{bootError}</div>}
        </div>
      )}

      {!publicKey && (
        <div className="text-base text-[var(--color-muted)] space-y-1">
          <div>
            Free code execution for anyone. Get keys at{' '}
            <a href="https://unsandbox.com" target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] hover:underline">unsandbox.com</a>
            {' '}— free tier runs 42 languages, paid tiers add sessions + semitrust network for agent harnesses.
          </div>
          <div>
            Tier formula: <span className="font-mono text-[var(--color-foreground)]">$7*N/mo</span> for <span className="font-mono text-[var(--color-foreground)]">N*7 rpm</span> + sessions.
            CLI: <code className="font-mono text-[var(--color-foreground)]">curl -O unsandbox.com/cli/typescript</code>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Host Form
// ============================================================

function HostForm({ form, setForm, keys, onSave, onCancel, saving, isNew }: {
  form: SshHost; setForm: (f: SshHost) => void; keys: string[];
  onSave: () => void; onCancel: () => void; saving: boolean; isNew?: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Host Alias</label>
          <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. cammy" disabled={!isNew}
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono disabled:opacity-50" />
        </div>
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">HostName</label>
          <input type="text" value={form.hostname ?? ''} onChange={e => setForm({ ...form, hostname: e.target.value })}
            placeholder="e.g. cammy.foxhop.net"
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono" />
        </div>
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Port</label>
          <input type="text" value={form.port ?? ''} onChange={e => setForm({ ...form, port: e.target.value })}
            placeholder="22"
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono" />
        </div>
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">User</label>
          <input type="text" value={form.user ?? ''} onChange={e => setForm({ ...form, user: e.target.value })}
            placeholder="e.g. fox"
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono" />
        </div>
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Identity File</label>
          <select value={form.identityFile ?? ''} onChange={e => setForm({ ...form, identityFile: e.target.value })}
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono">
            <option value="">default</option>
            {keys.map(k => <option key={k} value={`~/.ssh/${k}`}>~/.ssh/{k}</option>)}
          </select>
        </div>
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Forward Agent</label>
          <div className="flex gap-2 mt-0.5">
            {['yes', 'no'].map(v => (
              <button key={v} onClick={() => setForm({ ...form, forwardAgent: v })}
                className={`flex-1 px-3 py-1.5 text-base rounded border transition-colors cursor-pointer ${
                  form.forwardAgent === v ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-bold' : 'border-[var(--color-border)] hover:border-[var(--color-muted)]'
                }`}>
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button onClick={onSave} disabled={saving || !form.name}
          className="px-4 py-1.5 text-base font-bold rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors disabled:opacity-50 cursor-pointer">
          {saving ? 'Saving...' : isNew ? 'Add Host' : 'Save'}
        </button>
        <button onClick={onCancel}
          className="px-4 py-1.5 text-base rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors cursor-pointer">
          Cancel
        </button>
      </div>
    </div>
  );
}
