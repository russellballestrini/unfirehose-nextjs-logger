'use client';

import { fetcher } from '@unturf/unfirehose-ui/fetcher';

import { useCallback, useMemo, useEffect, useRef } from 'react';
import useSWR from 'swr';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import {
  type NodeEcon,
  EXCLUDED_HOSTS_KEY,
  applyGeoRegionElectricity,
  computeEgressGroups,
  getDefaultEcon,
  nodeEconKey,
  parseExcludedHosts,
} from '@/lib/mesh-score';
import { sshHostForMesh } from '@unturf/unfirehose/hostname-match';
import type { SshHost } from './types';
import { MeshSummaryBar } from './MeshSummaryBar';
import { NodeCard } from './NodeCard';
import { AddNodeButton } from './AddNodeButton';
import { EmptyState } from '@unturf/unfirehose-ui/EmptyState';
import { FleetMetricsPanel } from './FleetMetrics';
import { MeshEconomicsPanel } from './MeshEconomicsPanel';
import { useMeshIntegrations } from '@/integrations';
import { CoachMarks } from '@/components/CoachMarks';

// The panels this page is made of live beside it; they are re-exported here
// because their tests import them from './page'.
export { MeshSummaryBar } from './MeshSummaryBar';
export { NodeCard } from './NodeCard';
export { AddNodeButton } from './AddNodeButton';
export { FleetMetricsChart, FleetMetricsPanel } from './FleetMetrics';
export { MeshEconomicsPanel } from './MeshEconomicsPanel';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================================

export default function PermacomputerPage() {
  // Live-chart cadence — 6s while the page is open. Worker keeps a 15s
  // headless baseline; this page accelerates so on-screen charts are smooth.
  const { data: mesh, mutate: mutateMesh } = useSWR('/api/mesh', fetcher, {
    refreshInterval: 6000,
    focusThrottleInterval: 6000,
  });

  const { data: sshData, mutate: mutateSsh } = useSWR<{ hosts: SshHost[]; keys: string[]; hash?: string }>('/api/ssh-config', fetcher);
  const { data: settings, mutate: mutateSettings } = useSWR('/api/settings', fetcher);
  // Nodes, cards and panels an integration adds (a cloud account), when one is on.
  const extra = useMeshIntegrations();
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
      const host = sshHostForMesh(hosts, mn.hostname);
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
        summary={`Permacomputer. ${allNodes.length + extra.nodes} nodes, ${reachable.length + extra.reachable} reachable, ${mesh?.summary?.totalAgents ?? mesh?.summary?.totalClaudes ?? 0} agents.`}
        metrics={{ nodes: allNodes.length + extra.nodes, reachable: reachable.length + extra.reachable, agents: mesh?.summary?.totalAgents ?? mesh?.summary?.totalClaudes ?? 0 }}
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
      <div data-coach="mesh-economics">
        <MeshEconomicsPanel allNodes={allNodes} meshNodes={meshNodes} getNodeEcon={getNodeEcon} geoipNodes={geoipData?.nodes ?? []} />
      </div>
      <CoachMarks page="permacomputer" />

      {/* Node Grid */}
      <div data-coach="mesh-nodes" className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        <AddNodeButton hosts={hosts} keys={sshData?.keys ?? []} configHash={sshData?.hash} mutate={() => { mutateSsh(); mutateMesh(); }} seedEcon={saveNodeEcon} settings={settings} />
        {mesh && allNodes.length === 0 && extra.nodes === 0 && (
          <EmptyState
            className="md:col-span-1 xl:col-span-2"
            what="Nodes will appear here: every host in our SSH config that answers a probe, with its power, load, GPUs and agents."
            action="Add one with the card beside this, or a Host entry in our SSH config, then reload:"
            command="~/.ssh/config"
          />
        )}
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
        {extra.cards}
      </div>

      {/* Fleet metrics — power, cost, CPU%, memory, GPU util, GPU VRAM.
          Below the fold on purpose: the headline economics and the node
          cards are what a glance is for; the charts are for a look. */}
      <FleetMetricsPanel allNodes={allNodes} meshNodes={meshNodes} getNodeEcon={getNodeEcon} geoipNodes={geoipData?.nodes ?? []} />

      {/* Integrations that are on (Settings → Integrations) */}
      {extra.panels}
    </div>
  );
}
