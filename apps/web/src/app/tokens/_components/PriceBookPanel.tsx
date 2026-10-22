import { humanDelta } from '@unturf/unfirehose/ago';
import { formatTokens } from '@unturf/unfirehose/format';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The price book behind this page. Every dollar above was computed against
 * a ledger synced from public oracles; this says which, how fresh, what has
 * moved lately, and what we could not price at all. Data: /api/pricing?summary=1.
 */
export function PriceBookPanel({ book }: { book: any }) {
  if (!book) return null;
  const oracles: any[] = book.oracles ?? [];
  const lastRun = book.lastRun;
  const changes: any[] = book.recentChanges ?? [];
  const unpriced: any[] = book.unpriced ?? [];
  const changesByDay: Record<string, number> = book.changesByDay ?? {};
  const totalMoves = Object.values(changesByDay).reduce((s, n) => s + n, 0);
  const daysWithMoves = Object.keys(changesByDay).length;

  const age = (s: number | null) => {
    if (s === null || s === undefined) return 'never';
    return humanDelta(s * 1000, { abbreviate: true, smallest: 'minute', pastTense: '{} ago', zero: 'just now' });
  };
  const stale = (s: number | null) => s === null || s === undefined || s > 2 * 86400;
  const money = (n: number) => `$${n.toFixed(n >= 1 ? 2 : 3)}`;
  const when = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 16).replace('T', ' ');

  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <span className="text-lg font-semibold">Price Book</span>
          <span className="ml-2 text-base text-[var(--color-muted)]">
            every $ on this page is booked at the price in force the day the tokens were spent
          </span>
        </div>
        <a href="/api/pricing" className="text-base text-[var(--color-muted)] hover:underline">full ledger →</a>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {/* Books */}
        <div>
          <div className="text-base text-[var(--color-muted)] mb-1">Books</div>
          <table className="w-full text-base">
            <tbody>
              {oracles.map((o) => (
                <tr key={o.source}>
                  <td className="py-0.5 pr-2 font-mono">{o.source}</td>
                  <td className="py-0.5 pr-2 text-[var(--color-muted)]">{o.listPrice ? 'list' : 'resale'}</td>
                  <td className="py-0.5 pr-2 text-right">{o.models.toLocaleString()}</td>
                  <td className={`py-0.5 text-right ${stale(o.ageSeconds) ? 'text-red-400' : 'text-[var(--color-muted)]'}`}>
                    {age(o.ageSeconds)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {lastRun && (
            <div className="mt-2 text-base text-[var(--color-muted)]">
              last sync {when(lastRun.started_at)} via <span className="font-mono">{lastRun.trigger}</span>
              {lastRun.ok ? '' : <span className="text-red-400"> — failed: {lastRun.error}</span>}
            </div>
          )}
        </div>

        {/* Moves */}
        <div>
          <div className="text-base text-[var(--color-muted)] mb-1">
            Price moves, 30d
            <span className="ml-2">
              {totalMoves === 0
                ? 'none — every book has held'
                : `${totalMoves} across ${daysWithMoves} day${daysWithMoves === 1 ? '' : 's'}`}
            </span>
          </div>
          {changes.length > 0 && (
            <table className="w-full text-base">
              <tbody>
                {changes.slice(0, 6).map((c, i) => (
                  <tr key={i}>
                    <td className="py-0.5 pr-2 text-[var(--color-muted)]">{when(c.effective_from).slice(5, 10)}</td>
                    <td className="py-0.5 pr-2 font-mono truncate max-w-[14rem]" title={`${c.source} ${c.model_id}`}>{c.model_id}</td>
                    <td className="py-0.5 text-right whitespace-nowrap">
                      <span className="text-[var(--color-muted)]">{money(c.prev_input)}/{money(c.prev_output)}</span>
                      {' → '}
                      <span className={c.input > c.prev_input ? 'text-red-400' : 'text-green-400'}>{money(c.input)}/{money(c.output)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Unpriced */}
        <div>
          <div className="text-base text-[var(--color-muted)] mb-1">
            Unpriced with real tokens, 28d
            <span className={`ml-2 ${unpriced.length ? 'text-red-400' : ''}`}>{unpriced.length}</span>
          </div>
          {unpriced.length === 0 ? (
            <div className="text-base text-[var(--color-muted)]">every model with tokens has a price in at least one book</div>
          ) : (
            <ul className="text-base space-y-0.5">
              {unpriced.slice(0, 6).map((u) => (
                <li key={u.model} className="flex justify-between gap-2">
                  <span className="font-mono truncate" title={u.model}>{u.model}</span>
                  <span className="text-[var(--color-muted)] whitespace-nowrap">{formatTokens(u.tokens)} · shown as —</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
