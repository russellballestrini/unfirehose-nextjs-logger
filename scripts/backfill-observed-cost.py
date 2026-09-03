#!/usr/bin/env python3
"""Backfill messages.observed_cost_usd for a day we were billed for but
never captured a per-call price on.

WHY THIS EXISTS
    Token count times list price is a MODEL of the bill. On 2026-09-02 it
    read $14.47 for a day of Gemini that OpenRouter billed $7.10 — 2.04x —
    because 10.9M of 17.9M prompt tokens were served from cache at a tenth
    the rate. uncloseai now records `usage.cost` per call, but calls made
    before that landed carry no invoice and never will.

    This tool takes a day's authoritative total and distributes it across
    that day's messages in proportion to what each one was estimated to
    cost. The DAY total becomes exact; the per-message split stays an
    allocation, which is the honest description of what we can know.

WHERE THE TOTAL COMES FROM
    OpenRouter's /api/v1/key reports usage_daily / usage_weekly /
    usage_monthly for the key. A closed day is (weekly - daily) when only
    two days carry traffic; otherwise read it off the Activity page. Never
    pass a figure you have not seen stated by the provider.

    Rows that already carry a real per-call invoice keep it, and their sum
    is subtracted from the total before the remainder is allocated.

SAFETY
    Dry run by default. --commit writes. Re-running a day is safe: rows
    with a genuine invoice are never overwritten.
"""
import argparse
import os
import sqlite3
import sys

DB = os.path.expanduser(os.environ.get('UNFIREHOSE_DB',
                                       '~/.unfirehose/unfirehose.db'))


def price_for(conn, model):
    """List price per 1M tokens from our own ledger — the same book the
    dashboard prices against, so the allocation weights cannot disagree
    with the estimate they are replacing."""
    row = conn.execute(
        """SELECT input, output FROM model_pricing
            WHERE model_id = ? ORDER BY
              CASE source WHEN 'openrouter' THEN 0 WHEN 'modelsdev' THEN 1
                          WHEN 'litellm' THEN 2 ELSE 3 END
            LIMIT 1""", (model,)).fetchone()
    if not row:
        sys.exit(f'no price in model_pricing for {model!r} — cannot weight '
                 f'the allocation')
    return row[0], row[1]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--model', required=True, help='exact model id as stored in messages')
    ap.add_argument('--day', required=True, help='YYYY-MM-DD (UTC), the day being restated')
    ap.add_argument('--total', required=True, type=float,
                    help='USD the provider says that day cost, all calls included')
    ap.add_argument('--commit', action='store_true', help='write (default is a dry run)')
    args = ap.parse_args()

    conn = sqlite3.connect(DB)
    p_in, p_out = price_for(conn, args.model)

    rows = conn.execute(
        """SELECT id, input_tokens, output_tokens, observed_cost_usd
             FROM messages
            WHERE model = ? AND substr(timestamp, 1, 10) = ?""",
        (args.model, args.day)).fetchall()
    if not rows:
        sys.exit(f'no messages for {args.model} on {args.day}')

    already = sum(r[3] for r in rows if r[3] is not None)
    todo = [r for r in rows if r[3] is None]
    remainder = args.total - already
    if remainder < 0:
        sys.exit(f'invoiced rows already total ${already:.6f}, more than the '
                 f'${args.total:.6f} given. Refusing to write a negative '
                 f'allocation — check the day and the figure.')
    if not todo:
        print(f'every row already carries an invoice; nothing to allocate')
        return

    weights = [(r[0], r[1] * p_in / 1e6 + r[2] * p_out / 1e6) for r in todo]
    wsum = sum(w for _, w in weights)
    if wsum <= 0:
        sys.exit('these messages have no priced tokens to weight by')

    print(f'model      {args.model}')
    print(f'day        {args.day}')
    print(f'messages   {len(rows)}  ({len(todo)} to allocate, '
          f'{len(rows) - len(todo)} already invoiced)')
    print(f'estimate   ${wsum:.6f}  (list price, what we book today)')
    print(f'invoiced   ${already:.6f}  (real per-call prices, kept as-is)')
    print(f'allocating ${remainder:.6f}  over the rest')
    print(f'ratio      {wsum / remainder:.3f}x overstated' if remainder else '')

    scale = remainder / wsum
    if not args.commit:
        print('\nDRY RUN — pass --commit to write')
        return
    with conn:
        conn.executemany(
            'UPDATE messages SET observed_cost_usd = ? WHERE id = ?',
            [(w * scale, mid) for mid, w in weights])
    print(f'\nwrote {len(weights)} rows')


if __name__ == '__main__':
    main()
