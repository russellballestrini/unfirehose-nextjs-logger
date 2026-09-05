import { describe, it, expect } from 'vitest';
import {
  money, price, when, age, tokens, agreement,
  renderSync, renderBooks, renderRegister, renderChanges, renderCoverage, renderUnpriced,
} from './pricing-report';

/**
 * How our price ledger reads.
 *
 * This is a report, so the failures are quiet ones: a number formatted to
 * the wrong precision, a book count printed against the wrong denominator,
 * a "prices moved" section that stays empty because a new listing and a
 * repriced one look alike. Each is legible only against a known input.
 */

describe('formatting', () => {
  it('gives sub-dollar prices a third decimal, since most of them are', () => {
    // $0.25/Mtok and $0.30/Mtok both round to $0.2 and $0.3 at one place.
    expect(money(0.25)).toBe('$0.250');
    expect(money(3)).toBe('$3.00');
    expect(price({ input: 3, output: 15 })).toBe('$3.00/$15.00');
  });

  it('says never rather than printing an epoch for a book never checked', () => {
    expect(age(null)).toBe('never');
    expect(when(null)).toBe('—');
    expect(when(undefined)).toBe('—');
  });

  it('picks the unit that keeps an age readable', () => {
    expect(age(90)).toBe('2m ago');
    expect(age(7200)).toBe('2.0h ago');
    expect(age(3 * 86400)).toBe('3.0d ago');
  });

  it('shortens token counts that run to billions', () => {
    expect(tokens(4_500)).toBe('5K');
    expect(tokens(2_400_000)).toBe('2.4M');
    expect(tokens(3_100_000_000)).toBe('3.1B');
  });

  it('renders a timestamp to the minute in UTC', () => {
    expect(when(1_760_000_000)).toBe('2025-10-09 08:53');
  });
});

describe('agreement', () => {
  it('separates unpriced from priced-by-a-reseller', () => {
    // Both have no list price. Only one of them means we are guessing.
    expect(agreement({ books: 0, resale: false, agree: true, spread: 0 })).toBe('NO BOOK');
    expect(agreement({ books: 0, resale: true, agree: true, spread: 0 })).toBe('resale book only');
  });

  it('calls a single quote uncorroborated rather than agreed', () => {
    // One book cannot agree with itself, and this is the state a wrong
    // invoice arrives in.
    expect(agreement({ books: 1, resale: false, agree: true, spread: 0 })).toBe('1 book, uncorroborated');
  });

  it('names the spread when the books contradict each other', () => {
    expect(agreement({ books: 3, resale: false, agree: false, spread: 0.42 }))
      .toBe('DISAGREE spread 42%');
  });

  it('counts agreeing books against how many books exist', () => {
    expect(agreement({ books: 2, resale: false, agree: true, spread: 0 })).toMatch(/^2\/\d+ books agree$/);
  });
});

const syncResult = (over = {}) => ({
  source: 'openrouter', runId: 12, ok: true, models: 300,
  added: 2, changed: 1, unchanged: 297, delisted: 0, changes: [], ...over,
});

describe('renderSync', () => {
  it('reports a failed source without losing the ones that worked', () => {
    const lines = renderSync([
      syncResult(),
      syncResult({ source: 'litellm', ok: false, error: 'HTTP 503' }),
    ] as never);
    expect(lines.join('\n')).toContain('ok   300 models  +2 new');
    expect(lines.join('\n')).toContain('FAIL HTTP 503');
  });

  it('lists a price that moved, and not one that is merely new', () => {
    // A new listing has no previous price. Printing it under "moved" makes
    // every sync look like a repricing event.
    const lines = renderSync([syncResult({
      changes: [
        { source: 'openrouter', modelId: 'a/new', to: { input: 1, output: 2 } },
        { source: 'openrouter', modelId: 'a/moved', from: { input: 3, output: 15 }, to: { input: 2, output: 10 } },
      ],
    })] as never);
    const text = lines.join('\n');
    expect(text).toContain('== prices that moved this run');
    expect(text).toContain('a/moved');
    expect(text).toContain('$3.00/$15.00 → $2.00/$10.00');
    expect(text).not.toContain('a/new');
  });

  it('omits the moved section entirely when nothing moved', () => {
    expect(renderSync([syncResult()] as never).join('\n')).not.toContain('moved');
  });
});

describe('the remaining sections', () => {
  it('says a book was never checked rather than showing it as current', () => {
    const lines = renderBooks([{ source: 'litellm', models: 0, ageSeconds: null }]);
    expect(lines.join('\n')).toContain('litellm         0 models  checked never');
  });

  it('shows a failed run in the register with its error', () => {
    const lines = renderRegister([
      { started_at: 1_760_000_000, source: 'helicone', trigger: 'worker', ok: false, added: 0, changed: 0, delisted: 0, error: 'timeout' },
    ]);
    expect(lines[0]).toBe('== register (last 15)');
    expect(lines[1]).toContain('FAIL timeout');
  });

  it('says plainly that no price has moved, rather than printing a bare heading', () => {
    const lines = renderChanges([]);
    expect(lines.join('\n')).toContain('none — every book has held its prices');
  });

  it('treats a change from no previous price as coming from zero', () => {
    const lines = renderChanges([{
      effective_from: 1_760_000_000, source: 'openrouter', model_id: 'a/b',
      prev_input: null, prev_output: null, input: 3, output: 15,
    }]);
    expect(lines[1]).toContain('$0.000/$0.000 → $3.00/$15.00');
  });

  it('prints the quotes only for a model whose books disagree', () => {
    const row = (over = {}) => ({
      model: 'x/y', tokens: 5_000_000, source: 'openrouter', matchedId: 'x/y',
      price: { input: 3, output: 15 }, books: 2, corroborated: true, agree: true,
      spread: 0, quotes: [{ source: 'openrouter', matchedId: 'x/y', input: 3, output: 15 }],
      resale: false, ...over,
    });
    expect(renderCoverage([row()]).join('\n')).not.toContain('  openrouter  x/y');
    const disagreeing = renderCoverage([row({ agree: false, spread: 0.5 })]).join('\n');
    expect(disagreeing).toContain('DISAGREE spread 50%');
    expect(disagreeing).toContain('x/y                                      $3.00/$15.00');
  });

  it('shows a dash for a model with no price at all', () => {
    expect(renderCoverage([{
      model: 'local/stub', tokens: 1_000, source: 'unknown', matchedId: null, price: null,
      books: 0, corroborated: false, agree: true, spread: 0, quotes: [], resale: false,
    }]).join('\n')).toContain('NO BOOK');
  });

  it('leads the unpriced section with its count, which is the number that matters', () => {
    const lines = renderUnpriced([{ model: 'a/b', tokens: 900, lastSeen: '2026-09-01T12:30:00Z' }]);
    expect(lines[0]).toBe('== unpriced with real tokens, last 28d: 1');
    expect(lines[1]).toContain('last 2026-09-01T12:30');
  });
});
