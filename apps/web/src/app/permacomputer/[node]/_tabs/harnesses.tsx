'use client';

import Link from 'next/link';
import { ansiToHtml } from '@unturf/unfirehose-ui/ansi';
import type { TabProps } from './shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The Harnesses tab: tmux sessions and bare agent processes. */
export function HarnessesTab(props: TabProps) {
  const {
    host,
    isLocal,
    mem,
    node,
    previewContent,
    previewRef,
    previewSession,
    probe,
    setPreviewSession,
    tmuxData,
    tailPath,
    setTailPath,
    tailContent,
    tailReady,
    tailRef,
  } = props;
      // tmuxData comes from /api/tmux/stream (with host param for remote)
      const sessions: string[] = tmuxData?.sessions ?? [];
      const tmuxEntries = sessions.map((s: string) => ({ name: s, type: 'tmux' as const }));

      // Bare agent processes (not in tmux) from probe data. Was
      // claudeProcesses only, so a node running five uncloseai-cli agents
      // showed "Bare Processes (0)" — uncloseai-cli runs as python3 and never
      // matched. harnessProcesses carries every harness; fall back for probes
      // captured before it existed.
      const claudeProcs: any[] = Array.isArray(probe?.harnessProcesses)
        ? probe.harnessProcesses
        : Array.isArray(probe?.claudeProcesses) ? probe.claudeProcesses : [];
      const bareEntries = claudeProcs.map((p: any) => ({
        name: `${p.harness ?? 'claude'} (PID ${p.pid})`,
        type: 'process' as const,
        pid: p.pid,
        tty: p.tty,
        cpu: p.cpu,
        mem: p.mem,
        start: p.start,
        command: (p.command ?? '').slice(0, 120),
        // The JSONL this process is writing, tied host-side by the probe.
        // Present for an agent whose session file we could see; absent for
        // one in a container namespace, or an older probe.
        session: p.session ?? null,
        cwd: p.cwd ?? null,
      }));

      const allEntries = [...tmuxEntries, ...bareEntries];

      return (
        <div className="space-y-4">
          {allEntries.length === 0 && (
            <div className="text-sm text-[var(--color-muted)] text-center py-8 bg-[var(--color-surface)] rounded border border-[var(--color-border)]">
              No harnesses running on {host}.
            </div>
          )}

          {tmuxEntries.length > 0 && (
            <div className="grid grid-cols-1 gap-3">
              <h3 className="text-xs font-bold text-[var(--color-muted)] uppercase tracking-wide">Tmux Sessions ({tmuxEntries.length})</h3>
              {tmuxEntries.map(s => {
                const isActive = previewSession === s.name;

                return (
                  <div
                    key={s.name}
                    onClick={() => setPreviewSession(isActive ? null : s.name)}
                    className={`bg-[var(--color-surface)] rounded border p-4 transition-colors cursor-pointer ${
                      isActive ? 'border-[var(--color-accent)]' :
                      'border-[var(--color-border)] hover:border-[var(--color-accent)]/50'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                        <span className="font-bold font-mono text-sm">{s.name}</span>
                      </div>
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        {isLocal && (
                          <Link
                            href={`/tmux/${encodeURIComponent(s.name)}`}
                            className="text-xs px-2 py-1 rounded bg-[var(--color-accent)] text-[var(--color-background)] font-bold hover:opacity-90 transition-opacity"
                          >
                            Full View
                          </Link>
                        )}
                        {!isLocal && (
                          <>
                            <Link
                              href={`/tmux/${encodeURIComponent(s.name)}?host=${encodeURIComponent(host)}`}
                              className="text-xs px-2 py-1 rounded bg-[var(--color-accent)] text-[var(--color-background)] font-bold hover:opacity-90 transition-opacity"
                            >
                              Watch
                            </Link>
                            <span className="text-xs text-[var(--color-muted)] font-mono">
                              ssh {host} -t tmux attach -t {s.name}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Inline preview — shown when card is clicked */}
                    {isActive && (
                      <pre
                        ref={previewRef}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-3 bg-[#0d0d0d] rounded border border-[var(--color-border)] p-3 overflow-auto max-h-[60vh] font-mono text-xs leading-relaxed text-[#d4d4d4] whitespace-pre"
                        dangerouslySetInnerHTML={{ __html: previewContent ? ansiToHtml(previewContent) : 'Connecting...' }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {bareEntries.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-bold text-[var(--color-muted)] uppercase tracking-wide">Bare Processes ({bareEntries.length})</h3>
              <div className="grid grid-cols-1 gap-2">
                {bareEntries.map(p => {
                  const path = p.session?.path ?? null;
                  const isActive = path != null && tailPath === path;
                  const clickable = path != null;
                  return (
                  <div
                    key={p.pid}
                    onClick={clickable ? () => setTailPath(isActive ? null : path) : undefined}
                    className={`bg-[var(--color-surface)] rounded border p-3 transition-colors ${
                      isActive ? 'border-[var(--color-accent)]' :
                      clickable ? 'border-[var(--color-border)] hover:border-[var(--color-accent)]/50 cursor-pointer' :
                      'border-[var(--color-border)]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse shrink-0" />
                        <span className="font-bold font-mono text-sm shrink-0">{p.name}</span>
                        {p.session && (
                          <span
                            className="text-xs font-mono text-[var(--color-muted)] truncate"
                            title={`${p.session.harness} · ${p.session.sessionId}${p.session.matched === 'nearest' ? ' (best guess — nothing written since it started)' : ''}`}
                          >
                            {p.session.sessionId.slice(0, 8)}{p.session.matched === 'nearest' ? '?' : ''}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-[var(--color-muted)] shrink-0">
                        {p.tty && <span>TTY {p.tty}</span>}
                        <span>CPU {p.cpu}%</span>
                        <span>MEM {p.mem}%</span>
                        {clickable && (
                          <span className="text-[var(--color-accent)] font-bold">{isActive ? 'Hide tail' : 'Tail ▸'}</span>
                        )}
                      </div>
                    </div>
                    {p.command && (
                      <div className="mt-1 text-xs font-mono text-[var(--color-muted)] truncate">{p.command}</div>
                    )}
                    {isActive && (
                      <pre
                        ref={tailRef}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-3 bg-[#0d0d0d] rounded border border-[var(--color-border)] p-3 overflow-auto max-h-[60vh] font-mono text-xs leading-relaxed text-[#d4d4d4] whitespace-pre-wrap break-words"
                      >{!tailReady ? 'Connecting…' : (tailContent || 'No output in this session yet.')}</pre>
                    )}
                  </div>
                  );
                })}
              </div>
            </div>
          )}

          {allEntries.length > 0 && (
            <p className="text-xs text-[var(--color-muted)]">
              {tmuxEntries.length > 0 && <>Click a tmux session to preview live output. {isLocal ? 'Full View' : 'Watch'} opens the interactive terminal viewer. </>}
              {bareEntries.length > 0 && <>Yellow dots are agents running outside tmux. Click one with a session id to tail the JSONL it is writing.</>}
            </p>
          )}
        </div>
      );
}
