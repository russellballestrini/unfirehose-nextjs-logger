// Integration + functional tests for the ONE cost function.
//
// The unit tests in pricing.test.ts prove the arithmetic. These prove the
// property that actually broke: every surface must agree. The same tokens
// showed $14 on /api/projects/activity, $0.70 on the project page, a third
// number on /api/alerts/[id], and a fourth typed inline in the alert page's
// JSX — four answers because four places each decided for themselves what a
// model costs, whether it was self-hosted, and which oracle to use.
//
// A test that only checked arithmetic would have passed the whole time.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import {
  setPriceCatalog,
  costForUsage,
  costForUsageRows,
  calcCostBreakdown,
  isSelfHosted,
  DEFAULT_KWH_RATE,
  getKwhRate,
  type CatalogEntry,
  type UsageRow,
} from './pricing.js';

const OPENROUTER: CatalogEntry[] = [
  { id: 'anthropic/claude-opus-5', source: 'openrouter', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, fetchedAt: 0 },
  { id: 'qwen/qwen3.6-27b',        source: 'openrouter', input: 0.32, output: 3.2, cacheRead: 0, cacheWrite: 0, fetchedAt: 0 },
  { id: 'z-ai/glm-5.3-flash',      source: 'openrouter', input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0, fetchedAt: 0 },
];
const NOUS: CatalogEntry[] = [
  { id: 'anthropic/claude-opus-5', source: 'nous', input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5, fetchedAt: 0 },
  { id: 'qwen/qwen3.6-27b',        source: 'nous', input: 0.256, output: 2.56, cacheRead: 0, cacheWrite: 0, fetchedAt: 0 },
];

beforeEach(() => {
  setPriceCatalog('openrouter', OPENROUTER);
  setPriceCatalog('nous', NOUS);
});

// The riseallships window that exposed the divergence, from the live DB.
const RISEALLSHIPS: UsageRow[] = [
  { model: 'stealth/ox-alpha', input: 2_600_000, output: 47_500, provider: 'local' },
  { model: 'Lorbus/Qwen3.6-27B-int4-AutoRound', input: 60_000, output: 2_000, provider: 'local' },
];

describe('every surface agrees — the property that broke', () => {
  it('gives one answer for one set of tokens, however it is summed', () => {
    // Surface A totals the rows itself; surface B uses the helper. Same number.
    const a = RISEALLSHIPS.reduce((s, r) => s + costForUsage(r).total, 0);
    const b = costForUsageRows(RISEALLSHIPS).total;
    expect(a).toBeCloseTo(b, 10);
  });

  it('does not price cheap traffic at Opus rates', () => {
    // The old blended rate: input 5, output 25, cacheRead 0.50, cacheWrite 6.25
    // applied to every model regardless of what actually ran.
    const blended =
      (2_660_000 / 1e6) * 5 + (49_500 / 1e6) * 25;
    const real = costForUsageRows(RISEALLSHIPS).total;
    expect(blended).toBeGreaterThan(real * 5);   // the ~20x overstatement
    expect(real).toBeLessThan(2);
  });

  it('routes self-host and oracle choice through one place', () => {
    // A caller that forgets `selfHosted` gets a different number from
    // calcCostBreakdown; costForUsage decides it so callers cannot forget.
    const row: UsageRow = {
      model: 'Lorbus/Qwen3.6-27B-int4-AutoRound',
      input: 1_000_000, output: 10_000, provider: 'local',
    };
    const viaEntry = costForUsage(row);
    const naive = calcCostBreakdown(row.model!, 1_000_000, 10_000, 0, 0, { selfHosted: false });
    expect(viaEntry.source).toBe('energy');
    expect(naive.source).toBe('openrouter');
    expect(viaEntry.total).not.toBeCloseTo(naive.total, 6);
  });

  it('keeps ox-alpha on an invoice, not on electricity, despite provider=local', () => {
    const c = costForUsage({ model: 'stealth/ox-alpha', input: 63_242_450, output: 1_043_717, provider: 'local' });
    expect(c.selfHosted).toBe(false);
    expect(c.source).toBe('openrouter');
    expect(c.total).toBeGreaterThan(0);
  });

  it('prices Nous-routed traffic at Nous rates and everything else at list', () => {
    const list = costForUsage({ model: 'claude-opus-5', input: 1_000_000, output: 0, provider: 'anthropic' });
    const nous = costForUsage({ model: 'claude-opus-5', input: 1_000_000, output: 0, provider: 'nous' });
    expect(list.total).toBeCloseTo(5, 6);
    expect(nous.total).toBeCloseTo(4, 6);
  });

  it('reports an empty or missing model as unknown, never as free', () => {
    for (const m of [null, undefined, '']) {
      expect(costForUsage({ model: m, input: 1e6, output: 1e6 }).source).toBe('unknown');
    }
  });

  it('sums an empty set to zero without claiming to know a price', () => {
    const c = costForUsageRows([]);
    expect(c.total).toBe(0);
    expect(c.source).toBe('unknown');
  });
});

describe('no surface keeps its own rate table', () => {
  const root = path.resolve(__dirname, '..', '..');
  const webSrc = path.join(root, 'apps', 'web', 'src');

  // Files legitimately allowed to contain rate literals.
  const ALLOWED = new Set([
    path.join(root, 'packages', 'core', 'pricing.ts'),
  ]);

  function walk(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readdirSync, statSync } = require('fs');
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (e === 'node_modules' || e === '.next') continue;
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(e) && !/\.test\./.test(e)) out.push(p);
    }
    return out;
  }

  it('has no second copy of a blended rate constant', () => {
    const offenders: string[] = [];
    for (const f of walk(webSrc)) {
      if (ALLOWED.has(f)) continue;
      const src = readFileSync(f, 'utf-8');
      // The exact shape that kept getting copied around.
      if (/AVG_RATE\s*=\s*\{/.test(src)) offenders.push(path.relative(root, f));
    }
    expect(offenders).toEqual([]);
  });

  it('does not multiply token counts by rate literals outside pricing.ts', () => {
    const offenders: string[] = [];
    for (const f of walk(webSrc)) {
      if (ALLOWED.has(f)) continue;
      const src = readFileSync(f, 'utf-8');
      // e.g. `(totals.input_tokens / 1_000_000) * 5`
      if (/\/\s*1_?000_?000\s*\)\s*\*\s*[\d.]+/.test(src)) {
        offenders.push(path.relative(root, f));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps one default kWh rate for the whole system', () => {
    expect(getKwhRate()).toBe(DEFAULT_KWH_RATE);
    const offenders: string[] = [];
    for (const f of walk(webSrc)) {
      const src = readFileSync(f, 'utf-8');
      // A page defining its own numeric default is how 0.31 and 0.33 diverged.
      if (/DEFAULT_KWH_RATE\s*=\s*0\.\d+/.test(src)) offenders.push(path.relative(root, f));
    }
    expect(offenders).toEqual([]);
  });
});

describe('self-host classification is decided in one place', () => {
  it('agrees with what costForUsage reports', () => {
    const rows: UsageRow[] = [
      { model: 'Lorbus/Qwen3.6-27B-int4-AutoRound', provider: 'local', input: 1000 },
      { model: 'stealth/ox-alpha', provider: 'local', input: 1000 },
      { model: 'claude-opus-5', provider: 'anthropic', input: 1000 },
      { model: 'qwen/qwen3.6-27b', provider: 'local', input: 1000 },
    ];
    for (const r of rows) {
      expect(costForUsage(r).selfHosted).toBe(isSelfHosted(r.model!, r.endpoint, r.provider));
    }
  });
});

// ---------------------------------------------------------------------------
// Every surface books at the price in force (ticket 4008)
// ---------------------------------------------------------------------------
//
// The ledger keeps every price with the range it held. That is worthless if
// a route sums a month of tokens and prices the sum at today's rate — the
// closed month moves the day an oracle changes its number. So every cost
// call in a route must carry `at`, and the aggregation feeding it must be
// per day (or narrower). The first test proves the arithmetic; the second
// walks the routes and refuses a call that dropped `at`.

import { setPriceHistory, clearPriceCatalogs } from './pricing.js';

describe('every surface books at the price in force', () => {
  const JUNE = Date.UTC(2026, 5, 1) / 1000;
  const SEPT = Date.UTC(2026, 8, 1) / 1000;

  beforeEach(() => {
    clearPriceCatalogs();
    const current = { id: 'anthropic/claude-opus-5', source: 'openrouter' as const, input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, fetchedAt: SEPT, effectiveFrom: SEPT, effectiveTo: null };
    setPriceCatalog('openrouter', [current]);
    setPriceHistory('openrouter', [
      current,
      { ...current, input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, effectiveFrom: JUNE, effectiveTo: SEPT },
    ]);
  });

  it('a closed month does not move when the price does', () => {
    const june = { model: 'claude-opus-5', input: 1_000_000, at: '2026-06-15' };
    const sept = { model: 'claude-opus-5', input: 1_000_000, at: '2026-09-15' };
    // Per-day bookings, however they are summed, give one answer.
    expect(costForUsage(june).total + costForUsage(sept).total).toBe(15);
    expect(costForUsageRows([june, sept]).total).toBe(15);
    // Summed first and priced today gives a different one — the defect.
    expect(costForUsage({ model: 'claude-opus-5', input: 2_000_000 }).total).toBe(20);
  });

  it('no route calls the cost function without `at`', () => {
    const root = path.resolve(__dirname, '..', '..');
    const apiDir = path.join(root, 'apps', 'web', 'src', 'app', 'api');
    const files = walk(apiDir).filter((f) => !f.endsWith('.test.ts'));
    const CALL = /\b(costForUsage|costForUsageRows|calcCostBreakdown|calcCost)\s*\(/g;
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf-8');
      let m: RegExpExecArray | null;
      while ((m = CALL.exec(src))) {
        // The call's argument text: from the paren to its matching close.
        let depth = 0, i = m.index + m[0].length - 1;
        for (; i < src.length; i++) {
          if (src[i] === '(') depth++;
          else if (src[i] === ')' && --depth === 0) break;
        }
        const args = src.slice(m.index, i + 1);
        if (!/\bat\s*:/.test(args)) {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${path.relative(root, f)}:${line} ${m[1]}(…) has no \`at\``);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  function walk(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }
});
