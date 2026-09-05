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
  catalogStats,
  priceConsensus,
  resolvePrice,
  SYNTHETIC_MODELS,
} from '@unturf/unfirehose/pricing';
import {
  renderSync, renderBooks, renderRegister, renderChanges, renderCoverage, renderUnpriced,
  type CoverageRow,
} from './pricing-report';

const CHANGE_DAYS = 30;
const LOGGED_DAYS = 28;

/** Every model we logged recently, with what it prices at and who agrees. */
export function coverageRows(logged: Array<{ model: string; tokens: number }>): CoverageRow[] {
  return logged
    // A synthetic id (a router alias, a local stub) has no book anywhere and
    // would read as an unpriced model we are quietly losing money on.
    .filter(m => m.tokens > 0 && !SYNTHETIC_MODELS.has(m.model.toLowerCase()))
    .map(m => {
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
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const flags = new Set(argv);
  const reportOnly = flags.has('--report');
  const asJson = flags.has('--json');

  const db = getDb();
  const out: Record<string, unknown> = {};
  const say = (lines: string[]) => { if (!asJson) console.log(lines.join('\n') + '\n'); };

  if (reportOnly) {
    hydratePricing(db);
  } else {
    const results = await syncPricing(db, { trigger: 'make' });
    out.sync = results;
    say(renderSync(results));
  }

  const stats = catalogStats();
  out.books = CATALOG_SOURCES.map(s => ({
    source: s, url: ORACLE_URLS[s], models: stats[s].models, ageSeconds: catalogAge(s, db),
  }));
  say(renderBooks(out.books as Parameters<typeof renderBooks>[0]));

  const runs = recentSyncRuns(db, 15);
  out.runs = runs;
  say(renderRegister(runs as Parameters<typeof renderRegister>[0]));

  const changes = recentPriceChanges(db, CHANGE_DAYS * 86400, 40);
  out.recentChanges = changes;
  say(renderChanges(changes as Parameters<typeof renderChanges>[0], CHANGE_DAYS));

  const logged = db
    .prepare(
      `SELECT model, SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens
         FROM messages WHERE model IS NOT NULL AND model != ''
          AND timestamp >= datetime('now', '-${LOGGED_DAYS} days')
        GROUP BY model ORDER BY tokens DESC`,
    )
    .all() as Array<{ model: string; tokens: number }>;
  const coverage = coverageRows(logged);
  out.coverage = coverage;
  say(renderCoverage(coverage, LOGGED_DAYS));

  const unpriced = unpricedModels(db, LOGGED_DAYS * 24);
  out.unpriced = unpriced;
  say(renderUnpriced(unpriced, LOGGED_DAYS));

  if (asJson) console.log(JSON.stringify(out, null, 2));
}

// Run when invoked directly, which is how make and npx call it.
if (process.argv[1]?.endsWith('sync-pricing.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
