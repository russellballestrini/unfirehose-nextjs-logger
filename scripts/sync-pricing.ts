// Sync the model price ledger from every public oracle, then print the
// register entry it wrote. This is the SAME function the worker runs daily —
// `make pricing` exists so a human can run it on demand (a model shipped this
// morning) and see exactly what the book did, not a second implementation.
//
//   npx tsx scripts/sync-pricing.ts            sync, then report
//   npx tsx scripts/sync-pricing.ts --report   report only, no network
//   npx tsx scripts/sync-pricing.ts --json     machine-readable
//
// No credentials, no secrets: every feed is public and unauthenticated.

import { getDb } from '@unturf/unfirehose/db/schema';
import {
  syncPricing,
  hydratePricing,
  catalogAge,
  unpricedModels,
  recentSyncRuns,
  recentPriceChanges,
  ORACLE_URLS,
} from '@unturf/unfirehose/pricing-sync';
import {
  CATALOG_SOURCES,
  LIST_PRICE_SOURCES,
  catalogStats,
  priceConsensus,
  resolvePrice,
  SYNTHETIC_MODELS,
} from '@unturf/unfirehose/pricing';

/**
 * Flags, read per call rather than once at import.
 *
 * The body used to run on import with the process arguments baked in, which
 * is what a script does — and also why nothing could call it. `main` takes
 * its arguments now; the line at the bottom keeps make and npx working.
 */
let reportOnly = false;
let asJson = false;

const money = (n: number) => `$${n.toFixed(n >= 1 ? 2 : 3)}`;
const price = (p: { input: number; output: number }) => `${money(p.input)}/${money(p.output)}`;
const when = (s: number | null | undefined) => (s ? new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 16) : '—');
const age = (s: number | null) => {
  if (s === null) return 'never';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h ago`;
  return `${(s / 86400).toFixed(1)}d ago`;
};

export async function main(argv: string[] = process.argv.slice(2)) {
  const flags = new Set(argv);
  reportOnly = flags.has('--report');
  asJson = flags.has('--json');

  const db = getDb();
  const out: Record<string, unknown> = {};

  if (!reportOnly) {
    const results = await syncPricing(db, { trigger: 'make' });
    out.sync = results;
    if (!asJson) {
      console.log('== sync');
      for (const r of results) {
        const line = r.ok
          ? `ok   ${r.models} models  +${r.added} new  ~${r.changed} changed  =${r.unchanged} same  -${r.delisted} delisted`
          : `FAIL ${r.error}`;
        console.log(`  ${r.source.padEnd(11)} run#${r.runId}  ${line}`);
      }
      const moved = results.flatMap((r) => r.changes.filter((c) => c.from));
      if (moved.length) {
        console.log('\n== prices that moved this run');
        for (const c of moved) {
          console.log(`  ${c.source.padEnd(11)} ${c.modelId.padEnd(48)} ${price(c.from!)} → ${price(c.to)}`);
        }
      }
    }
  } else {
    hydratePricing(db);
  }

  // Book status
  const stats = catalogStats();
  out.books = CATALOG_SOURCES.map((s) => ({
    source: s, url: ORACLE_URLS[s], models: stats[s].models, ageSeconds: catalogAge(s, db),
  }));
  if (!asJson) {
    console.log('\n== books');
    for (const b of out.books as Array<{ source: string; models: number; ageSeconds: number | null }>) {
      console.log(`  ${b.source.padEnd(11)} ${String(b.models).padStart(5)} models  checked ${age(b.ageSeconds)}`);
    }
  }

  // Register
  const runs = recentSyncRuns(db, 15);
  out.runs = runs;
  if (!asJson) {
    console.log('\n== register (last 15)');
    for (const r of runs) {
      const status = r.ok ? `+${r.added} ~${r.changed} -${r.delisted}` : `FAIL ${r.error ?? ''}`;
      console.log(`  ${when(r.started_at)}  ${r.source.padEnd(11)} ${r.trigger.padEnd(9)} ${status}`);
    }
  }

  // Changes in the last 30 days — the volatility we are actually seeing
  const changes = recentPriceChanges(db, 30 * 86400, 40);
  out.recentChanges = changes;
  if (!asJson) {
    console.log(`\n== price changes, last 30d (${changes.length} shown)`);
    if (!changes.length) console.log('  none — every book has held its prices since we started keeping it');
    for (const c of changes) {
      console.log(`  ${when(c.effective_from)}  ${c.source.padEnd(11)} ${c.model_id.padEnd(44)} ${price({ input: c.prev_input ?? 0, output: c.prev_output ?? 0 })} → ${price(c)}`);
    }
  }

  // Every model we have logged recently: what it prices at, and whether the books agree
  const logged = db
    .prepare(
      `SELECT model, SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens
         FROM messages WHERE model IS NOT NULL AND model != ''
          AND timestamp >= datetime('now', '-28 days')
        GROUP BY model ORDER BY tokens DESC`,
    )
    .all() as Array<{ model: string; tokens: number }>;
  const coverage = logged
    .filter((m) => m.tokens > 0 && !SYNTHETIC_MODELS.has(m.model.toLowerCase()))
    .map((m) => {
      const p = resolvePrice(m.model);
      const c = priceConsensus(m.model);
      return {
        model: m.model, tokens: m.tokens,
        source: p?.source ?? 'unknown', matchedId: p?.matchedId ?? null,
        price: p ? { input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite: p.cacheWrite } : null,
        books: c.quotes.length, corroborated: c.corroborated, agree: c.agree, spread: c.spread,
        quotes: c.quotes, resale: c.resale,
      };
    });
  out.coverage = coverage;
  if (!asJson) {
    console.log('\n== models logged in the last 28d');
    for (const m of coverage) {
      const tok = m.tokens >= 1e9 ? `${(m.tokens / 1e9).toFixed(1)}B` : m.tokens >= 1e6 ? `${(m.tokens / 1e6).toFixed(1)}M` : `${Math.round(m.tokens / 1e3)}K`;
      const p = m.price ? price(m.price) : '—';
      const agree = m.books === 0 ? (m.resale ? 'resale book only' : 'NO BOOK')
        : m.books === 1 ? '1 book, uncorroborated'
        : m.agree ? `${m.books}/${LIST_PRICE_SOURCES.length} books agree`
        : `DISAGREE spread ${(m.spread * 100).toFixed(0)}%`;
      console.log(`  ${m.model.padEnd(40)} ${tok.padStart(7)}  ${p.padEnd(16)} ${String(m.source).padEnd(10)} ${agree}`);
      if (!m.agree) {
        for (const q of m.quotes) console.log(`      ${q.source.padEnd(11)} ${q.matchedId.padEnd(40)} ${price(q)}`);
      }
    }
  }

  const unpriced = unpricedModels(db, 28 * 24);
  out.unpriced = unpriced;
  if (!asJson) {
    console.log(`\n== unpriced with real tokens, last 28d: ${unpriced.length}`);
    for (const u of unpriced) console.log(`  ${u.model.padEnd(40)} ${u.tokens} tokens  last ${u.lastSeen.slice(0, 16)}`);
  }

  if (asJson) console.log(JSON.stringify(out, null, 2));
}

// Run when invoked directly, which is how make and npx call it.
if (process.argv[1]?.endsWith('sync-pricing.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
