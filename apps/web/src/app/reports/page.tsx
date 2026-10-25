'use client';

import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '@unturf/unfirehose-ui/fetcher';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import { EmptyState } from '@unturf/unfirehose-ui/EmptyState';
import { formatCurrency } from '@unturf/unfirehose-ui/useCurrency';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Monthly cost reports for expense claims (ticket 4009).
 *
 * The month is read in this browser's time zone and the amounts are in the
 * first currency chosen in Settings, converted at the rate the report
 * itself carries — a closed month is filed once, so the figures here are
 * the figures in the CSV and the PDF, and they do not move afterwards.
 */

const BASIS_HELP: Record<string, string> = {
  stated: 'what a provider said it charged',
  priced: 'tokens at our price ledger on the day they were spent',
  measured: 'sampled watts over the hours sampled, at the node’s electricity rate',
  flat: 'a monthly amount configured here — a plan, an ISP bill',
};

/** The month before this one, YYYY-MM, in local time: what a claim is usually for. */
function lastMonth(now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function thisMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthTitle(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });
}

export default function ReportsPage() {
  const [month, setMonth] = useState(lastMonth);
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const query = `month=${month}&tz=${encodeURIComponent(tz)}`;
  const { data: r, error, isLoading } = useSWR(`/api/reports/monthly?${query}`, fetcher, { revalidateOnFocus: false });

  const money = (usd: number) => (r ? formatCurrency(usd, r.currency?.code ?? 'USD', r.currency?.rate ?? 1) : '');
  const groups = useMemo(() => {
    if (!Array.isArray(r?.lines)) return [];
    const labels = new Map<string, string>((r.byCategory ?? []).map((c: any) => [c.category, c.label] as [string, string]));
    const out = new Map<string, { label: string; lines: any[] }>();
    for (const l of r.lines) {
      const g: { label: string; lines: any[] } = out.get(l.category) ?? { label: labels.get(l.category) ?? l.category, lines: [] };
      g.lines.push(l);
      out.set(l.category, g);
    }
    return [...out.values()];
  }, [r]);

  return (
    <div className="space-y-6">
      <PageContext
        pageType="reports"
        summary={r ? `Cost report for ${r.month}: ${money(r.totalUSD)} across ${r.lines?.length ?? 0} lines${r.closed ? '' : ' (month to date)'}.` : 'Monthly cost report.'}
        metrics={{ month, total_usd: r?.totalUSD ?? 0, lines: r?.lines?.length ?? 0, currency: r?.currency?.code ?? 'USD' }}
        details={(r?.byCategory ?? []).map((c: any) => `${c.label}: $${c.usd.toFixed(2)}`).join('\n')}
      />

      <div className="flex items-center gap-4 flex-wrap">
        <h1 className="text-2xl font-bold">Reports</h1>
        <label className="flex items-center gap-1.5 text-sm">
          <span className="text-[var(--color-muted)]">Month</span>
          <input
            type="month"
            value={month}
            max={thisMonth()}
            onChange={(e) => { if (e.target.value) setMonth(e.target.value); }}
            className="bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1"
          />
        </label>
        <span className="text-xs text-[var(--color-muted)]">{tz}</span>
        <div className="flex gap-2 ml-auto">
          <a href={`/api/reports/monthly?${query}&format=csv`} download className="text-sm px-3 py-1 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)]">Download CSV</a>
          <a href={`/api/reports/monthly?${query}&format=pdf`} download className="text-sm px-3 py-1 rounded bg-[var(--color-accent)] text-black font-bold">Download PDF</a>
        </div>
      </div>

      {error && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 text-[var(--color-error)]">
          Could not build the report: {String(error.message ?? error)}
        </div>
      )}
      {isLoading && !r && <div className="text-[var(--color-muted)]">Building {monthTitle(month)}…</div>}

      {r?.month && !r.error && (
        <>
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
            <div className="flex items-baseline gap-4 flex-wrap">
              <div className="text-3xl font-bold">{money(r.totalUSD)}</div>
              <div className="text-[var(--color-muted)]">
                {monthTitle(r.month)}{r.closed ? '' : ' — month to date'}
              </div>
            </div>
            <div className="text-xs text-[var(--color-muted)] space-y-0.5">
              {r.currency?.code !== 'USD' && (
                <div>Converted at 1 USD = {r.currency.rate} {r.currency.code}, {r.currency.source} rate for {r.currency.rateDate}.</div>
              )}
              {r.currency?.fallbackReason && <div>Shown in USD — {r.currency.fallbackReason}.</div>}
              <div>{r.closed ? 'Filed' : 'Built'} {new Date(r.generatedAt).toLocaleString()}.{r.closed ? ' Downloads of this month will match these figures.' : ''}</div>
            </div>
            {r.byCategory?.length > 0 && (
              <table className="w-full text-base">
                <tbody>
                  {r.byCategory.map((c: any) => (
                    <tr key={c.category} className="border-t border-[var(--color-border)]">
                      <td className="py-1.5">{c.label}</td>
                      <td className="py-1.5 text-right font-mono">{money(c.usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <h2 className="text-lg font-bold mb-3">Line items</h2>
            {groups.length === 0 ? (
              r.hasAnyMessages === false ? (
                <EmptyState
                  compact
                  what="Line items will appear here: API usage priced on the day it was spent, plans, power and other monthly costs."
                  action="Nothing has been ingested yet. Run a harness session and this month's report fills in as it happens."
                  command="cd ~/your/repo && claude"
                />
              ) : (
                <EmptyState
                  compact
                  kind="quiet"
                  what={`Nothing was spent in ${monthTitle(r.month)} that unfirehose knows about.`}
                  action="Pick another month above; a month with sessions, a plan or a node's power lists its line items here."
                />
              )
            ) : (
              <table className="w-full text-base">
                <thead>
                  <tr className="text-left text-sm text-[var(--color-muted)]">
                    <th className="pb-2">Item</th>
                    <th className="pb-2">Basis</th>
                    <th className="pb-2 text-right">Amount</th>
                  </tr>
                </thead>
                {groups.map((g) => (
                  <tbody key={g.label}>
                    <tr><td colSpan={3} className="pt-3 pb-1 text-sm font-bold text-[var(--color-muted)]">{g.label}</td></tr>
                    {g.lines.map((l: any, i: number) => (
                      <tr key={`${l.item}-${l.basis}-${i}`} className="border-t border-[var(--color-border)] align-top">
                        <td className="py-1.5 pr-3 [overflow-wrap:anywhere]">
                          <div>{l.item}</div>
                          <div className="text-xs text-[var(--color-muted)]">{l.detail}</div>
                        </td>
                        <td className="py-1.5 pr-3 text-sm text-[var(--color-muted)]" title={BASIS_HELP[l.basis]}>{l.basis}</td>
                        <td className="py-1.5 text-right font-mono whitespace-nowrap">{money(l.usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {r.byProject?.length > 0 && (
              <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
                <h2 className="text-lg font-bold mb-3">Model API usage by project</h2>
                <table className="w-full text-base">
                  <tbody>
                    {r.byProject.map((p: any) => (
                      <tr key={p.project} className="border-t border-[var(--color-border)]">
                        <td className="py-1.5 pr-3 [overflow-wrap:anywhere]">{p.project}</td>
                        <td className="py-1.5 text-right font-mono">{money(p.usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {r.electricityByProject?.length > 0 && (
              <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4" data-electricity-by-project>
                <h2 className="text-lg font-bold mb-1">Electricity by project</h2>
                <p className="text-sm text-[var(--color-muted)] mb-3">
                  What our sessions on each node drew above its idle, measured. Already inside the electricity lines; this says which client it served.
                </p>
                <table className="w-full text-base">
                  <tbody>
                    {r.electricityByProject.map((p: any) => (
                      <tr key={p.project} className="border-t border-[var(--color-border)]">
                        <td className="py-1.5 pr-3 [overflow-wrap:anywhere]">{p.project}</td>
                        <td className="py-1.5 text-right font-mono">{money(p.usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {r.memo?.length > 0 && (
              <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
                <h2 className="text-lg font-bold mb-1">Not counted in the total</h2>
                <p className="text-sm text-[var(--color-muted)] mb-3">Shown so a reader can see them, and why they are left out.</p>
                <table className="w-full text-base">
                  <tbody>
                    {r.memo.map((m: any) => (
                      <tr key={m.item} className="border-t border-[var(--color-border)] align-top">
                        <td className="py-1.5 pr-3">
                          <div>{m.item}</div>
                          <div className="text-xs text-[var(--color-muted)]">{m.detail}</div>
                        </td>
                        <td className="py-1.5 text-right font-mono whitespace-nowrap text-[var(--color-muted)]">{money(m.usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {r.notes?.length > 0 && (
            <ul className="text-sm text-[var(--color-muted)] list-disc pl-5 space-y-1">
              {r.notes.map((n: string) => <li key={n}>{n}</li>)}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
