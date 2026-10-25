'use client';

import { GaugeTrack, UTILISATION } from '@unturf/unfirehose-ui/Gauge';
import { humanDelta } from '@unturf/unfirehose/ago';
import { formatBytes } from '@unturf/unfirehose/format';
import { sumOf } from '@unturf/unfirehose/num';
import { unescapeMachineName } from '@/lib/machine-name';
import { Badge, cores, tile, vmMem } from './shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** How a guest's state reads: the tool's own words, coloured like a container's. */
const VM_STATE_COLORS: Record<string, string> = {
  running: '#10b981', paused: '#fbbf24', 'in shutdown': '#fb923c', pmsuspended: '#60a5fa',
  'shut off': '#71717a', 'powered off': '#71717a', crashed: '#f87171', dying: '#f87171', idle: '#60a5fa',
};
const HYPERVISOR_LABEL: Record<string, string> = { qemu: 'QEMU', xen: 'Xen', virtualbox: 'VirtualBox' };

/**
 * Virtual machines on this host: QEMU/KVM, Xen and VirtualBox guests, as the
 * host sees them. A guest is a process here, not a cgroup, so the figures
 * are the hypervisor's -- configured memory and vcpus from its argv or its
 * tool, the host-side cost of the process while it runs. Where machined
 * wraps a libvirt guest in a machine-qemu scope, that scope is already a
 * row in the Containers table below and carries the kernel's view; the VM
 * row points to it. Nothing inside a guest is visible from here.
 *
 * Lives inside the Containers tab rather than as a tab of its own: a guest
 * is a machine's tenant like a container is, the machined scope already put
 * it in this tab, and a tab that appears only on the two hosts that run
 * VMs would move the others' tab strip around.
 */
export function VirtualMachinesSection({ vms, containers, hostCores, hostMemBytes }: {
  vms: any[]; containers: any[]; hostCores: number; hostMemBytes: number;
}) {
  if (!Array.isArray(vms) || vms.length === 0) return null;
  const byId = new Map<string, any>(containers.map((c) => [c.id, c]));
  const rank = (v: any) => v.state === 'running' ? 0 : v.state === 'paused' || v.state === 'in shutdown' ? 1 : 2;
  const ordered = [...vms].sort((a, b) => rank(a) - rank(b) || (b.cpuPct ?? -1) - (a.cpuPct ?? -1) || String(a.name).localeCompare(String(b.name)));
  const running = vms.filter((v) => v.state === 'running');
  const stateCounts = new Map<string, number>();
  for (const v of vms) stateCounts.set(v.state, (stateCounts.get(v.state) ?? 0) + 1);
  const vcpus = sumOf(running, (v) => v.vcpus);
  const memMB = sumOf(running, (v) => v.memMB);
  const hostCpu = sumOf(running, (v) => v.cpuPct ?? byId.get(v.containerId)?.resources?.cpuPct);
  const hostRss = sumOf(running, (v) => v.rssKB != null ? v.rssKB * 1024 : byId.get(v.containerId)?.resources?.memUsed);
  const hvs = [...new Set(vms.map((v) => v.hypervisor))];

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-bold text-[var(--color-muted)] uppercase tracking-wide">
        Virtual Machines ({vms.length})
        <span className="ml-2 font-normal normal-case tracking-normal">{hvs.map((h) => HYPERVISOR_LABEL[h] ?? h).join(' · ')}</span>
      </h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {tile('Guests', String(vms.length), [...stateCounts].map(([k, v]) => `${v} ${k}`).join(' · '))}
        {tile('vCPUs', running.length ? String(vcpus) : '—',
          hostCores ? `${vcpus} of ${cores(hostCores)} host` : 'configured, running guests')}
        {tile('Guest memory', running.length ? vmMem(memMB) : '—',
          hostMemBytes ? `${(memMB * 1_048_576 / hostMemBytes * 100).toFixed(0)}% of ${formatBytes(hostMemBytes)} configured` : 'configured, running guests')}
        {tile('Host CPU', running.length ? `${hostCpu.toFixed(1)}%` : '—',
          hostCores ? `${(hostCpu / hostCores).toFixed(1)}% of ${cores(hostCores)}` : 'of one core = 100%')}
        {tile('Host RSS', running.length && hostRss ? formatBytes(hostRss) : '—', 'what the hypervisor processes hold')}
      </div>

      <div className="overflow-x-auto rounded border border-[var(--color-border)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-[var(--color-muted)] border-b border-[var(--color-border)]">
              <th className="py-1.5 pl-3 pr-3">Guest</th>
              <th className="py-1.5 pr-3 w-24">State</th>
              <th className="py-1.5 pr-3 w-16 text-right">vCPUs</th>
              <th className="py-1.5 pr-3 w-24 text-right">Memory</th>
              <th className="py-1.5 pr-3 w-28 sm:w-40">Host CPU</th>
              <th className="py-1.5 pr-3 w-28 sm:w-40">Host RSS</th>
              <th className="py-1.5 pr-3 hidden md:table-cell">Disks</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((v) => {
              const isRunning = v.state === 'running';
              const color = VM_STATE_COLORS[v.state] ?? '#71717a';
              const cg = v.containerId ? byId.get(v.containerId) : null;
              const cpu: number | null = v.cpuPct ?? cg?.resources?.cpuPct ?? null;
              const rss: number | null = v.rssKB != null ? v.rssKB * 1024 : cg?.resources?.memUsed ?? null;
              const cpuMax = hostCores ? hostCores * 100 : 100;
              const key = `${v.hypervisor}:${v.name}`;
              return (
                <tr key={key} className="border-b border-[var(--color-border)]" style={{ borderLeft: `3px solid ${isRunning ? color : 'transparent'}` }}>
                  <td className="py-1.5 pl-3 pr-3 [overflow-wrap:anywhere]">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold">{v.name}</span>
                      <Badge color="#a78bfa" title={`hypervisor: ${HYPERVISOR_LABEL[v.hypervisor] ?? v.hypervisor}`}>{v.hypervisor}</Badge>
                      {v.accel === 'kvm' && <Badge color="#10b981" title="hardware-accelerated through KVM">kvm</Badge>}
                      {v.accel === 'tcg' && <Badge color="#fbbf24" title="software emulation (TCG), no KVM">tcg</Badge>}
                      {cg && (
                        <a href="#Containers" className="text-[10px] font-mono text-[var(--color-accent)] hover:underline"
                           title={`machined scope ${unescapeMachineName(String(cg.id))} — its kernel-side cpu/mem/tasks are in the table below`}>
                          cgroup ↓
                        </a>
                      )}
                    </div>
                    <div className="text-[10px] font-mono text-[var(--color-muted)]">
                      {[
                        v.pid ? `pid ${v.pid}` : '',
                        v.uuid ? String(v.uuid).slice(0, 8) : '',
                        v.uptimeSeconds != null && isRunning ? `up ${humanDelta(v.uptimeSeconds * 1000)}` : '',
                        Array.isArray(v.sources) && v.sources.length ? `via ${v.sources.join('+')}` : '',
                      ].filter(Boolean).join(' · ')}
                    </div>
                  </td>
                  <td className="py-1.5 pr-3 text-xs" style={{ color }}>{v.state}</td>
                  <td className="py-1.5 pr-3 text-right font-mono text-xs">{v.vcpus ?? '—'}</td>
                  <td className="py-1.5 pr-3 text-right font-mono text-xs">{vmMem(v.memMB)}</td>
                  <td className="py-1.5 pr-3">
                    {isRunning && cpu != null ? (
                      <div className="flex items-center gap-2">
                        <GaugeTrack pct={cpu / cpuMax * 100} thresholds={UTILISATION} className="flex-1 min-w-[40px]" />
                        <span className="font-mono text-xs w-12 text-right shrink-0">{cpu.toFixed(1)}%</span>
                      </div>
                    ) : <span className="text-xs text-[var(--color-muted)]">—</span>}
                  </td>
                  <td className="py-1.5 pr-3">
                    {isRunning && rss != null ? (
                      <div className="flex items-center gap-2">
                        <GaugeTrack pct={hostMemBytes ? rss / hostMemBytes * 100 : 0} thresholds={UTILISATION} className="flex-1 min-w-[40px]" />
                        <span className="font-mono text-xs w-16 text-right shrink-0">{formatBytes(rss)}</span>
                      </div>
                    ) : <span className="text-xs text-[var(--color-muted)]">—</span>}
                  </td>
                  <td className="py-1.5 pr-3 hidden md:table-cell text-[10px] font-mono text-[var(--color-muted)] [overflow-wrap:anywhere]">
                    {Array.isArray(v.disks) && v.disks.length
                      ? v.disks.map((d: string) => <div key={d} title={d}>{d.split('/').pop()}</div>)
                      : <span>—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="text-[10px] text-[var(--color-muted)]">
        Configured memory and vcpus are what each guest was given, not what it uses; host CPU and RSS are the hypervisor process as our host sees it. What runs inside a guest needs a guest agent and is not shown.
      </div>
    </div>
  );
}
