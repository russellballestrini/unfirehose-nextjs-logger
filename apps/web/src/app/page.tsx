'use client';

import { fetcher } from '@unturf/unfirehose-ui/fetcher';

import Link from 'next/link';

import useSWR from 'swr';
import { BootScreen } from '@unturf/unfirehose-ui/BootScreen';
import { getModelColor } from '@unturf/unfirehose-ui/modelColor';
import dynamic from 'next/dynamic';

// The charts arrive after the numbers. recharts is 326KB and used to sit in
// front of the first paint of every card on this page; see DashboardCharts.
function ChartSkeleton({ h }: { h: number }) {
  return <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 animate-pulse" style={{ height: h }} />;
}
const DashboardCharts = dynamic(() => import('./DashboardCharts').then((m) => m.DashboardCharts), {
  ssr: false,
  loading: () => (
    <>
      <div className="grid grid-cols-2 gap-4"><ChartSkeleton h={260} /><ChartSkeleton h={260} /></div>
      <div className="grid grid-cols-2 gap-4"><ChartSkeleton h={260} /><ChartSkeleton h={260} /></div>
    </>
  ),
});
const ModelUsagePie = dynamic(() => import('./DashboardCharts').then((m) => m.ModelUsagePie), {
  ssr: false, loading: () => <div className="w-[200px] h-[200px] rounded-full animate-pulse bg-[var(--color-surface)]" />,
});
import { formatTokens, formatCost } from '@unturf/unfirehose/format';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import { TimeRangeSelect, useTimeRange } from '@unturf/unfirehose-ui/TimeRangeSelect';
import { TOKEN_TYPE_COLORS, totalOf, cacheOf } from '@unturf/unfirehose-ui/TokenSplit';
import { StatStrip, Stat, StatDivider, costSub, cacheCostOf } from '@unturf/unfirehose-ui/StatStrip';

function shortModel(model: string): string {
  return model
    .replace('claude-', '')
    .replace(/-\d{8}$/, '');
}


/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * One model's row in the dashboard breakdown.
 *
 * A hundred-line callback inside the table's map: token split, cost split,
 * cache rate, power, and what running it ourselves saved against buying the
 * same tokens. None of it reachable without rendering the whole dashboard.
 */
export function ModelRow({ m }: { m: any }) {
  return (
                <tr className="border-t border-[var(--color-border)]">
                  <td className="py-1.5 flex items-center gap-2">
                    <span
                      className="inline-block w-2 h-2 rounded-full"
                      style={{ background: getModelColor(m.fullName) }}
                    />
                    <span>{m.name}</span>
                    {m.selfHosted && (
                      <span
                        className="text-xs text-[var(--color-muted)] opacity-70"
                        title={
                          m.host && m.meshObservedUSD != null
                            ? `self-hosted on ${m.host}. cost = watts × GPU-seconds × $/kWh, prefill and decode billed at their own rates. mesh-observed during window: $${m.meshObservedUSD.toFixed(4)} (sparse polling under-counts)`
                            : m.host
                              ? `self-hosted on ${m.host}. cost from peak-watt estimate.`
                              : `self-hosted, node unknown — no endpoint URL logged. Cost from peak-watt estimate.`
                        }
                      >
                        ⚡{m.host ?? 'local'}
                      </span>
                    )}
                    {m.costSource === 'synthetic' && (
                      <span
                        className="text-xs text-[var(--color-muted)] opacity-70"
                        title="Test fixture, not a real model. $0 by construction."
                      >
                        test
                      </span>
                    )}
                    {m.costSource === 'invoice' && (
                      <span
                        className="text-xs text-[var(--color-muted)] opacity-70"
                        title="Billed figure, quoted by the gateway. Not tokens times list price — a cached prefix or a batch tier bills below list and cannot be recovered from token counts."
                      >
                        billed
                      </span>
                    )}
                    {m.promo && (
                      <span
                        className="text-xs text-[var(--color-muted)] opacity-70"
                        title={`List price. ${m.promo.reason} — noted ${m.promo.notedOn}. The provider bills less than this today; a temporary discount is the wrong basis for deciding where work should run.`}
                      >
                        list
                      </span>
                    )}
                    {m.pricedAgainst && m.pricedAgainst.toLowerCase() !== m.fullName.toLowerCase() && (
                      <span
                        className="text-xs text-[var(--color-muted)] opacity-70"
                        title={`No own price — shadow-priced against ${m.pricedAgainst}.`}
                      >
                        ≈{m.pricedAgainst}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 text-right" title={m.inputCost != null ? `${formatCost(m.inputCost)} at API rates` : undefined}>
                    {formatTokens(m.inputTokens)}
                  </td>
                  <td
                    className="py-1.5 text-right"
                    title={
                      m.cacheReadTokens + m.cacheWriteTokens > 0
                        ? `cache read ${formatTokens(m.cacheReadTokens)} · ` +
                          `cache write ${formatTokens(m.cacheWriteTokens)}` +
                          (m.cacheCost != null ? `\n${formatCost(m.cacheCost)} at API rates` : '')
                        : m.structuralReuseTokens != null
                          ? `~${formatTokens(m.structuralReuseTokens)} of ${formatTokens(m.inputTokens)} prompt tokens were a re-send of a prompt we had already delivered` +
                            ` — ${((m.structuralReuseRate ?? 0) * 100).toFixed(1)}% of this model's prompt is prefix a cache could serve.` +
                            `\n\nDERIVED, not measured — the ~ marks it. vLLM's V1 engine never maps num_cached_tokens into prompt_tokens_details (vllm#44961, open since 2025), so a model we serve ourselves reports no cache at all. This is computed from our own sessions: an agent loop appends, so the prefix shared with the previous call is that call's whole prompt, floored to vLLM's 16-token block. It is a CEILING — real hits are lower by whatever eviction takes.` +
                            (m.measuredCacheHits != null
                              ? `\n\nFor comparison, vLLM's own counters on ${(m.measuredCacheNodes ?? []).join(', ')} report ${formatTokens(m.measuredCacheHits)} hits over ${formatTokens(m.measuredCacheQueries ?? 0)} queries this window. That describes the NODE, every client of it — not our traffic — so it is context, not our hit rate.`
                              : '')
                          : 'This provider reported no cache detail for these tokens. Not zero — unknown. An aggregator often returns it only when the request asks for detailed usage accounting.'
                    }
                  >
                    {m.cacheReadTokens + m.cacheWriteTokens > 0
                      ? formatTokens(m.cacheReadTokens + m.cacheWriteTokens)
                      : m.structuralReuseTokens != null
                        ? <span className="text-[var(--color-muted)]">
                            ~{formatTokens(m.structuralReuseTokens)}
                          </span>
                        : <span className="text-[var(--color-muted)]">—</span>}
                  </td>
                  <td className="py-1.5 text-right" title={m.outputCost != null ? `${formatCost(m.outputCost)} at API rates` : undefined}>
                    {formatTokens(m.outputTokens)}
                  </td>
                  <td className="py-1.5 text-right">
                    {formatTokens(m.tokens)}
                  </td>
                  <td className="py-1.5 text-right">
                    {/* An unpriced model must never render as $0 — that is the
                        defect this panel had. Show it as unknown instead. */}
                    {m.costSource === 'unknown'
                      ? <span className="text-[var(--color-muted)]" title="No price from either oracle. Not free — unknown.">—</span>
                      : m.costSource === 'synthetic'
                        ? <span className="text-[var(--color-muted)]" title="Test fixture. $0 by construction, not by measurement.">—</span>
                        : `$${m.cost.toFixed(2)}`}
                  </td>
                  <td className="py-1.5 text-right text-[var(--color-muted)]">
                    {/* Cost is now the buy price for every row, so the old
                        Market column would repeat it. What a self-hosted row
                        adds is the power bill — the money that actually
                        left the account. */}
                    {m.energy > 0
                      ? <span title="Electricity: watts × GPU-seconds × $/kWh. What serving this ourselves actually cost.">${m.energy.toFixed(2)}</span>
                      : <span title="Bought from a provider — no power bill of ours.">—</span>}
                  </td>
                  <td className="py-1.5 text-right">
                    {m.avoided > 0
                      ? <span className="text-[var(--color-success,#4ade80)]">${m.avoided.toFixed(2)}</span>
                      : <span className="text-[var(--color-muted)]">—</span>}
                  </td>
                </tr>
  );
}


/**
 * How old what this page shows might be.
 *
 * Every way ingestion can stop looks the same from here: no new rows. A
 * quiet afternoon and a worker that died overnight render identically, and
 * the second one cost ten hours of a session that had already happened.
 *
 * Silent below the threshold, because a dashboard that always warns is a
 * dashboard nobody reads.
 */
const STALE_AFTER_MINUTES = 30;

function IngestLag({ minutes }: { minutes: number | null | undefined }) {
  if (minutes == null || minutes < STALE_AFTER_MINUTES) return null;
  const hours = Math.floor(minutes / 60);
  const ago = hours >= 1 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
  return (
    <div
      className="rounded border border-[var(--color-error)]/40 bg-[var(--color-error)]/5 px-4 py-2 text-sm"
      title="Nothing has been read from the harness logs since then, so work done since is not on this page yet."
    >
      <span className="font-bold text-[var(--color-error)]">Last ingest {ago} ago.</span>
      <span className="text-[var(--color-muted)]">
        {' '}Anything logged since is not shown yet — check the worker is running.
      </span>
    </div>
  );
}

export default function DashboardPage() {
  const [range, setRange] = useTimeRange('dashboard_range', '7d');
  const { data, error } = useSWR(`/api/dashboard?range=${range}`, fetcher, {
    refreshInterval: 30000,
  });

  if (error) {
    return (
      <div className="text-[var(--color-error)]">
        Failed to load dashboard: {String(error)}
      </div>
    );
  }
  if (!data) {
    return <BootScreen />;
  }

  const modelData = (data.modelBreakdown ?? []).map((m: any) => ({
    name: shortModel(m.model),
    fullName: m.model,
    tokens: m.totalTokens,
    inputTokens: m.inputTokens ?? 0,
    outputTokens: m.outputTokens ?? 0,
    cacheReadTokens: m.cacheReadTokens ?? 0,
    cacheWriteTokens: m.cacheCreationTokens ?? 0,
    // Self-hosted rows book energy into the total and leave these at zero, so
    // an absent per-type price stays absent rather than reading as free.
    inputCost: m.selfHosted ? null : m.inputCostUSD,
    outputCost: m.selfHosted ? null : m.outputCostUSD,
    cacheCost: m.selfHosted ? null : (m.cacheReadCostUSD ?? 0) + (m.cacheWriteCostUSD ?? 0),
    // vLLM's own count, for models we serve. A self-hosted model reports no
    // cache_read tokens, so without this our own cache reads as nonexistent.
    measuredCacheHitRate: m.measuredCacheHitRate ?? null,
    measuredCacheQueries: m.measuredCacheQueries ?? null,
    measuredCacheHits: m.measuredCacheHits ?? null,
    measuredCacheNodes: m.measuredCacheNodes ?? null,
    // Derived from our own conversation shape, for models that report no
    // cache at all (vllm#44961). A ceiling, and the ~ says so.
    structuralReuseTokens: m.structuralReuseTokens ?? null,
    structuralReuseRate: m.structuralReuseRate ?? null,
    cost: m.costUSD ?? 0,
    // What these tokens are worth at oracle rates, and what our own hardware
    // saved by serving them. On a cloud row market EQUALS cost — the oracle
    // rate is the invoice — and avoided is zero; only self-hosted rows put a
    // real spread between the two. The table renders market accordingly.
    market: m.marketUSD ?? 0,
    avoided: m.avoidedUSD ?? 0,
    energy: m.energyUSD ?? 0,
    costSource: m.costSource ?? 'unknown',
    pricedAgainst: m.pricedAgainst ?? null,
    promo: m.promo ?? null,
    selfHosted: !!m.selfHosted,
    host: m.host ?? null,
    provider: m.provider ?? null,
    meshObservedUSD: m.meshObservedUSD,
  }));

  const avoidedTotal = modelData.reduce((s: number, m: any) => s + (m.avoided ?? 0), 0);

  // How much of every token we moved was cache. On a coding-agent workload
  // this runs above 90%, which is exactly why the headline has to say it.
  const summaryTokens = data.summary.totalTokens ?? 0;
  const cacheShare = summaryTokens > 0
    ? ((data.summary.cacheReadTokens ?? 0) + (data.summary.cacheWriteTokens ?? 0)) / summaryTokens
    : null;

  // Find sleep center and rotate hour data for bell curve

  // First-time visitor lands here after the vault. Zero sessions = teach the
  // product, hide the embarrassing zeros.
  if (data.summary.sessions === 0) {
    return (
      <div className="space-y-6">
        <PageContext
          pageType="dashboard"
          summary={`Dashboard (${range}). First-run state — no sessions ingested yet.`}
          metrics={{ ...data.summary, first_run: 'yes' }}
        />
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Dashboard</h2>
          <TimeRangeSelect value={range} onChange={setRange} />
        </div>
        <div className="border border-[var(--color-border)] rounded-xl p-8 bg-[var(--color-surface)] space-y-5 max-w-3xl">
          <div>
            <h3 className="text-2xl font-bold mb-2">Welcome to unfirehose</h3>
            <p className="text-base text-[var(--color-muted)]">
              A local-first observability dashboard for machine learning coding agents. Watch your sessions,
              tokens, reasoning, and cost across every harness you run — Claude Code, agnt,
              uncloseai, fetch, and more — without sending a byte to the cloud.
            </p>
          </div>
          <div>
            <h4 className="text-base font-bold mb-2">Get started</h4>
            <ol className="list-decimal list-inside text-base text-[var(--color-muted)] space-y-1.5">
              <li>Run a Claude Code session in any git repo: <code className="text-[var(--color-accent)]">cd ~/your/repo &amp;&amp; claude</code></li>
              <li>Or point another harness at <code className="text-[var(--color-accent)]">~/.unfirehose/</code>.</li>
              <li>Refresh this page — sessions, projects, todos, and reasoning appear automatically.</li>
            </ol>
          </div>
          <div className="flex flex-wrap gap-3 pt-2 border-t border-[var(--color-border)]">
            <Link href="/projects" className="px-3 py-1.5 text-sm rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10">Projects</Link>
            <Link href="/schema" className="px-3 py-1.5 text-sm rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)]">Schema docs</Link>
            <Link href="/settings" className="px-3 py-1.5 text-sm rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)]">Settings</Link>
            <Link href="/live" className="px-3 py-1.5 text-sm rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)]">Live stream</Link>
          </div>
        </div>
      </div>
    );
  }

  const splitTokens = {
    input: data.summary.inputTokens ?? 0,
    output: data.summary.outputTokens ?? 0,
    cacheRead: data.summary.cacheReadTokens ?? 0,
    cacheWrite: data.summary.cacheWriteTokens ?? 0,
  };

  return (
    <div className="space-y-6">
      <PageContext
        pageType="dashboard"
        summary={`Dashboard (${range}). ${data.summary.sessions} sessions, ${data.summary.messages} messages, ${formatTokens(data.summary.totalTokens ?? 0)} tokens (${cacheShare == null ? 'n/a' : (cacheShare * 100).toFixed(0) + '%'} cache), $${data.summary.totalCost} equiv cost.`}
        metrics={data.summary}
      />

      <IngestLag minutes={data.ingestLagMinutes} />

      {/* Header with time range dropdown */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Dashboard</h2>
        <TimeRangeSelect value={range} onChange={setRange} />
      </div>

      {/* Stats cards */}
      {/* One strip, not nine cards.
          Sessions through Since is what happened; Tokens through Output is
          what it cost. The old layout also printed the same dollar figure
          twice — "Total Tokens $5,349" beside "Equiv Cost $5,349" — so the
          cost lives on the token it belongs to now. */}
      <StatStrip>
        <Stat label="Sessions" value={String(data.summary.sessions)} />
        <Stat label="Messages" value={formatTokens(data.summary.messages)} />
        <Stat label="Models" value={String(data.summary.models)} />
        <Stat label="Since" value={data.summary.since ?? '?'} />

        <StatDivider />

        <Stat
          label="Tokens"
          value={formatTokens(totalOf(splitTokens))}
          sub={`$${data.summary.totalCost.toLocaleString()}`}
          title="Input + output + cache read + cache write, priced at API rates. Cache is billed at its own rate — not free, and not folded into input."
        />
        <Stat
          label="Input"
          value={formatTokens(splitTokens.input)}
          sub={costSub(data.summary.costSplit?.input)}
          color={TOKEN_TYPE_COLORS.input}
        />
        <Stat
          label="Cache"
          value={formatTokens(cacheOf(splitTokens))}
          sub={`${costSub(cacheCostOf(data.summary.costSplit))}${cacheShare != null ? ` · ${Math.round(cacheShare * 100)}% of tokens` : ''}`}
          color={TOKEN_TYPE_COLORS.cacheRead}
        />
        <Stat
          label="Output"
          value={formatTokens(splitTokens.output)}
          sub={costSub(data.summary.costSplit?.output)}
          color={TOKEN_TYPE_COLORS.output}
        />
      </StatStrip>

      <DashboardCharts data={data} range={range} />

      {/* Model usage */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
          Model Usage ({range})
        </h3>
        <div className="flex items-start gap-8">
          <ModelUsagePie modelData={modelData} />
          <div className="flex-1">
            <table className="w-full text-base [&_th]:px-2 [&_td]:px-2 [&_th]:whitespace-nowrap">
              <thead>
                <tr className="text-[var(--color-muted)] text-left">
                  <th className="pb-2">Model</th>
                  <th className="pb-2 text-right" style={{ color: TOKEN_TYPE_COLORS.input }} title="Fresh prompt tokens the provider read for the first time.">Input</th>
                  <th className="pb-2 text-right" style={{ color: TOKEN_TYPE_COLORS.cacheRead }} title="Cache read + cache write. A model we serve ourselves reports no cache tokens, so its cell shows what vLLM measured, marked ~. A dash means the provider told us nothing — unknown, not zero.">Cache</th>
                  <th className="pb-2 text-right" style={{ color: TOKEN_TYPE_COLORS.output }} title="Tokens the model generated.">Output</th>
                  <th className="pb-2 text-right" title="Input + output + cache read + cache write.">Tokens</th>
                  <th className="pb-2 text-right" title="What these tokens cost to buy: the invoice for a provider row, and for one we serve ourselves, what the same tokens would have cost from OpenRouter.">Cost</th>
                  <th className="pb-2 text-right" title="Electricity we actually spent serving this on our own hardware. Dashed for anything we bought.">Power</th>
                  <th className="pb-2 text-right" title="Buy price minus our power bill — what running it ourselves saved.">Saved</th>
                </tr>
              </thead>
              <tbody>
                {modelData.map((m: any) => (
                  <ModelRow key={m.fullName} m={m} />
                ))}
              </tbody>
              {avoidedTotal > 0 && (
                <tfoot>
                  <tr className="border-t border-[var(--color-border)] text-[var(--color-muted)]">
                    <td className="pt-2" colSpan={7}>
                      saved by running our own hardware
                    </td>
                    <td className="pt-2 text-right text-[var(--color-success,#4ade80)]">
                      ${avoidedTotal.toFixed(2)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Find the sleep trough: the 6-hour contiguous window (circular) with minimum total activity.
 * Returns the hour at the center of that window — the chart starts there so sleep is at the edges
 * and the activity bell curve peaks in the middle.
 */

