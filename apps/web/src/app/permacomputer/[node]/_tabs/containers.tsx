'use client';

import React from 'react';
import { GaugeTrack, UTILISATION } from '@unturf/unfirehose-ui/Gauge';
import { humanDelta } from '@unturf/unfirehose/ago';
import { formatBytes } from '@unturf/unfirehose/format';
import { Donut } from '@/components/Donut';
import { EmptyState } from '@unturf/unfirehose-ui/EmptyState';
import { Badge, Pressure, ResourceBar, Section, containerStatus, cores, tile, type TabProps } from './shared';
import { VirtualMachinesSection } from './virtual-machines';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * One colour per container, by its position in the probe. The list is the
 * tokens page's tool palette: plain colours, because a canvas cannot read a
 * custom property.
 */
const CONTAINER_COLORS = [
  '#10b981', '#a78bfa', '#60a5fa', '#fbbf24', '#f472b6',
  '#34d399', '#818cf8', '#38bdf8', '#fb923c', '#e879f9',
  '#2dd4bf', '#f87171', '#84cc16', '#22d3ee', '#facc15',
];

/** How a container state reads on the donut. Docker's own words, its own order. */
const STATE_COLORS: Record<string, string> = {
  running: '#10b981', paused: '#fbbf24', restarting: '#fb923c',
  created: '#60a5fa', exited: '#71717a', dead: '#f87171', removing: '#71717a',
};

/**
 * Running first, hottest first among them; the stopped ones after, most
 * recently stopped first. A page of containers is read top-down for what
 * is burning, then for what died.
 */
export function orderContainers<C extends { state?: string; resources?: { cpuPct: number | null } | null; finishedAt?: string | null }>(cs: C[]): C[] {
  const rank = (c: C) => c.state === 'running' ? 0 : c.state === 'paused' || c.state === 'restarting' ? 1 : 2;
  return [...cs].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (rank(a) === 0) return (b.resources?.cpuPct ?? -1) - (a.resources?.cpuPct ?? -1);
    return Date.parse(b.finishedAt ?? '') - Date.parse(a.finishedAt ?? '') || 0;
  });
}

/**
 * The Containers tab: every container the runtime lists, what our host
 * kernel says each is spending, and its process tree in host pids.
 *
 * The figures come from cgroups, not from `docker stats`: the same bytes
 * and ticks the runtime would report, read from where the runtime reads
 * them, minus the two seconds it spends doing so. A probe from a worker
 * that predates that section lists the containers and says the rest is
 * missing rather than drawing empty bars.
 */
export function ContainersTab(props: TabProps) {
  const { probe, sys, mem } = props;
  const raw = probe?.containers;
  const all: any[] = React.useMemo(() => Array.isArray(raw) ? raw : [], [raw]);
  const vms: any[] = Array.isArray(probe?.vms) ? probe.vms : [];
  const containers = React.useMemo(() => orderContainers(all), [all]);
  // A node can run hundreds of containers (cammy: ~395 LXD guests). Rows are
  // collapsed by default -- opening one shows its bars, pressure, io and
  // process tree. A search, a runtime filter and a sort keep the list
  // navigable, and only a bounded slice renders until "show all" is asked.
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());
  const [query, setQuery] = React.useState('');
  const [runtimeFilter, setRuntimeFilter] = React.useState('all');
  const [sort, setSort] = React.useState<'cpu' | 'mem' | 'tasks' | 'name'>('cpu');
  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const hostCores: number = sys?.cpuCores > 0 ? sys.cpuCores : 0;
  const hostMemBytes: number = mem?.totalGB > 0 ? mem.totalGB * 1_073_741_824 : 0;
  const hasResources = all.some((c) => c.resources);
  const running = containers.filter((c) => c.state === 'running');

  // Runtimes present, for the filter chips. docker is the unlabelled default.
  const runtimeCounts = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const c of all) { const k = c.runtime || 'docker'; m.set(k, (m.get(k) ?? 0) + 1); }
    return m;
  }, [all]);

  // Filter by runtime and free text, then sort -- running first always, then
  // by the chosen key (cpu/mem/tasks desc, name asc). A container without live
  // stats sorts below one that has them.
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = containers;
    if (runtimeFilter !== 'all') list = list.filter((c) => (c.runtime || 'docker') === runtimeFilter);
    if (q) list = list.filter((c) =>
      (c.name || '').toLowerCase().includes(q) ||
      String(c.id).toLowerCase().includes(q) ||
      (c.image || '').toLowerCase().includes(q) ||
      (c.rootComm || '').toLowerCase().includes(q));
    const val = (c: any) => sort === 'mem' ? (c.resources?.memUsed ?? -1)
      : sort === 'tasks' ? (c.resources?.tasks ?? -1)
      : (c.resources?.cpuPct ?? -1);
    const rank = (c: any) => c.state === 'running' ? 0 : 1;
    return [...list].sort((a, b) =>
      rank(a) - rank(b) ||
      (sort === 'name' ? String(a.name).localeCompare(String(b.name)) : val(b) - val(a)));
  }, [containers, runtimeFilter, query, sort]);

  if (all.length === 0) {
    return (
      <div className="space-y-6">
        <VirtualMachinesSection vms={vms} containers={[]} hostCores={hostCores} hostMemBytes={hostMemBytes} />
        {probe ? (
          <EmptyState
            what="No containers on this node. Docker, Podman and LXD guests appear here with their cpu, memory and pressure."
            action="Start one and the next probe, within 30s, lists it."
          />
        ) : (
          <EmptyState
            what="No probe data available. This node's containers, processes and harnesses appear here once a probe answers."
            action="Probes run over SSH; check this node answers from our shell."
            command="ssh <host> true"
          />
        )}
      </div>
    );
  }

  // Totals across the running set, for the strip and the share donuts.
  const totalCpu = running.reduce((s, c) => s + (c.resources?.cpuPct ?? 0), 0);
  const totalMem = running.reduce((s, c) => s + (c.resources?.memUsed ?? 0), 0);
  const totalTasks = running.reduce((s, c) => s + (c.resources?.tasks ?? 0), 0);
  const totalProcs = running.reduce((s, c) => s + (c.processes?.length ?? 0), 0);
  const colorOf = new Map<string, string>(all.map((c, i) => [c.id, CONTAINER_COLORS[i % CONTAINER_COLORS.length]]));

  const stateCounts = new Map<string, number>();
  for (const c of all) {
    const k = c.state ?? (/^Up\b/.test(c.status ?? '') ? 'running' : 'other');
    stateCounts.set(k, (stateCounts.get(k) ?? 0) + 1);
  }
  const stateShares = [...stateCounts].map(([name, value]) => ({ name, value, color: STATE_COLORS[name] ?? '#71717a' }));
  const cpuShares = running.map((c) => ({ name: c.name, value: c.resources?.cpuPct ?? 0, color: colorOf.get(c.id)! }));
  const memShares = running.map((c) => ({ name: c.name, value: c.resources?.memUsed ?? 0, color: colorOf.get(c.id)! }));

  const openCount = filtered.reduce((n, c) => n + (expanded.has(c.id) ? 1 : 0), 0);
  const anyOpen = openCount > 0;

  return (
    <div className="space-y-6">
      <VirtualMachinesSection vms={vms} containers={all} hostCores={hostCores} hostMemBytes={hostMemBytes} />
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {tile('Containers', String(all.length), [...stateCounts].map(([k, v]) => `${v} ${k}`).join(' · '))}
        {tile('CPU', hasResources ? `${totalCpu.toFixed(1)}%` : '—',
          hostCores ? `${(totalCpu / hostCores).toFixed(1)}% of ${cores(hostCores)}` : 'of one core = 100%')}
        {tile('Memory', hasResources ? formatBytes(totalMem) : '—',
          hostMemBytes ? `${(totalMem / hostMemBytes * 100).toFixed(1)}% of ${formatBytes(hostMemBytes)}` : undefined)}
        {tile('Tasks', hasResources ? String(totalTasks) : '—', 'threads and processes')}
        {tile('Processes', hasResources ? String(totalProcs) : '—', 'as our host lists them')}
        {tile('Restarts', String(all.reduce((s, c) => s + (c.restartCount ?? 0), 0)),
          all.some((c) => c.oomKilled) ? 'OOM killed: ' + all.filter((c) => c.oomKilled).map((c) => c.name).join(', ') : 'no OOM kills')}
      </div>

      {!hasResources && (
        <div className="text-xs text-[var(--color-muted)] border border-[var(--color-border)] rounded px-3 py-2">
          Kernel-side resources are missing from this probe — it predates the cgroup section, or this host keeps its cgroups somewhere our probe did not look. States and images still come from the runtime.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Section title="State">
          <Donut data={stateShares} format={(v) => `${v}`} height={150} inner={0.6} />
        </Section>
        <Section title="CPU share">
          {cpuShares.some((s) => s.value > 0)
            ? <Donut data={cpuShares} format={(v) => `${v.toFixed(1)}%`} height={150} inner={0.6} />
            : <EmptyState compact what="Nothing running is using cpu." action="Each running container's share appears here." />}
        </Section>
        <Section title="Memory share">
          {memShares.some((s) => s.value > 0)
            ? <Donut data={memShares} format={formatBytes} height={150} inner={0.6} />
            : <EmptyState compact what="Nothing running holds memory." action="Each running container's share appears here." />}
        </Section>
      </div>

      {/* Filter bar: search, runtime chips, sort. */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${all.length} containers…`}
          className="flex-1 min-w-[180px] bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1 text-sm font-mono focus:border-[var(--color-accent)] outline-none"
        />
        <div className="flex items-center gap-1 text-xs font-mono">
          {['all', ...runtimeCounts.keys()].map((rt) => (
            <button
              key={rt}
              type="button"
              onClick={() => setRuntimeFilter(rt)}
              className={`px-2 py-1 rounded border ${runtimeFilter === rt
                ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)]'}`}
            >
              {rt}{rt !== 'all' && ` ${runtimeCounts.get(rt)}`}
            </button>
          ))}
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          className="bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1 text-xs font-mono outline-none"
          title="Sort running containers by"
        >
          <option value="cpu">sort: CPU</option>
          <option value="mem">sort: memory</option>
          <option value="tasks">sort: tasks</option>
          <option value="name">sort: name</option>
        </select>
        {/* One toggle: opens every row the filter shows, or closes every open
            row. A node with hundreds of containers is otherwise a click per
            row each way. */}
        <button
          type="button"
          onClick={() => setExpanded(anyOpen ? new Set() : new Set(filtered.map((c) => c.id)))}
          className="px-2 py-1 rounded border border-[var(--color-border)] text-xs font-mono text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
          title={anyOpen ? `Close ${openCount} open row${openCount === 1 ? '' : 's'}` : `Open all ${filtered.length} shown`}
        >
          {anyOpen ? `close all (${openCount})` : `open all (${filtered.length})`}
        </button>
      </div>

      {/* Compact table. A row expands to its bars, pressure, io and process tree.
          Fixed layout on purpose: an expanded row's process tree shows every
          command whole, and in an auto-layout table that width leaks up into
          the cell, the table, and the wrapper -- the whole table then scrolls
          sideways and the CPU bar leaves the screen. With fixed columns the
          tree scrolls inside its own box and the bars stay put; a long
          container name wraps instead of pushing them. */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)]">
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-[var(--color-muted)] text-left border-b border-[var(--color-border)]">
              <th className="py-1.5 pl-3 pr-2 w-5"></th>
              <th className="py-1.5 pr-3">Container</th>
              <th className="py-1.5 pr-3 w-24 hidden sm:table-cell">State</th>
              <th className="py-1.5 pr-3 w-28 sm:w-40">CPU</th>
              <th className="py-1.5 pr-3 w-32 sm:w-40">Memory</th>
              <th className="py-1.5 pr-3 w-16 text-right hidden md:table-cell">Tasks</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const r = c.resources ?? null;
              const { label, title } = containerStatus(c);
              const color = colorOf.get(c.id)!;
              const procs: any[] = Array.isArray(c.processes) ? c.processes : [];
              const isRunning = c.state === 'running';
              const cpuCap = r?.cpuQuota ?? c.cpuLimit ?? null;
              const cpuMaxPct = cpuCap ? cpuCap * 100 : hostCores ? hostCores * 100 : 100;
              const memCap = r?.memLimit ?? c.memLimit ?? null;
              const memMax = memCap ?? hostMemBytes ?? 0;
              const taskCap = r?.tasksMax ?? c.pidsLimit ?? null;
              const open = expanded.has(c.id);
              const hurt = c.oomKilled || (r?.oomKills ?? 0) > 0 || (r?.cpuThrottled ?? 0) > 0;
              return (
                <React.Fragment key={c.id}>
                  <tr
                    onClick={() => toggle(c.id)}
                    className="border-b border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-background)]/40"
                    style={{ borderLeft: `3px solid ${isRunning ? color : 'transparent'}` }}
                  >
                    <td className="py-1.5 pl-3 pr-2 text-[var(--color-muted)] font-mono">{open ? '▾' : '▸'}</td>
                    <td className="py-1.5 pr-3 [overflow-wrap:anywhere]">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold">{c.name}</span>
                        {c.runtime && c.runtime !== 'docker' && <Badge color="#60a5fa" title={`runtime: ${c.runtime}`}>{c.runtime}</Badge>}
                        {c.health && <Badge color={c.health === 'healthy' ? '#10b981' : c.health === 'unhealthy' ? '#ef4444' : '#eab308'}>{c.health}</Badge>}
                        {hurt && <Badge color="#ef4444" title="OOM killed, out-of-memory kills inside, or cpu throttling — expand for detail">!</Badge>}
                        <span className="text-[10px] font-mono text-[var(--color-muted)]" title={c.image || (c.rootComm ? `runs ${c.rootComm}` : '')}>
                          {c.image || (c.rootComm ? `runs ${c.rootComm}` : String(c.id).slice(0, 12))}
                        </span>
                      </div>
                    </td>
                    <td className="py-1.5 pr-3 hidden sm:table-cell text-xs text-[var(--color-muted)]" title={title}>{label}</td>
                    <td className="py-1.5 pr-3">
                      {isRunning && r?.cpuPct != null ? (
                        <div className="flex items-center gap-2">
                          <GaugeTrack pct={r.cpuPct / cpuMaxPct * 100} thresholds={UTILISATION} className="flex-1 min-w-[40px]" />
                          <span className="font-mono text-xs w-12 text-right shrink-0">{r.cpuPct.toFixed(1)}%</span>
                        </div>
                      ) : <span className="text-xs text-[var(--color-muted)]">—</span>}
                    </td>
                    <td className="py-1.5 pr-3">
                      {isRunning && r?.memUsed != null ? (
                        <div className="flex items-center gap-2">
                          <GaugeTrack pct={memMax ? r.memUsed / memMax * 100 : 0} thresholds={UTILISATION} className="flex-1 min-w-[40px]" />
                          <span className="font-mono text-xs w-16 text-right shrink-0">{formatBytes(r.memUsed)}</span>
                        </div>
                      ) : <span className="text-xs text-[var(--color-muted)]">—</span>}
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono text-xs hidden md:table-cell">{r?.tasks ?? (isRunning ? '' : '—')}</td>
                  </tr>
                  {open && (
                    <tr className="border-b border-[var(--color-border)] bg-[var(--color-background)]/30">
                      <td></td>
                      <td colSpan={5} className="py-3 pr-4 [overflow-wrap:anywhere]">
                        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-[var(--color-muted)] font-mono mb-3">
                          <span title="container id">{String(c.id).slice(0, 12)}</span>
                          {c.pid ? <span title="the container's init, as our host numbers it">host pid {c.pid}</span> : null}
                          {c.viaCgroup && <span title="Found through the cgroup filesystem, not the docker socket — name, image, ports, health and uptime are unavailable. Resources and processes are read straight from the kernel.">via cgroup</span>}
                          {c.ports && <span>{c.ports}</span>}
                          {(r?.cpuset ?? c.cpuset) && <span title="cpuset.cpus.effective">cpus {r?.cpuset ?? c.cpuset}</span>}
                          {c.oomKilled && <span className="text-[var(--color-error)]">OOM killed</span>}
                          {c.restartCount > 0 && <span className="text-[#fb923c]">{c.restartCount} restart{c.restartCount === 1 ? '' : 's'}</span>}
                          {r?.oomKills != null && r.oomKills > 0 && <span className="text-[var(--color-error)]" title="memory.events oom_kill">{r.oomKills} oom kill{r.oomKills === 1 ? '' : 's'}</span>}
                          {r?.cpuThrottled != null && r.cpuThrottled > 0 && <span className="text-[#eab308]" title={`cpu.stat: ${r.cpuThrottled} periods throttled, ${humanDelta((r.cpuThrottledUsec ?? 0) / 1000, { abbreviate: true })} in all`}>throttled ×{r.cpuThrottled}</span>}
                          {!isRunning && c.exitCode != null && c.exitCode !== 0 && <span className="text-[var(--color-error)]">exit code {c.exitCode}</span>}
                        </div>

                        {isRunning && r ? (
                          <>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                              <ResourceBar label="CPU" pct={r.cpuPct == null ? null : r.cpuPct / cpuMaxPct * 100}
                                value={r.cpuPct == null ? '—' : `${r.cpuPct.toFixed(1)}%`}
                                ceiling={cpuCap ? `of ${cores(cpuCap)} (quota)` : hostCores ? `of ${cores(hostCores)}, no quota` : 'no quota'} thresholds={UTILISATION} />
                              <ResourceBar label="Memory" pct={r.memUsed == null || !memMax ? null : r.memUsed / memMax * 100}
                                value={r.memUsed == null ? '—' : formatBytes(r.memUsed)}
                                ceiling={[
                                  memCap ? `of ${formatBytes(memCap)} limit` : hostMemBytes ? `of ${formatBytes(hostMemBytes)} host, no limit` : 'no limit',
                                  r.memPeak != null ? `peak ${formatBytes(r.memPeak)}` : '',
                                  r.swapUsed ? `swap ${formatBytes(r.swapUsed)}` : '',
                                ].filter(Boolean).join(' · ')} thresholds={UTILISATION} />
                              <ResourceBar label="Tasks" pct={r.tasks == null || !taskCap ? null : r.tasks / taskCap * 100}
                                value={r.tasks == null ? '—' : `${r.tasks}`}
                                ceiling={taskCap ? `of ${taskCap} pids.max` : `${procs.length} processes, no pids limit`} thresholds={UTILISATION} />
                            </div>
                            <div className="flex flex-wrap gap-x-6 gap-y-1 items-center mt-2">
                              <Pressure psi={r.psi} />
                              <span className="text-xs font-mono text-[var(--color-muted)]" title="io.stat, since the container started">
                                io {r.ioRead == null ? '—' : `${formatBytes(r.ioRead)} read`} / {r.ioWrite == null ? '—' : `${formatBytes(r.ioWrite)} written`}
                              </span>
                              {r.memAnon != null && r.memFile != null && (
                                <span className="text-xs font-mono text-[var(--color-muted)]" title="memory.stat anon / file">anon {formatBytes(r.memAnon)} · file {formatBytes(r.memFile)}</span>
                              )}
                            </div>
                            <div className="overflow-x-auto mt-3">
                              <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)] mb-1">{procs.length} process{procs.length === 1 ? '' : 'es'} · host pids</div>
                              {procs.length > 0 ? (
                                <table className="w-full text-xs font-mono whitespace-nowrap">
                                  <thead>
                                    <tr className="text-[var(--color-muted)] text-left">
                                      <th className="pb-1 pr-3 text-right">PID</th>
                                      <th className="pb-1 pr-3 text-right">PPID</th>
                                      <th className="pb-1 pr-3">USER</th>
                                      <th className="pb-1 pr-3 text-right">CPU%</th>
                                      <th className="pb-1 pr-3 text-right">MEM%</th>
                                      <th className="pb-1 pr-3 text-right">RSS</th>
                                      <th className="pb-1 pr-3 text-right">AGE</th>
                                      <th className="pb-1">CMD</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {procs.map((p: any) => (
                                      <tr key={p.pid} className="border-t border-[var(--color-border)]">
                                        <td className="py-0.5 pr-3 text-right">{p.pid}</td>
                                        <td className="py-0.5 pr-3 text-right text-[var(--color-muted)]">{p.ppid}</td>
                                        <td className="py-0.5 pr-3 text-[var(--color-muted)]">{p.user}</td>
                                        <td className={`py-0.5 pr-3 text-right ${p.cpu > 50 ? 'text-[var(--color-error)]' : ''}`}>{p.cpu.toFixed(1)}</td>
                                        <td className="py-0.5 pr-3 text-right">{p.mem.toFixed(1)}</td>
                                        <td className="py-0.5 pr-3 text-right text-[var(--color-muted)]">{formatBytes(p.rss * 1024)}</td>
                                        <td className="py-0.5 pr-3 text-right text-[var(--color-muted)]">{p.elapsed == null ? '' : humanDelta(p.elapsed * 1000, { abbreviate: true, smallest: 'second' })}</td>
                                        <td className="py-0.5" style={{ paddingLeft: `${p.depth * 1.25}rem` }}>
                                          {p.depth > 0 && <span className="text-[var(--color-muted)]">└ </span>}
                                          <span>{p.cmd}</span>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              ) : <div className="text-xs text-[var(--color-muted)]">The cgroup lists no host pids ps could find.</div>}
                            </div>
                          </>
                        ) : isRunning && hasResources ? (
                          <div className="text-xs text-[var(--color-muted)]">Live resources were not computed for this container (beyond the per-probe stats cap). Its state, runtime and id are above.</div>
                        ) : null}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="text-center text-xs text-[var(--color-muted)] font-mono">
        {filtered.length === all.length ? `${filtered.length} containers` : `${filtered.length} of ${all.length} match`}
      </div>
    </div>
  );
}
