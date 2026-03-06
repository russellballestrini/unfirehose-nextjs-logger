'use client';

import { useParams } from 'next/navigation';
import useSWR from 'swr';
import Link from 'next/link';
import { useState, useEffect } from 'react';

const fetcher = (url: string) => fetch(url).then(r => r.json());

const DEFAULT_KWH_RATE = 0.31;

export default function NodeDetailPage() {
  const { hostname } = useParams<{ hostname: string }>();
  const host = decodeURIComponent(hostname);

  const { data: mesh } = useSWR('/api/mesh', fetcher, { refreshInterval: 10000 });
  const { data: probe, isLoading: probeLoading } = useSWR(
    `/api/mesh/node?host=${encodeURIComponent(host)}`,
    fetcher,
    { refreshInterval: 30000 },
  );
  const { data: settings } = useSWR('/api/settings', fetcher, { revalidateOnFocus: false });

  // Per-node tunables
  const [kwhRate, setKwhRate] = useState(DEFAULT_KWH_RATE);
  const [ispCost, setIspCost] = useState(0);
  const [diskOverride, setDiskOverride] = useState<number | undefined>();
  const [wattsOverride, setWattsOverride] = useState<number | undefined>();

  useEffect(() => {
    if (!settings) return;
    if (settings[`electricity_rate_${host}`]) setKwhRate(parseFloat(settings[`electricity_rate_${host}`]) || DEFAULT_KWH_RATE);
    if (settings[`isp_cost_${host}`]) setIspCost(parseFloat(settings[`isp_cost_${host}`]) || 0);
    if (settings[`disk_override_${host}`]) setDiskOverride(parseInt(settings[`disk_override_${host}`]) || 0);
    if (settings[`watts_override_${host}`]) setWattsOverride(parseFloat(settings[`watts_override_${host}`]) || 0);
  }, [settings, host]);

  const saveSetting = (key: string, value: string) => {
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set', key, value }),
    });
  };

  // Find this node in mesh data
  const node = mesh?.nodes?.find((n: any) => n.hostname === host);

  // Power calculation
  let systemWatts = wattsOverride || node?.powerWatts || 0;
  if (!wattsOverride && diskOverride !== undefined && node) {
    const extraDisks = Math.max(0, diskOverride - (node.spinningDisks ?? 0));
    systemWatts += extraDisks * 8;
  }
  const gpuWatts = node?.gpuPowerWatts ?? 0;
  const totalWatts = systemWatts + gpuWatts;
  const kwhPerMonth = (totalWatts * 24 * 30) / 1000;
  const elecPerMonth = kwhPerMonth * kwhRate;
  const totalPerMonth = elecPerMonth + ispCost;

  const sys = probe?.system;
  const mem = probe?.memory;
  const loadPerCore = sys?.cpuCores > 0 && probe?.loadAvg ? probe.loadAvg[0] / sys.cpuCores : 0;
  const memPct = mem ? ((mem.totalGB - mem.availableGB) / mem.totalGB) * 100 : 0;

  return (
    <div className="p-6 w-full">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-[var(--color-muted)] mb-4">
        <Link href="/usage" className="hover:text-[var(--color-foreground)]">Usage</Link>
        <span>/</span>
        <span className="text-[var(--color-foreground)]">{host}</span>
      </div>

      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <span className={`w-3 h-3 rounded-full ${node?.reachable ? 'bg-[var(--color-accent)] animate-pulse' : 'bg-[var(--color-error)]'}`} />
        <h1 className="text-2xl font-bold">{host}</h1>
        {node && (
          <span className="text-sm text-[var(--color-muted)]">
            up {node.uptime} &middot; {node.claudeProcesses} claudes
          </span>
        )}
      </div>

      {/* Cost hero */}
      {node && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 mb-6">
          <div className="flex items-baseline gap-6 flex-wrap">
            <div>
              <span className="text-3xl font-bold text-[var(--color-accent)]">${totalPerMonth.toFixed(0)}</span>
              <span className="text-sm text-[var(--color-muted)]">/mo total</span>
            </div>
            <div className="text-sm text-[var(--color-muted)]">
              {systemWatts.toFixed(0)}W sys{gpuWatts > 0 && <> + {gpuWatts.toFixed(0)}W gpu</>}
              {' = '}{totalWatts.toFixed(0)}W
              {' '}
              <span className={`text-[10px] ${wattsOverride ? 'text-yellow-400' : 'text-[var(--color-accent)]'}`}>
                [{wattsOverride ? 'override' : node.powerSource ?? 'n/a'}
                {!wattsOverride && node.cpuTdpWatts && ` ${node.cpuTdpWatts}W tdp`}]
              </span>
            </div>
            <div className="text-sm text-[var(--color-muted)]">
              {kwhPerMonth.toFixed(1)} kWh/mo &middot; ${elecPerMonth.toFixed(0)} elec &middot; ${ispCost.toFixed(0)} isp
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ===== LEFT COLUMN ===== */}
        <div className="space-y-6">

          {/* System Info */}
          <Section title="System">
            {sys ? (
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <KV label="CPU" value={sys.cpuModel?.replace(/\(R\)|\(TM\)/g, '').replace(/CPU\s+/i, '').trim()} />
                <KV label="Cores" value={`${sys.cpuCores}${sys.cpuMhz ? ` @ ${Math.round(sys.cpuMhz)}MHz` : ''}`} />
                <KV label="Architecture" value={sys.arch} />
                <KV label="Kernel" value={sys.kernel} />
                <KV label="OS" value={sys.os} />
                <KV label="Cache" value={sys.cpuCache} />
                {node?.cpuModel && <KV label="TDP" value={node.cpuTdpWatts ? `${node.cpuTdpWatts}W` : 'unknown'} />}
              </div>
            ) : probeLoading ? (
              <div className="text-sm text-[var(--color-muted)] animate-pulse">Probing...</div>
            ) : (
              <div className="text-sm text-[var(--color-error)]">{probe?.error ?? 'Probe failed'}</div>
            )}
          </Section>

          {/* CPU Load */}
          {probe?.loadAvg && (
            <Section title="CPU Load">
              <div className="space-y-2">
                <div className="flex justify-between text-sm text-[var(--color-muted)]">
                  <span>Load: {probe.loadAvg[0].toFixed(2)} / {probe.loadAvg[1].toFixed(2)} / {probe.loadAvg[2].toFixed(2)}</span>
                  <span>{probe.runnable}</span>
                </div>
                <Bar pct={Math.min(loadPerCore * 100, 100)} color={loadPerCore > 2 ? 'var(--color-error)' : '#f97316'} />
                <div className="text-xs text-[var(--color-muted)]">
                  {(loadPerCore * 100).toFixed(0)}% per-core utilization
                </div>
              </div>
            </Section>
          )}

          {/* Memory */}
          {mem && (
            <Section title="Memory">
              <div className="space-y-2">
                <div className="flex justify-between text-sm text-[var(--color-muted)]">
                  <span>{mem.usedGB.toFixed(1)}GB / {mem.totalGB.toFixed(1)}GB ({memPct.toFixed(0)}%)</span>
                  <span>{mem.availableGB.toFixed(1)}G available</span>
                </div>
                <Bar pct={memPct} color={memPct > 85 ? 'var(--color-error)' : '#60a5fa'} />
                <div className="flex gap-4 text-xs text-[var(--color-muted)] flex-wrap">
                  <span>buffers: {mem.buffersGB}G</span>
                  <span>cached: {mem.cachedGB}G</span>
                  <span>shmem: {mem.shmemGB}G</span>
                  {mem.dirtyMB > 0 && <span className="text-[var(--color-error)]">dirty: {mem.dirtyMB}MB</span>}
                </div>
                {mem.swapTotalGB > 0 && (
                  <div className="text-xs text-[var(--color-muted)]">
                    Swap: {mem.swapUsedGB}GB / {mem.swapTotalGB}GB
                    {mem.swapUsedGB > 0.1 && (
                      <span className="text-[var(--color-error)]"> ({((mem.swapUsedGB / mem.swapTotalGB) * 100).toFixed(0)}%)</span>
                    )}
                  </div>
                )}
              </div>
            </Section>
          )}

          {/* Temperatures */}
          {probe?.temperatures?.length > 0 && (
            <Section title="Thermal Zones">
              <div className="flex flex-wrap gap-3">
                {probe.temperatures.map((t: any) => (
                  <div key={t.zone} className="text-sm">
                    <span className="text-[var(--color-muted)]">{t.zone}</span>{' '}
                    <span className={t.tempC > 80 ? 'text-[var(--color-error)] font-bold' : t.tempC > 60 ? 'text-[#f97316]' : 'text-[var(--color-foreground)]'}>
                      {t.tempC}°C
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Disks */}
          {probe?.disk?.length > 0 && (
            <Section title="Disk">
              <div className="space-y-2">
                {probe.disk.filter((d: any) => !d.device.startsWith('tmpfs')).map((d: any) => (
                  <div key={d.mount} className="space-y-1">
                    <div className="flex justify-between text-xs text-[var(--color-muted)]">
                      <span className="font-mono">{d.device}</span>
                      <span>{d.mount} &middot; {d.used}/{d.size} ({d.usePct}%)</span>
                    </div>
                    <Bar pct={d.usePct} color={d.usePct > 90 ? 'var(--color-error)' : d.usePct > 75 ? '#f97316' : '#22c55e'} />
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>

        {/* ===== RIGHT COLUMN ===== */}
        <div className="space-y-6">

          {/* Cost Tunables */}
          <Section title="Cost Tunables">
            <div className="space-y-3">
              <TunableRow label="Electricity rate" unit="$/kWh" step={0.01}
                value={kwhRate}
                onChange={(v) => { setKwhRate(v); saveSetting(`electricity_rate_${host}`, String(v)); }}
              />
              <TunableRow label="ISP cost" unit="$/mo" step={1}
                value={ispCost}
                onChange={(v) => { setIspCost(v); saveSetting(`isp_cost_${host}`, String(v)); }}
              />
              <TunableRow label="Spinning disks" unit="HDDs" step={1}
                value={diskOverride ?? ''}
                placeholder={String(node?.spinningDisks ?? 0)}
                onChange={(v) => { setDiskOverride(v || undefined); saveSetting(`disk_override_${host}`, String(v)); }}
              />
              <TunableRow label="Watts override" unit="W" step={1}
                value={wattsOverride ?? ''}
                placeholder="auto"
                onChange={(v) => { setWattsOverride(v || undefined); saveSetting(`watts_override_${host}`, String(v)); }}
              />
              <div className="text-xs text-[var(--color-muted)] pt-1">
                Auto-detected: {node?.spinningDisks ?? '?'} HDDs, {node?.ssdCount ?? '?'} SSDs via lsblk
                {node?.cpuTdpWatts && <> &middot; {node.cpuTdpWatts}W CPU TDP</>}
              </div>
            </div>
          </Section>

          {/* GPU */}
          {probe?.gpu?.hasGpu && (
            <Section title="GPU">
              {probe.gpu.nvidia?.map((g: any, i: number) => (
                <div key={i} className="text-sm space-y-1 mb-2">
                  <div className="font-bold">{g.name}</div>
                  <div className="flex gap-4 text-[var(--color-muted)]">
                    <span>{g.memUsed}/{g.memTotal} mem</span>
                    <span>{g.utilization}% util</span>
                    <span>{g.temp}°C</span>
                    <span>{g.power}W</span>
                  </div>
                </div>
              ))}
            </Section>
          )}

          {/* Network */}
          {probe?.network?.interfaces?.length > 0 && (
            <Section title="Network">
              <div className="space-y-1">
                {probe.network.interfaces
                  .filter((i: any) => i.state === 'UP' && !i.name.startsWith('lo') && !i.name.startsWith('veth'))
                  .map((iface: any) => (
                  <div key={iface.name} className="flex items-center gap-3 text-sm">
                    <span className="w-2 h-2 rounded-full bg-green-500" />
                    <span className="font-mono">{iface.name}</span>
                    <span className="text-[var(--color-muted)] text-xs">{iface.addrs}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Containers */}
          {probe?.containers?.length > 0 && (
            <Section title={`Containers (${probe.containers.length})`}>
              <div className="space-y-2">
                {probe.containers.map((c: any) => (
                  <div key={c.id} className="text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-bold">{c.name}</span>
                      <span className="text-xs text-[var(--color-muted)]">{c.status}</span>
                    </div>
                    <div className="text-xs text-[var(--color-muted)]">{c.image}</div>
                    {c.ports && <div className="text-xs text-[var(--color-muted)] font-mono">{c.ports}</div>}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Sessions */}
          {(probe?.sessions?.tmux?.length > 0 || probe?.sessions?.screen?.length > 0) && (
            <Section title="Sessions">
              {probe.sessions.tmux?.map((s: any) => (
                <div key={s.name} className="text-sm">
                  <span className="font-mono">tmux: {s.name}</span>
                  <span className="text-xs text-[var(--color-muted)]"> ({s.windows} windows)</span>
                </div>
              ))}
              {probe.sessions.screen?.map((s: any) => (
                <div key={s.name} className="text-sm">
                  <span className="font-mono">screen: {s.name}</span>
                </div>
              ))}
            </Section>
          )}

          {/* Top Processes */}
          {probe?.processes?.length > 0 && (
            <Section title={`Top Processes (${probe.claudeProcesses ?? 0} claudes)`}>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[var(--color-muted)] text-left">
                      <th className="pb-1 pr-3">USER</th>
                      <th className="pb-1 pr-3 text-right">CPU%</th>
                      <th className="pb-1 pr-3 text-right">MEM%</th>
                      <th className="pb-1 pr-3 text-right">RSS</th>
                      <th className="pb-1">COMMAND</th>
                    </tr>
                  </thead>
                  <tbody>
                    {probe.processes.slice(0, 25).map((p: any, i: number) => (
                      <tr key={i} className="border-t border-[var(--color-border)]">
                        <td className="py-0.5 pr-3 text-[var(--color-muted)]">{p.user}</td>
                        <td className={`py-0.5 pr-3 text-right ${parseFloat(p.cpu) > 50 ? 'text-[var(--color-error)]' : ''}`}>{p.cpu}</td>
                        <td className="py-0.5 pr-3 text-right">{p.mem}</td>
                        <td className="py-0.5 pr-3 text-right text-[var(--color-muted)]">{p.rss}</td>
                        <td className="py-0.5 font-mono truncate max-w-[300px]">{p.command}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
      <h3 className="text-sm font-bold text-[var(--color-muted)] mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="h-2 rounded bg-[var(--color-background)] overflow-hidden">
      <div className="h-full rounded" style={{ width: `${Math.min(pct, 100)}%`, background: color }} />
    </div>
  );
}

function KV({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div>
      <span className="text-[var(--color-muted)]">{label}: </span>
      <span>{value ?? 'n/a'}</span>
    </div>
  );
}

function TunableRow({ label, unit, step, value, placeholder, onChange }: {
  label: string;
  unit: string;
  step: number;
  value: number | string;
  placeholder?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-[var(--color-muted)]">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          step={step}
          min={0}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="w-20 text-sm bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1 font-mono text-right"
        />
        <span className="text-xs text-[var(--color-muted)] w-12">{unit}</span>
      </div>
    </div>
  );
}
