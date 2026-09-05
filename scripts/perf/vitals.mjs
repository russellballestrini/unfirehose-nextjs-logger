/**
 * How long every page takes to show a reader their data — `make vitals`.
 *
 * Our existing perf report times HTTP responses, which for this dashboard is
 * the fastest link in the chain reported as the whole thing: the document
 * arrives in about forty milliseconds and the screen stays empty until the
 * bundle parses, React hydrates, SWR fetches and the answer paints.
 *
 * This drives a real browser and ranks pages by `data` — the moment real
 * text last landed on screen. FCP and LCP both fire happily on a loading
 * skeleton, so a page can reach FCP in 200ms and still show nothing anybody
 * wanted for another four seconds.
 *
 *   make vitals                        against whatever is on :3000
 *   make vitals ARGS="--prod"          build, start, measure, stop
 *   make vitals ARGS="--runs 3"        median of three
 *   make vitals ARGS="--url /tokens"   one page
 *   make vitals ARGS="--budget 1500"   fail if any page's data time is worse
 */

import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { cpus } from 'os';
import { dirname, resolve } from 'path';
import { launch } from './cdp.mjs';
import { measurePage, unlockVault } from './measure.mjs';

const BASE = process.env.PERF_BASE ?? 'http://localhost:3000';

function args(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    const next = argv[i + 1];
    flags.set(name, next && !next.startsWith('--') ? next : 'true');
  }
  return {
    has: (n) => flags.has(n),
    str: (n, d) => flags.get(n) ?? d,
    num: (n, d) => (flags.has(n) ? Number(flags.get(n)) : d),
  };
}

async function pages(base) {
  const res = await fetch(`${base}/sitemap?format=xml`);
  const xml = await res.text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => new URL(m[1]).pathname)
    // The root is not in our sitemap and is the page most people open first.
    .concat('/')
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
}

/** The server's floor: a trivial route, five times, median. */
const CONTROL_MS = 40;
async function controlTtfb(base) {
  const t = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await fetch(`${base}/api/metrics`).then((r) => r.arrayBuffer()).catch(() => {});
    t.push(performance.now() - t0);
  }
  return Math.round(median(t));
}

const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const min = (xs) => {
  const s = xs.filter((x) => x != null);
  return s.length ? Math.min(...s) : null;
};

const ms = (n) => (n == null ? '—' : `${Math.round(n)}`);
const kb = (n) => `${Math.round(n / 1024)}k`;

/** Red past the budget, amber at half of it, plain below. */
function grade(text, value, budget) {
  if (value == null) return `\x1b[2m${text}\x1b[0m`;
  if (value > budget) return `\x1b[31m${text}\x1b[0m`;
  if (value > budget / 2) return `\x1b[33m${text}\x1b[0m`;
  return `\x1b[32m${text}\x1b[0m`;
}

function table(rows, budget) {
  const head = ['page', 'data', 'lcp', 'fcp', 'ttfb', 'block', 'js', 'api', 'slowest call'];
  const body = rows.map((r) => [
    r.url,
    grade(ms(r.dataOnScreen), r.dataOnScreen, budget),
    ms(r.lcp), ms(r.fcp), ms(r.ttfb),
    grade(ms(r.blocking), r.blocking, 300),
    kb(r.jsBytes),
    String(r.apiCalls),
    r.slowestApi ? `${r.slowestApi.ms}ms ${r.slowestApi.url}`.slice(0, 46) : '—',
  ]);
  // Widths ignore colour escapes, which are not printed characters.
  const bare = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const w = head.map((h, i) => Math.max(bare(h).length, ...body.map((r) => bare(r[i]).length)));
  const line = (cells) => cells
    .map((c, i) => (i === 0 || i === 8 ? c.padEnd(w[i] + (c.length - bare(c).length)) : c.padStart(w[i] + (c.length - bare(c).length))))
    .join('  ');
  return [line(head), w.map((n) => '─'.repeat(n)).join('  '), ...body.map(line)].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const flags = args(argv);
  const base = flags.str('base', BASE);
  const runs = flags.num('runs', 1);
  const budget = flags.num('budget', Infinity);
  // `--pick min` reports the best of N rather than the median. On a machine
  // that is also running a dev server, a worker and somebody's test suite,
  // the median describes the contention; the minimum is the nearest thing to
  // what the page costs when nothing else is in the way. Neither is wrong —
  // they answer different questions, and the header says which was asked.
  const pick = flags.str('pick', 'median') === 'min' ? min : median;

  // Cold by default: a first visit is what people mean by "slow". A warm run
  // measures the second visit to the same page in the same browser, which is
  // both faster and not the complaint.
  const cold = !flags.has('warm');
  const only = flags.has('url') ? [flags.str('url')] : null;
  const list = only ?? await pages(base);

  // A busy machine makes every page slower, and the numbers do not say so.
  // A run taken at load 20 read three times worse than the same build at
  // load 2 — and the load was this tool's own leaked renderers. Record it,
  // and refuse to call a result a regression when the machine was busy.
  const cores = cpus().length;
  const readLoad = () => Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
  let load1 = readLoad();
  // `--wait-load N` waits up to N seconds for the box to go quiet before
  // measuring. `make vitals-prod` needs this: it has just run a build, which
  // by itself pushes load past the guard, so refusing straight afterwards
  // would refuse every time.
  const waitFor = flags.num('wait-load', 0);
  if (waitFor > 0 && load1 > cores) {
    process.stderr.write(`load ${load1.toFixed(1)} on ${cores} cores — waiting up to ${waitFor}s for it to settle`);
    const deadline = Date.now() + waitFor * 1000;
    while (load1 > cores && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      load1 = readLoad();
      process.stderr.write('.');
    }
    process.stderr.write(`\n  load now ${load1.toFixed(1)}\n`);
  }
  const busy = load1 > cores;
  if (busy && !flags.has('force')) {
    console.error(`\n  load average ${load1.toFixed(1)} on ${cores} cores — a measurement now would say the machine is slow, not the pages.`);
    console.error('  Wait for it to settle, or pass --force to record it anyway (it will be marked).');
    process.exit(2);
  }

  // Load average is a poor guard for this: it counts the box, and the thing
  // that slows a page is whether *this server* is busy. So a control — the
  // time a trivial route takes to answer, sampled five times. /api/metrics
  // does almost nothing; when its median passes 40ms the server is fighting
  // for a core and every number below is inflated by roughly that fight.
  const control = await controlTtfb(base);
  const contended = control > CONTROL_MS;
  if (contended) console.error(`\n  control: ${control}ms for a trivial route (limit ${CONTROL_MS}ms) — the server is contended; numbers below are inflated`);

  const browser = await launch({ headless: !flags.has('headed') });
  const results = [];
  try {
    // A warm-up pass that is measured and thrown away. `next dev` compiles a
    // route the first time it is asked for, and `next start` still has an
    // empty module cache — either way the first visit measures the build,
    // not the page, and no reader ever sees that number twice.
    // A fresh profile has no vault, and every route renders the unlock
    // screen instead of the page. Skipping it first is the difference
    // between measuring fourteen pages and measuring one screen fourteen
    // times.
    process.stderr.write('getting past the vault gate...\n');
    await unlockVault(browser, base);

    process.stderr.write(`warming ${list.length} pages...\n`);
    for (const path of list) {
      await measurePage(browser, base + path, { settleMs: 400, capMs: 30_000, cold: false }).catch(() => {});
    }

    for (const path of list) {
      const takes = [];
      for (let i = 0; i < runs; i++) {
        takes.push(await measurePage(browser, base + path, { cold }));
      }
      const pickOf = (k) => pick(takes.map((t) => t[k]));
      const last = takes[takes.length - 1];
      results.push({
        ...last,
        url: path,
        dataOnScreen: pickOf('dataOnScreen'),
        lcp: pickOf('lcp'), fcp: pickOf('fcp'), ttfb: pickOf('ttfb'), blocking: pickOf('blocking'),
      });
      process.stderr.write(`  ${path} ${ms(pickOf('dataOnScreen'))}ms\n`);
    }
  } finally {
    await browser.close();
  }

  results.sort((a, b) => (b.dataOnScreen ?? 0) - (a.dataOnScreen ?? 0));

  const failed = results.filter((r) => r.failed);
  const pickName = pick === min ? 'best' : 'median';
  console.log(`\n  Time to data on screen — ${base} · ${cold ? 'first visit, cache empty' : 'return visit, cache warm'}${runs > 1 ? ` · ${pickName} of ${runs}` : ''} · load ${load1.toFixed(1)}/${cores} · control ${control}ms${busy || contended ? ' \x1b[31mCONTENDED — not comparable\x1b[0m' : ''}\n`);
  console.log(table(results, Number.isFinite(budget) ? budget : 2000));

  if (failed.length) {
    console.log('\n  Could not measure:');
    for (const f of failed) console.log(`    ${f.url} — ${f.failed}`);
  }

  const worst = results.find((r) => !r.failed) ?? results[0];
  const totalApi = results.flatMap((r) => r.api);
  const bySlowest = totalApi.slice().sort((a, b) => b.ms - a.ms).slice(0, 8);
  console.log(`\n  worst page: ${worst.url} at ${ms(worst.dataOnScreen)}ms to data`);
  if (bySlowest.length) {
    console.log('\n  Slowest API calls anywhere:');
    for (const c of bySlowest) console.log(`    ${String(c.ms).padStart(6)}ms  ${kb(c.bytes).padStart(6)}  ${c.path}`);
  }

  if (flags.has('json')) {
    const out = resolve(process.cwd(), flags.str('json', 'reports/vitals.json'));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), base, runs, pick: pickName, cold, load1, cores, control, contended: busy || contended, results }, null, 2)}\n`);
    console.log(`\n  wrote ${out}`);
  }

  if (Number.isFinite(budget)) {
    const over = results.filter((r) => (r.dataOnScreen ?? 0) > budget);
    if (over.length) {
      console.error(`\n  ${over.length} page(s) over the ${budget}ms budget: ${over.map((r) => r.url).join(', ')}`);
      process.exit(1);
    }
    console.log(`\n  within budget: worst is ${ms(worst.dataOnScreen)}ms of ${budget}ms`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
