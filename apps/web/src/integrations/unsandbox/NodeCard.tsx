'use client';

import useSWR from 'swr';
import Link from 'next/link';
import { GaugeRow } from '@unturf/unfirehose-ui/Gauge';
import { nodeVitals, estimateContainerWatts } from '@/lib/node-vitals';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================================
// Unsandbox Node Card
// ============================================================

/** What a cloud container reports about itself, once it has been probed. */
export function UnsandboxProbeBody({ probe, status }: { probe: any; status: any }) {
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
export function UnsandboxServiceBody({ service, status, running }: { service: any; status: any; running: boolean }) {
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

export function UnsandboxNodeCard({ status, service }: { status: any; service?: any }) {
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
