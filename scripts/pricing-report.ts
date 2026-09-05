// Rendering for the price-ledger report.
//
// The report used to be one function that fetched, computed and printed in
// the same pass, which made every line of it reachable only by running the
// whole thing against a live ledger. These take data and return lines, so
// the formatting decisions — which are the ones that have been wrong, like
// a book count printed against the wrong denominator — can be checked
// without a network or a database.
//
// No credentials, no secrets: every feed behind this is public.

import { LIST_PRICE_SOURCES } from '@unturf/unfirehose/pricing';

export interface Money { input: number; output: number }

export const money = (n: number) => `$${n.toFixed(n >= 1 ? 2 : 3)}`;
export const price = (p: Money) => `${money(p.input)}/${money(p.output)}`;

/** A unix timestamp as `YYYY-MM-DD HH:MM`, or an em dash when absent. */
export const when = (s: number | null | undefined) =>
  s ? new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 16) : '—';

/** Seconds elapsed, in the largest unit that keeps it readable. */
export const age = (s: number | null) => {
  if (s === null) return 'never';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h ago`;
  return `${(s / 86400).toFixed(1)}d ago`;
};

/** Token counts run to billions; three significant figures is plenty. */
export const tokens = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B`
  : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M`
  : `${Math.round(n / 1e3)}K`;

export interface SyncResult {
  source: string; runId: number; ok: boolean; error?: string | null;
  models: number; added: number; changed: number; unchanged: number; delisted: number;
  changes: Array<{ source: string; modelId: string; from?: Money | null; to: Money }>;
}

export function renderSync(results: SyncResult[]): string[] {
  const lines = ['== sync'];
  for (const r of results) {
    const line = r.ok
      ? `ok   ${r.models} models  +${r.added} new  ~${r.changed} changed  =${r.unchanged} same  -${r.delisted} delisted`
      : `FAIL ${r.error}`;
    lines.push(`  ${r.source.padEnd(11)} run#${r.runId}  ${line}`);
  }
  // A price that moved is the only thing in a sync worth reading closely —
  // a new model is expected, a repriced one changes what we already billed.
  const moved = results.flatMap(r => r.changes.filter(c => c.from));
  if (moved.length) {
    lines.push('', '== prices that moved this run');
    for (const c of moved) {
      lines.push(`  ${c.source.padEnd(11)} ${c.modelId.padEnd(48)} ${price(c.from!)} → ${price(c.to)}`);
    }
  }
  return lines;
}

export function renderBooks(books: Array<{ source: string; models: number; ageSeconds: number | null }>): string[] {
  return ['== books', ...books.map(b =>
    `  ${b.source.padEnd(11)} ${String(b.models).padStart(5)} models  checked ${age(b.ageSeconds)}`)];
}

export interface SyncRun {
  started_at: number; source: string; trigger: string;
  ok: boolean; added: number; changed: number; delisted: number; error?: string | null;
}

export function renderRegister(runs: SyncRun[], shown = 15): string[] {
  return [`== register (last ${shown})`, ...runs.map(r => {
    const status = r.ok ? `+${r.added} ~${r.changed} -${r.delisted}` : `FAIL ${r.error ?? ''}`;
    return `  ${when(r.started_at)}  ${r.source.padEnd(11)} ${r.trigger.padEnd(9)} ${status}`;
  })];
}

export interface PriceChange {
  effective_from: number; source: string; model_id: string;
  prev_input: number | null; prev_output: number | null; input: number; output: number;
}

export function renderChanges(changes: PriceChange[], days = 30): string[] {
  const lines = [`== price changes, last ${days}d (${changes.length} shown)`];
  if (!changes.length) {
    lines.push('  none — every book has held its prices since we started keeping it');
  }
  for (const c of changes) {
    lines.push(`  ${when(c.effective_from)}  ${c.source.padEnd(11)} ${c.model_id.padEnd(44)} `
      + `${price({ input: c.prev_input ?? 0, output: c.prev_output ?? 0 })} → ${price(c)}`);
  }
  return lines;
}

export interface CoverageRow {
  model: string; tokens: number; source: string; matchedId: string | null;
  price: (Money & { cacheRead?: number | null; cacheWrite?: number | null }) | null;
  books: number; corroborated: boolean; agree: boolean; spread: number;
  quotes: Array<Money & { source: string; matchedId: string }>;
  resale: boolean;
}

/**
 * How confident we are in one model's price, in a few words.
 *
 * Kept separate because the distinction that matters is not "priced or
 * not" — it is whether more than one independent book says so. A single
 * uncorroborated quote is what a wrong invoice looks like on the way in.
 */
export function agreement(m: Pick<CoverageRow, 'books' | 'resale' | 'agree' | 'spread'>): string {
  if (m.books === 0) return m.resale ? 'resale book only' : 'NO BOOK';
  if (m.books === 1) return '1 book, uncorroborated';
  if (m.agree) return `${m.books}/${LIST_PRICE_SOURCES.length} books agree`;
  return `DISAGREE spread ${(m.spread * 100).toFixed(0)}%`;
}

export function renderCoverage(coverage: CoverageRow[], days = 28): string[] {
  const lines = [`== models logged in the last ${days}d`];
  for (const m of coverage) {
    const p = m.price ? price(m.price) : '—';
    lines.push(`  ${m.model.padEnd(40)} ${tokens(m.tokens).padStart(7)}  ${p.padEnd(16)} `
      + `${String(m.source).padEnd(10)} ${agreement(m)}`);
    // Only worth the space when the books contradict each other; then the
    // quotes are the evidence for which one to believe.
    if (!m.agree) {
      for (const q of m.quotes) lines.push(`      ${q.source.padEnd(11)} ${q.matchedId.padEnd(40)} ${price(q)}`);
    }
  }
  return lines;
}

export function renderUnpriced(
  unpriced: Array<{ model: string; tokens: number; lastSeen: string }>, days = 28,
): string[] {
  return [`== unpriced with real tokens, last ${days}d: ${unpriced.length}`,
    ...unpriced.map(u => `  ${u.model.padEnd(40)} ${u.tokens} tokens  last ${u.lastSeen.slice(0, 16)}`)];
}
