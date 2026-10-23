'use client';

import React from 'react';
import { Section, type TabProps } from './shared';
import { EmptyState } from '@unturf/unfirehose-ui/EmptyState';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** How the Processes tab lays out the table. Tree is `ps -ejH`. */
type ProcessView = 'tree' | 'top';

/** The Processes tab. Defaults to the `ps -ejH` hierarchy. */
export function ProcessesTab(props: TabProps) {
  const { probe } = props;
  const [view, setView] = React.useState<ProcessView>('tree');
  const tree: any[] = Array.isArray(probe?.processTree) ? probe.processTree : [];
  const top: any[] = Array.isArray(probe?.processes) ? probe.processes : [];

  // `ps -ejH` carries no cpu/mem; the CPU-sorted list does, for the top 50.
  // Join by pid so a hot process reads hot in the tree too.
  const usageByPid = React.useMemo(() => {
    const m = new Map<number, any>();
    for (const p of top) m.set(p.pid, p);
    return m;
  }, [top]);
  // Agent harness pids get a marker — the tree exists to show which shell
  // under which tmux server owns which agent.
  const agentPids = React.useMemo(() => {
    const procs: any[] = Array.isArray(probe?.harnessProcesses)
      ? probe.harnessProcesses
      : Array.isArray(probe?.claudeProcesses) ? probe.claudeProcesses : [];
    return new Set<number>(procs.map((p: any) => p.pid));
  }, [probe]);

  const agentCount = Array.isArray(probe?.harnessProcesses)
    ? probe.harnessProcesses.length
    : Array.isArray(probe?.claudeProcesses) ? probe.claudeProcesses.length : probe?.claudeProcesses ?? 0;

  // A probe from before PS_TREE shipped has only the top list; show that
  // rather than an empty tree.
  const effectiveView: ProcessView = view === 'tree' && tree.length === 0 && top.length > 0 ? 'top' : view;
  const hasAny = tree.length > 0 || top.length > 0;

  const toggle = (
    <span className="flex items-center gap-1 text-xs font-normal normal-case tracking-normal">
      {(['tree', 'top'] as ProcessView[]).map(v => (
        <button
          key={v}
          type="button"
          onClick={() => setView(v)}
          disabled={v === 'tree' ? tree.length === 0 : top.length === 0}
          className={`px-2 py-0.5 rounded border font-mono ${
            effectiveView === v
              ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
              : 'border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)] disabled:opacity-40'
          }`}
        >
          {v === 'tree' ? 'ps -ejH' : 'ps aux --sort=-%cpu'}
        </button>
      ))}
    </span>
  );

  return (
      <div className="space-y-6">
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

        {!hasAny ? (
          <EmptyState
            what="No process data available. This node's process tree and its busiest processes appear here, agents marked."
            action="The next probe over SSH fills it, within 30s; a node that refuses ps shows none."
          />
        ) : effectiveView === 'tree' ? (
          <Section title={<span className="flex items-center justify-between gap-3"><span>Process Tree ({tree.length} processes, {agentCount} agents)</span>{toggle}</span>}>
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono whitespace-nowrap">
                <thead>
                  <tr className="text-[var(--color-muted)] text-left">
                    <th className="pb-1 pr-3 text-right">PID</th>
                    <th className="pb-1 pr-3 text-right">PGID</th>
                    <th className="pb-1 pr-3 text-right">SID</th>
                    <th className="pb-1 pr-3">TTY</th>
                    <th className="pb-1 pr-3 text-right">TIME</th>
                    <th className="pb-1 pr-3 text-right">CPU%</th>
                    <th className="pb-1 pr-3 text-right">MEM%</th>
                    <th className="pb-1">CMD</th>
                  </tr>
                </thead>
                <tbody>
                  {tree.map((p: any) => {
                    const u = usageByPid.get(p.pid);
                    const agent = agentPids.has(p.pid);
                    return (
                      <tr key={p.pid} className={`border-t border-[var(--color-border)] ${agent ? 'text-[var(--color-tool)]' : ''}`}>
                        <td className="py-0.5 pr-3 text-right">{p.pid}</td>
                        <td className="py-0.5 pr-3 text-right text-[var(--color-muted)]">{p.pgid}</td>
                        <td className="py-0.5 pr-3 text-right text-[var(--color-muted)]">{p.sid}</td>
                        <td className="py-0.5 pr-3 text-[var(--color-muted)]">{p.tty}</td>
                        <td className="py-0.5 pr-3 text-right text-[var(--color-muted)]">{p.time}</td>
                        <td className={`py-0.5 pr-3 text-right ${u && parseFloat(u.cpu) > 50 ? 'text-[var(--color-error)]' : ''}`}>{u ? u.cpu : ''}</td>
                        <td className="py-0.5 pr-3 text-right">{u ? u.mem : ''}</td>
                        <td className="py-0.5" style={{ paddingLeft: `${p.depth * 1.25}rem` }}>
                          {p.depth > 0 && <span className="text-[var(--color-muted)]">└ </span>}
                          {p.cmd}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>
        ) : (
          <Section title={<span className="flex items-center justify-between gap-3"><span>Processes ({top.length}, {agentCount} agents)</span>{toggle}</span>}>
            <div className="overflow-x-auto">
              <table className="w-full text-xs whitespace-nowrap">
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
                  {top.map((p: any, i: number) => (
                    <tr key={i} className="border-t border-[var(--color-border)]">
                      <td className="py-0.5 pr-3 text-[var(--color-muted)]">{p.user}</td>
                      <td className={`py-0.5 pr-3 text-right ${parseFloat(p.cpu) > 50 ? 'text-[var(--color-error)]' : ''}`}>{p.cpu}</td>
                      <td className="py-0.5 pr-3 text-right">{p.mem}</td>
                      <td className="py-0.5 pr-3 text-right text-[var(--color-muted)]">{p.rss}</td>
                      <td className="py-0.5 font-mono">{p.command}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}
      </div>
  );
}
