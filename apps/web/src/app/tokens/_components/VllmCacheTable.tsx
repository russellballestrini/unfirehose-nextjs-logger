import { formatTokens } from '@unturf/unfirehose/format';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Measured prefix cache — the number our token accounting cannot see.
 * A self-hosted model reports no cache_read tokens, so the cache hit stat
 * reads 0% for it however well the cache is working. vLLM counts the
 * real thing per model.
 */
export function VllmCacheTable({ vllmModels }: { vllmModels: any[] }) {
  if (vllmModels.length === 0) return null;
  return (
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-4">
        <h2 className="text-sm font-bold text-[var(--color-muted)] uppercase tracking-wide mb-1">
          Prefix cache — measured on our own hardware
        </h2>
        <p className="text-xs text-[var(--color-muted)] mb-3">
          vLLM counts prompt tokens looked up and served from cache. The stat
          above is computed from billed usage fields, which self-hosted models
          do not report — this is what actually happened.
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[var(--color-muted)] text-left">
              <th className="pb-2">Node</th>
              <th className="pb-2">Model</th>
              <th className="pb-2 text-right" title="Over the last 24h of samples — whether caching is working now.">24h</th>
              <th className="pb-2 text-right" title="Since the engine started. Answers a different question: has it ever.">Lifetime</th>
              <th className="pb-2 text-right" title="Prompt tokens looked up in the cache, lifetime.">Queries</th>
              <th className="pb-2 text-right" title="KV cache utilization at the last sample — a gauge, not a rate.">KV</th>
            </tr>
          </thead>
          <tbody>
            {vllmModels.map((m: any, i: number) => (
              <tr key={i} className="border-t border-[var(--color-border)]">
                <td className="py-1.5 font-mono text-[var(--color-muted)]">{m.hostname}</td>
                <td className="py-1.5 font-mono">
                  {m.model}
                  {m.prefixCachingEnabled === false && (
                    <span className="ml-2 text-[var(--color-error)]" title="vLLM reports prefix caching is disabled on this engine.">
                      caching off
                    </span>
                  )}
                </td>
                <td className="py-1.5 text-right font-bold">
                  {m.windowHitRate == null
                    ? <span className="text-[var(--color-muted)]" title="No prompt tokens queried in this window.">idle</span>
                    : `${(m.windowHitRate * 100).toFixed(1)}%`}
                </td>
                <td className="py-1.5 text-right text-[var(--color-muted)]">
                  {m.lifetimeHitRate == null ? '—' : `${(m.lifetimeHitRate * 100).toFixed(1)}%`}
                </td>
                <td className="py-1.5 text-right text-[var(--color-muted)]">
                  {formatTokens(m.lifetimeQueries)}
                </td>
                <td className="py-1.5 text-right text-[var(--color-muted)]">
                  {m.kvUsage == null ? '—' : `${(m.kvUsage * 100).toFixed(0)}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
  );
}
