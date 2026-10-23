/**
 * One month of spend, itemised for an expense claim (ticket 4009).
 *
 * Everything here is already in our database or settings; this assembles a
 * calendar month of it in the reader's own time zone and says, line by
 * line, where each number comes from — because "where does this figure come
 * from" is the question an approver asks, and the answer differs per line:
 *
 *   stated    a provider told us what it charged (observed_cost_usd, a
 *             card-charge snapshot)
 *   priced    tokens x our price ledger as of the day they were spent
 *   measured  sampled watts x hours x the node's $/kWh
 *   flat      a monthly amount someone configured (a plan, an ISP bill)
 *
 * Two things are deliberately NOT in the total, and are listed as memo
 * lines instead so the reader can see them and why:
 *
 *   - Claude Code usage while a Claude subscription is detected. The plan is
 *     the charge; pricing its tokens at API rates as well would bill the same
 *     work twice. Shown at its API-equivalent value.
 *   - Models we serve ourselves. What they cost is the electricity, which is
 *     already a measured line; their market value is shown for comparison.
 *
 * Amounts are USD throughout — every source is — and the report carries the
 * one conversion rate a renderer applies, with its date and source, so a
 * filed copy says exactly how its figures were converted.
 */
import type Database from 'better-sqlite3';
import { costForUsage, getKwhRate } from './pricing';
import { ensurePricingHydrated } from './pricing-sync';
import { rollupTarget } from './project-rollup';
import { nodeEconKey, parseExcludedHosts, DEFAULT_ISP_COST_MONTHLY } from './mesh-econ';
import { readPayload, storePayload } from './precomputed';

export type CostBasis = 'stated' | 'priced' | 'measured' | 'flat';
export type CostCategory = 'model-api' | 'subscription' | 'extra-usage' | 'electricity' | 'connectivity';

export const CATEGORY_LABEL: Record<CostCategory, string> = {
  'model-api': 'Model API usage',
  subscription: 'Subscriptions',
  'extra-usage': 'Extra usage',
  electricity: 'Electricity (self-hosted)',
  connectivity: 'Connectivity (ISP / hosting)',
};

export interface CostLine {
  category: CostCategory;
  item: string;
  detail: string;
  basis: CostBasis;
  usd: number;
}

/** Shown for context, never added to the total. */
export interface MemoLine {
  item: string;
  detail: string;
  usd: number;
}

export interface ReportCurrency {
  /** The currency a renderer shows; USD when no rate could be had. */
  code: string;
  /** Units of `code` per US dollar. 1 for USD. */
  rate: number;
  /** The day the rate is for (YYYY-MM-DD), or null for USD. */
  rateDate: string | null;
  source: string | null;
  /** Set when the reader asked for another currency and we could not convert. */
  fallbackReason?: string;
}

export interface MonthlyCostReport {
  $schema: 'unfirehose-cost-report/1';
  /** YYYY-MM, in `timeZone`. */
  month: string;
  timeZone: string;
  /** UTC instants bounding the local month, [start, end). */
  periodStart: string;
  periodEnd: string;
  /** False while the month is still running: figures are month to date. */
  closed: boolean;
  generatedAt: string;
  currency: ReportCurrency;
  lines: CostLine[];
  memo: MemoLine[];
  byCategory: { category: CostCategory; label: string; usd: number }[];
  byProject: { project: string; usd: number }[];
  byModel: { model: string; usd: number; tokens: number; basis: CostBasis }[];
  totalUSD: number;
  notes: string[];
}

export interface CostReportInputs {
  /** 'YYYY-MM'. */
  month: string;
  /** IANA zone the month is read in. */
  timeZone: string;
  /** Every settings row, as getAllSettings returns them. */
  settings: Record<string, string>;
  /**
   * A detected Claude subscription: its name and monthly price. Null when
   * none is configured; Claude Code usage is then priced like any API call.
   */
  claudePlan: { name: string; monthlyUSD: number } | null;
  /** Repo names from the folded project list, for folding scratch dirs onto repos. */
  repoNames?: Iterable<string>;
  /** Project name → the display name a reader knows it by. */
  displayNames?: Map<string, string>;
  currency?: ReportCurrency;
  now?: number;
}

const USD: ReportCurrency = { code: 'USD', rate: 1, rateDate: null, source: null };

// ── Time ──────────────────────────────────────────────────────────────────────

/** Minutes east of UTC that `tz` reads at `instant`. */
function zoneOffsetMinutes(instant: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60_000);
}

/** The UTC instant of local midnight on the first of a month in `tz`. */
export function zonedMonthStart(year: number, month1: number, tz: string): number {
  const guess = Date.UTC(year, month1 - 1, 1);
  // Twice: the offset at the guess can differ from the offset at the answer
  // when a DST change falls between them.
  let t = guess - zoneOffsetMinutes(guess, tz) * 60_000;
  t = guess - zoneOffsetMinutes(t, tz) * 60_000;
  return t;
}

export function isValidMonth(month: string): boolean {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  return !!m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 2000 && +m[1] <= 9999;
}

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** [start, end) of a local calendar month, as UTC epoch ms. */
export function monthBounds(month: string, tz: string): { start: number; end: number } {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? [y + 1, 1] : [y, m + 1];
  return { start: zonedMonthStart(y, m, tz), end: zonedMonthStart(next[0], next[1], tz) };
}

/** The month before the one `now` falls in, in `tz`: what a claim is usually for. */
export function previousMonth(tz: string, now = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(new Date(now));
  let y = Number(parts.find((p) => p.type === 'year')!.value);
  let m = Number(parts.find((p) => p.type === 'month')!.value) - 1;
  if (m === 0) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

const sqliteTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const parseSqliteTime = (s: string) => Date.parse(s.replace(' ', 'T') + 'Z');

// ── Model usage ───────────────────────────────────────────────────────────────

interface UsageGroup {
  day: string; model: string; provider: string | null; endpoint: string | null;
  harness: string; project: string; projectDisplay: string;
  input: number; output: number; cacheRead: number; cacheWrite: number;
  observed: number | null; messages: number;
}

function readUsage(db: Database.Database, from: string, to: string): UsageGroup[] {
  // One row per (UTC day, model, route, harness, project, stated-or-not), so
  // each day books at the price in force that day and a provider's stated
  // figure is never blended with an estimate of the same model.
  return db.prepare(`
    SELECT substr(m.timestamp, 1, 10) AS day, m.model, m.provider, m.endpoint,
           COALESCE(s.harness, 'claude-code') AS harness,
           COALESCE(p.name, '(no project)') AS project,
           COALESCE(p.display_name, p.name, '(no project)') AS projectDisplay,
           SUM(COALESCE(m.input_tokens, 0)) AS input,
           SUM(COALESCE(m.output_tokens, 0)) AS output,
           SUM(COALESCE(m.cache_read_tokens, 0)) AS cacheRead,
           SUM(COALESCE(m.cache_creation_tokens, 0)) AS cacheWrite,
           SUM(m.observed_cost_usd) AS observed,
           COUNT(*) AS messages
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      LEFT JOIN projects p ON p.id = s.project_id
     WHERE m.timestamp >= ? AND m.timestamp < ?
       AND m.model IS NOT NULL AND m.model != '<synthetic>'
     GROUP BY day, m.model, m.provider, m.endpoint, harness, project, projectDisplay, (m.observed_cost_usd IS NOT NULL)
  `).all(from, to) as UsageGroup[];
}

const isClaudeCode = (harness: string) => harness === 'claude-code';
const isAnthropicModel = (model: string, provider: string | null) =>
  provider === 'anthropic' || (!provider && /^claude/i.test(model));

// ── Electricity ───────────────────────────────────────────────────────────────

interface NodeEnergy { kwh: number; sampledHours: number }

/** kWh per host over [from, to), from both snapshot tiers. Gaps over 5 min count as unsampled. */
function readEnergy(db: Database.Database, from: number, to: number): Map<string, NodeEnergy> {
  const out = new Map<string, NodeEnergy>();
  const add = (host: string, kwh: number, hours: number) => {
    const e = out.get(host) ?? { kwh: 0, sampledHours: 0 };
    e.kwh += kwh; e.sampledHours += hours;
    out.set(host, e);
  };

  const raw = db.prepare(`
    SELECT hostname, timestamp, COALESCE(power_watts, 0) + COALESCE(gpu_power_watts, 0) AS watts
      FROM mesh_snapshots
     WHERE timestamp >= ? AND timestamp < ?
     ORDER BY hostname, timestamp
  `).all(sqliteTime(from), sqliteTime(to)) as { hostname: string; timestamp: string; watts: number }[];
  let prev: { host: string; ts: number; w: number } | null = null;
  for (const r of raw) {
    const ts = parseSqliteTime(r.timestamp);
    if (prev && prev.host === r.hostname) {
      const dtH = (ts - prev.ts) / 3_600_000;
      if (dtH > 0 && dtH < 5 / 60) add(r.hostname, (prev.w / 1000) * dtH, dtH);
    }
    prev = { host: r.hostname, ts, w: r.watts };
  }

  // Past 28 days the 15 s rows are folded into 15-minute means. A bucket of
  // sixty samples is a full quarter hour; fewer is that share of one.
  const cold = db.prepare(`
    SELECT hostname, COALESCE(power_watts, 0) + COALESCE(gpu_power_watts, 0) AS watts, sample_count
      FROM mesh_snapshots_15m
     WHERE timestamp >= ? AND timestamp < ?
  `).all(sqliteTime(from), sqliteTime(to)) as { hostname: string; watts: number; sample_count: number }[];
  for (const r of cold) {
    const hours = 0.25 * Math.min(1, (r.sample_count ?? 0) / 60);
    add(r.hostname, (r.watts / 1000) * hours, hours);
  }
  return out;
}

interface Econ { ispCostMonthly?: number; electricityCostKwh?: number; provider?: string; location?: string; notes?: string }

function econFor(settings: Record<string, string>, host: string): Econ | null {
  const raw = settings[nodeEconKey(host)];
  if (!raw) return null;
  try { return JSON.parse(raw) as Econ; } catch { return null; }
}

// ── Builder ───────────────────────────────────────────────────────────────────

export function buildMonthlyCostReport(db: Database.Database, inp: CostReportInputs): MonthlyCostReport {
  if (!isValidMonth(inp.month)) throw new Error(`not a month: ${inp.month}`);
  if (!isValidTimeZone(inp.timeZone)) throw new Error(`not a time zone: ${inp.timeZone}`);
  ensurePricingHydrated(db);
  const now = inp.now ?? Date.now();
  const { start, end } = monthBounds(inp.month, inp.timeZone);
  const closed = now >= end;
  const until = Math.min(end, now);
  const from = new Date(start).toISOString();
  const to = new Date(end).toISOString();
  const settings = inp.settings;
  const lines: CostLine[] = [];
  const memo: MemoLine[] = [];
  const notes: string[] = [];
  const byProject = new Map<string, number>();
  const byModel = new Map<string, { usd: number; tokens: number; basis: CostBasis }>();

  const repoNames = inp.repoNames ? new Set(inp.repoNames) : null;
  // Folded onto its repo where the folded list knows one; otherwise kept
  // under its own name — a claim must still add up when a workspace was
  // never folded.
  const projectLabel = (name: string, display: string) => {
    const folded = repoNames && !repoNames.has(name) ? rollupTarget(name, repoNames) : null;
    if (folded) return inp.displayNames?.get(folded) ?? folded;
    return inp.displayNames?.get(name) ?? display;
  };

  // Model usage, one line per (model, basis).
  const modelLines = new Map<string, { model: string; basis: CostBasis; usd: number; tokens: number; messages: number }>();
  let coveredUSD = 0, coveredTokens = 0;
  let selfHostedUSD = 0, selfHostedTokens = 0;
  for (const g of readUsage(db, from, to)) {
    const tokens = g.input + g.output + g.cacheRead + g.cacheWrite;
    const c = costForUsage({
      model: g.model, input: g.input, output: g.output, cacheRead: g.cacheRead, cacheWrite: g.cacheWrite,
      provider: g.provider, endpoint: g.endpoint, at: g.day, observedUSD: g.observed,
    });
    if (c.selfHosted) { selfHostedUSD += c.total; selfHostedTokens += tokens; continue; }
    if (g.observed == null && inp.claudePlan && isClaudeCode(g.harness) && isAnthropicModel(g.model, g.provider)) {
      coveredUSD += c.total; coveredTokens += tokens;
      continue;
    }
    const basis: CostBasis = g.observed != null ? 'stated' : 'priced';
    const key = `${g.model}\0${basis}`;
    const ml = modelLines.get(key) ?? { model: g.model, basis, usd: 0, tokens: 0, messages: 0 };
    ml.usd += c.total; ml.tokens += tokens; ml.messages += g.messages;
    modelLines.set(key, ml);
    const project = projectLabel(g.project, g.projectDisplay);
    byProject.set(project, (byProject.get(project) ?? 0) + c.total);
    const bm = byModel.get(g.model) ?? { usd: 0, tokens: 0, basis };
    bm.usd += c.total; bm.tokens += tokens;
    if (basis === 'stated') bm.basis = 'stated';
    byModel.set(g.model, bm);
  }
  for (const ml of [...modelLines.values()].sort((a, b) => b.usd - a.usd)) {
    lines.push({
      category: 'model-api', item: ml.model, basis: ml.basis, usd: ml.usd,
      detail: `${(ml.tokens / 1e6).toFixed(2)}M tokens over ${ml.messages} messages${ml.basis === 'stated' ? ', as charged by the provider' : ', at the ledger price on each day'}`,
    });
  }
  if (coveredTokens > 0) {
    memo.push({
      item: `Claude Code usage covered by ${inp.claudePlan!.name}`,
      detail: `${(coveredTokens / 1e6).toFixed(2)}M tokens; API-equivalent value, not charged — the subscription line is the charge`,
      usd: coveredUSD,
    });
  }
  if (selfHostedTokens > 0) {
    memo.push({
      item: 'Self-hosted models, market value',
      detail: `${(selfHostedTokens / 1e6).toFixed(2)}M tokens; what the same work would cost to buy. Their cost is the electricity line`,
      usd: selfHostedUSD,
    });
  }

  // Subscriptions: a flat monthly charge, whole for the month it falls in.
  if (inp.claudePlan) {
    lines.push({
      category: 'subscription', item: inp.claudePlan.name, basis: 'flat', usd: inp.claudePlan.monthlyUSD,
      detail: 'monthly plan price for the detected subscription tier',
    });
  }

  // Extra usage: the last card-charge snapshot, when the billing period it
  // describes ends inside this month (or, for the running month, has not ended).
  const spent = parseFloat(String(settings.extra_usage_spent ?? '').replace(/[^0-9.]/g, ''));
  const updatedAt = Date.parse(settings.extra_usage_updated_at ?? '');
  if (Number.isFinite(spent) && spent > 0 && Number.isFinite(updatedAt) && updatedAt >= start && updatedAt < end + 7 * 86400_000) {
    lines.push({
      category: 'extra-usage', item: 'Claude extra usage', basis: 'stated', usd: spent,
      detail: `card charges as last read from claude.ai on ${new Date(updatedAt).toISOString().slice(0, 10)}${settings.extra_usage_reset_date ? `, period resetting ${settings.extra_usage_reset_date}` : ''}`,
    });
  }

  // Electricity and connectivity, per node the sampler saw this month.
  const excluded = parseExcludedHosts(settings);
  const defaultRate = parseFloat(settings.mesh_default_electricity_kwh) || getKwhRate();
  const hoursInPeriod = (until - start) / 3_600_000;
  const energy = readEnergy(db, start, until);
  const connections = new Map<string, { label: string; usd: number; hosts: string[] }>();
  let unconfigured = 0;
  for (const [host, e] of [...energy].sort(([a], [b]) => a.localeCompare(b))) {
    if (excluded.has(host)) continue;
    const econ = econFor(settings, host);
    const rate = econ?.electricityCostKwh || defaultRate;
    const cover = hoursInPeriod > 0 ? Math.min(100, (e.sampledHours / hoursInPeriod) * 100) : 0;
    lines.push({
      category: 'electricity', item: host, basis: 'measured', usd: e.kwh * rate,
      detail: `${e.kwh.toFixed(1)} kWh at $${rate.toFixed(3)}/kWh; sampled ${cover.toFixed(0)}% of the period`,
    });
    if (!econ) { unconfigured++; continue; }
    // Machines behind one connection share one bill. A connection is the
    // provider, place and ISP a node's saved economics name; nodes that
    // agree on all three and on the price are one line, not one each.
    const isp = econ.ispCostMonthly ?? DEFAULT_ISP_COST_MONTHLY;
    if (!(isp > 0)) continue;
    const key = [econ.provider ?? '', econ.location ?? '', econ.notes ?? '', isp].join('\0');
    const conn = connections.get(key) ?? {
      label: [econ.provider, econ.location, econ.notes].filter(Boolean).join(' · ') || host,
      usd: isp, hosts: [],
    };
    conn.hosts.push(host);
    connections.set(key, conn);
  }
  for (const c of connections.values()) {
    lines.push({
      category: 'connectivity', item: c.label, basis: 'flat', usd: c.usd,
      detail: `monthly bill shared by ${c.hosts.join(', ')}`,
    });
  }
  if (unconfigured > 0) {
    notes.push(`${unconfigured} node(s) have no economics configured: their electricity is at the default rate and they add no connectivity line.`);
  }

  const totalUSD = lines.reduce((a, l) => a + l.usd, 0);
  const byCategory = (Object.keys(CATEGORY_LABEL) as CostCategory[])
    .map((category) => ({ category, label: CATEGORY_LABEL[category], usd: lines.filter((l) => l.category === category).reduce((a, l) => a + l.usd, 0) }))
    .filter((c) => c.usd > 0);

  if (!closed) notes.push(`Month to date: figures run to ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC.`);
  notes.push('Model API lines are booked at the price in force on the day the tokens were spent; a later price change does not move them.');

  const currency = inp.currency ?? USD;
  return {
    $schema: 'unfirehose-cost-report/1',
    month: inp.month,
    timeZone: inp.timeZone,
    periodStart: from,
    periodEnd: to,
    closed,
    generatedAt: new Date(now).toISOString(),
    currency,
    lines: lines.map((l) => ({ ...l, usd: round2Exact(l.usd) })),
    memo: memo.map((m) => ({ ...m, usd: round2Exact(m.usd) })),
    byCategory: byCategory.map((c) => ({ ...c, usd: round2Exact(c.usd) })),
    byProject: [...byProject].map(([project, v]) => ({ project, usd: round2Exact(v) })).filter((p) => p.usd > 0).sort((a, b) => b.usd - a.usd),
    byModel: [...byModel].map(([model, v]) => ({ model, usd: round2Exact(v.usd), tokens: v.tokens, basis: v.basis })).sort((a, b) => b.usd - a.usd),
    totalUSD: round2Exact(totalUSD),
    notes,
  };
}

/** Cents, carried to four places so sub-cent lines still sum to the total. */
const round2Exact = (n: number) => Math.round(n * 10_000) / 10_000;

// ── Renderers ────────────────────────────────────────────────────────────────

/** Worth more per unit than any fiat, so two decimals would round most of it away. */
const CRYPTO = new Set(['BTC', 'ETH', 'SOL', 'XMR', 'LTC', 'DOGE', 'XRP', 'ADA', 'DOT', 'AVAX', 'MATIC', 'LINK', 'UNI', 'ZEC']);
export const isCryptoCurrency = (code: string) => CRYPTO.has(code);

/** A USD amount in the report's currency, as a plain number string. */
export function inReportCurrency(r: MonthlyCostReport, amountUSD: number): string {
  const v = amountUSD * r.currency.rate;
  return CRYPTO.has(r.currency.code) ? v.toFixed(8) : v.toFixed(2);
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** RFC 4180: one row per line, then memo rows, then the total. */
export function costReportCsv(r: MonthlyCostReport): string {
  const cur = r.currency.code;
  const head = ['month', 'category', 'item', 'detail', 'basis', `amount_${cur.toLowerCase()}`, 'amount_usd', 'counted'];
  const rows: (string | number)[][] = [head];
  for (const l of r.lines) rows.push([r.month, CATEGORY_LABEL[l.category], l.item, l.detail, l.basis, inReportCurrency(r, l.usd), l.usd.toFixed(2), 'yes']);
  for (const m of r.memo) rows.push([r.month, 'Memo', m.item, m.detail, '', inReportCurrency(r, m.usd), m.usd.toFixed(2), 'no']);
  rows.push([r.month, 'Total', '', r.closed ? 'closed month' : 'month to date', '', inReportCurrency(r, r.totalUSD), r.totalUSD.toFixed(2), 'yes']);
  if (r.currency.code !== 'USD') {
    rows.push([r.month, 'Rate', `1 USD = ${r.currency.rate} ${cur}`, `${r.currency.source ?? ''} rate for ${r.currency.rateDate ?? ''}`, '', '', '', 'no']);
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ── Filing ───────────────────────────────────────────────────────────────────

/**
 * Where a closed month is kept once built, per zone and currency: a month
 * read in Tokyo is a different nine hours, and a figure in euros was
 * converted at a rate that must not move. A claim re-downloaded next year
 * is the one that was filed, not a rebuild against a newer price ledger.
 */
export function costReportKey(month: string, timeZone: string, currency: string): string {
  return `cost_report_${month}_${timeZone.replace(/[^A-Za-z0-9]/g, '_')}_${currency}`;
}

export function readFiledReport(key: string): MonthlyCostReport | null {
  return readPayload<MonthlyCostReport>(key, Infinity)?.payload ?? null;
}

export function fileReport(key: string, report: MonthlyCostReport): void {
  storePayload(key, report, report.month);
}
