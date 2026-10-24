import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb, seedProject, seedSession, seedMessage } from './test/db-helper';
import { setPriceCatalog } from './pricing';

const db = createTestDb();
vi.mock('./db/schema', () => ({ getDb: () => db }));
// The catalog is set by hand below; never reach for the oracles.
vi.mock('./pricing-sync', () => ({ ensurePricingHydrated: () => {} }));

const {
  buildMonthlyCostReport, monthBounds, previousMonth, costReportCsv, isValidMonth, isValidTimeZone,
} = await import('./cost-report');
const { nodeEconKey } = await import('./mesh-econ');
const { refreshEnergyAttribution } = await import('./energy-attribution');
const { costReportKey, fileReport, readFiledReport } = await import('./cost-report');

// $5 / $25 per million in and out: a million of each is $30.
setPriceCatalog('openrouter', [
  { id: 'anthropic/claude-opus-5', source: 'openrouter', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, fetchedAt: 0 } as never,
]);

const NOW = Date.parse('2026-11-05T12:00:00Z');
const base = { month: '2026-10', timeZone: 'UTC', settings: {} as Record<string, string>, claudePlan: null, now: NOW };

let sid = 0;
function session(project: string, harness: string | null = 'claude-code') {
  const p = (db.prepare('SELECT id FROM projects WHERE name = ?').get(project) as { id: number } | undefined)?.id
    ?? seedProject(db, project, project.replace(/^-home-fox-git-/, ''));
  const s = seedSession(db, p, `s-${++sid}`);
  db.prepare('UPDATE sessions SET harness = ? WHERE id = ?').run(harness, s);
  return s;
}
function msg(s: number, ts: string, model: string, input: number, output: number, extra: { provider?: string; observed?: number } = {}) {
  const id = seedMessage(db, s, { timestamp: ts, model, inputTokens: input, outputTokens: output });
  db.prepare('UPDATE messages SET provider = ?, observed_cost_usd = ? WHERE id = ?').run(extra.provider ?? null, extra.observed ?? null, id);
}
function sample(host: string, ts: string, watts: number, gpu = 0) {
  db.prepare('INSERT INTO mesh_snapshots (timestamp, hostname, power_watts, gpu_power_watts) VALUES (?, ?, ?, ?)')
    .run(ts.replace('T', ' ').slice(0, 19), host, watts, gpu);
}

beforeEach(() => {
  for (const t of ['messages', 'sessions', 'projects', 'mesh_snapshots', 'mesh_snapshots_15m', 'node_energy_15m', 'energy_attribution_15m']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare(`DELETE FROM settings WHERE key LIKE 'energy_attribution%' OR key LIKE 'cost_report%'`).run();
});

describe('months', () => {
  it('is a local calendar month, DST included', () => {
    const { start, end } = monthBounds('2026-03', 'America/New_York');
    expect(new Date(start).toISOString()).toBe('2026-03-01T05:00:00.000Z');
    // DST began 8 March: April opens at UTC-4.
    expect(new Date(end).toISOString()).toBe('2026-04-01T04:00:00.000Z');
    expect(new Date(monthBounds('2026-12', 'Asia/Tokyo').end).toISOString()).toBe('2026-12-31T15:00:00.000Z');
  });

  it('names last month for a claim, and refuses what is not a month or a zone', () => {
    expect(previousMonth('UTC', NOW)).toBe('2026-10');
    expect(previousMonth('UTC', Date.parse('2026-01-03T00:00:00Z'))).toBe('2025-12');
    expect(isValidMonth('2026-13')).toBe(false);
    expect(isValidMonth('2026-1')).toBe(false);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(() => buildMonthlyCostReport(db, { ...base, month: 'october' })).toThrow();
  });
});

describe('model usage', () => {
  it('prices API usage per model, books it to its project, and leaves other months out', () => {
    const s = session('-home-fox-git-acme');
    msg(s, '2026-10-03T10:00:00.000Z', 'claude-opus-5', 1_000_000, 1_000_000);
    msg(s, '2026-09-30T23:59:59.000Z', 'claude-opus-5', 1_000_000, 0);
    msg(s, '2026-11-01T00:00:00.000Z', 'claude-opus-5', 1_000_000, 0);
    const r = buildMonthlyCostReport(db, base);
    expect(r.lines).toEqual([expect.objectContaining({ category: 'model-api', item: 'claude-opus-5', basis: 'priced', usd: 30 })]);
    expect(r.totalUSD).toBe(30);
    expect(r.byProject).toEqual([{ project: 'acme', usd: 30 }]);
    expect(r.closed).toBe(true);
  });

  it('takes what a provider stated over our estimate, as its own line', () => {
    const s = session('-home-fox-git-acme', 'uncloseai');
    msg(s, '2026-10-03T10:00:00.000Z', 'claude-opus-5', 1_000_000, 1_000_000, { provider: 'openrouter', observed: 4.2 });
    msg(s, '2026-10-04T10:00:00.000Z', 'claude-opus-5', 1_000_000, 1_000_000, { provider: 'openrouter' });
    const r = buildMonthlyCostReport(db, base);
    expect(r.lines.map((l) => [l.item, l.basis, l.usd])).toEqual([['claude-opus-5', 'priced', 30], ['claude-opus-5', 'stated', 4.2]]);
    expect(r.byModel).toEqual([{ model: 'claude-opus-5', usd: 34.2, tokens: 4_000_000, basis: 'stated' }]);
  });

  it('does not bill Claude Code twice when a subscription pays for it', () => {
    const cc = session('-home-fox-git-acme', 'claude-code');
    const api = session('-home-fox-git-acme', 'uncloseai');
    msg(cc, '2026-10-03T10:00:00.000Z', 'claude-opus-5', 1_000_000, 1_000_000);
    msg(api, '2026-10-03T10:00:00.000Z', 'claude-opus-5', 1_000_000, 1_000_000, { provider: 'anthropic' });
    const r = buildMonthlyCostReport(db, { ...base, claudePlan: { name: 'Claude Max 20x', monthlyUSD: 200 } });
    expect(r.lines.map((l) => [l.category, l.usd])).toEqual([['model-api', 30], ['subscription', 200]]);
    expect(r.memo).toEqual([expect.objectContaining({ item: 'Claude Code usage covered by Claude Max 20x', usd: 30 })]);
    expect(r.totalUSD).toBe(230);
    // Without a plan the same usage is simply priced.
    expect(buildMonthlyCostReport(db, base).totalUSD).toBe(60);
  });

  it('keeps a scratch workspace with its repo when the folded list knows the repo', () => {
    // $5 per million in: each of these is $5.
    msg(session('-home-fox-git-acme'), '2026-10-03T10:00:00.000Z', 'claude-opus-5', 1_000_000, 0, { provider: 'anthropic' });
    msg(session('-home-fox-git-acme-worktree-7'), '2026-10-03T10:00:00.000Z', 'claude-opus-5', 1_000_000, 0, { provider: 'anthropic' });
    msg(session('-tmp-scratch'), '2026-10-03T10:00:00.000Z', 'claude-opus-5', 1_000_000, 0, { provider: 'anthropic' });
    const r = buildMonthlyCostReport(db, {
      ...base, repoNames: ['-home-fox-git-acme'], displayNames: new Map([['-home-fox-git-acme', 'Acme Corp']]),
    });
    expect(r.byProject).toEqual([{ project: 'Acme Corp', usd: 10 }, { project: '-tmp-scratch', usd: 5 }]);
  });
});

describe('the fleet', () => {
  it('integrates watts over the month at each node\'s own rate, and says how much was sampled', () => {
    // 1 kW for an hour, sampled every 15 s, at $0.50.
    for (let i = 0; i <= 240; i++) sample('cammy', new Date(Date.parse('2026-10-10T00:00:00Z') + i * 15_000).toISOString(), 800, 200);
    // A cold-tier bucket: 600 W mean for a full quarter hour.
    db.prepare('INSERT INTO mesh_snapshots_15m (timestamp, hostname, power_watts, gpu_power_watts, sample_count) VALUES (?, ?, ?, ?, ?)')
      .run('2026-10-02 00:00:00', 'cammy', 600, 0, 60);
    const settings = { [nodeEconKey('cammy')]: JSON.stringify({ electricityCostKwh: 0.5, ispCostMonthly: 0 }) };
    const r = buildMonthlyCostReport(db, { ...base, settings });
    const line = r.lines.find((l) => l.category === 'electricity')!;
    expect(line.item).toBe('cammy');
    expect(line.usd).toBeCloseTo((1 + 0.15) * 0.5, 4);
    expect(line.detail).toContain('1.1 kWh at $0.500/kWh');
    expect(line.detail).toMatch(/sampled 0% of the period/);
  });

  it('bills a shared connection once, skips hidden nodes, and says which nodes had no economics', () => {
    for (const h of ['cammy', 'ken', 'guile', 'zangief']) {
      sample(h, '2026-10-10T00:00:00Z', 100);
      sample(h, '2026-10-10T00:01:00Z', 100);
    }
    const home = JSON.stringify({ provider: 'home', location: 'New London, CT', notes: 'Comcast', ispCostMonthly: 110, electricityCostKwh: 0.33 });
    const settings = {
      [nodeEconKey('cammy')]: home,
      [nodeEconKey('ken')]: home,
      [nodeEconKey('zangief')]: home,
      mesh_excluded_hosts: JSON.stringify(['zangief']),
    };
    const r = buildMonthlyCostReport(db, { ...base, settings });
    expect(r.lines.filter((l) => l.category === 'electricity').map((l) => l.item)).toEqual(['cammy', 'guile', 'ken']);
    expect(r.lines.filter((l) => l.category === 'connectivity')).toEqual([expect.objectContaining({
      item: 'home · New London, CT · Comcast', usd: 110, detail: 'monthly bill shared by cammy, ken',
    })]);
    expect(r.notes[0]).toMatch(/^1 node\(s\) have no economics configured/);
  });
});

describe('the fleet, attributed (ticket 4004)', () => {
  /** A day at 100 W idle, then an hour at 400 W, a quarter of it one project's session on our node. */
  function seedAttributed() {
    const day = Date.parse('2026-10-09T00:00:00Z');
    for (let t = day; t < day + 26 * 3_600_000; t += 60_000) {
      const busy = t >= day + 25 * 3_600_000;
      sample('cammy', new Date(t).toISOString(), 60, busy ? 340 : 40);
    }
    const s = session('-home-fox-git-acme', 'uncloseai');
    const id = seedMessage(db, s, { timestamp: '2026-10-10T01:05:00.000Z', model: 'hermes-3-8b', inputTokens: 0, outputTokens: 2000 });
    db.prepare(`UPDATE messages SET endpoint = 'http://cammy:8000/v1', provider = 'local' WHERE id = ?`).run(id);
    refreshEnergyAttribution(db, { now: NOW, budgetMs: Infinity, chunkDays: 40 });
  }
  const settings = { [nodeEconKey('cammy')]: JSON.stringify({ electricityCostKwh: 0.5, ispCostMonthly: 0 }) };

  it('says how a node\'s kWh divide, without moving the line or the total', () => {
    seedAttributed();
    const r = buildMonthlyCostReport(db, { ...base, settings });
    const line = r.lines.find((l) => l.category === 'electricity')!;
    // The line is the same integral it always was: 25 h at 100 W plus 1 h at 400 W.
    expect(line.usd).toBeCloseTo(((25 * 100 + 400) / 1000) * 0.5, 2);
    expect(r.totalUSD).toBe(line.usd);
    expect(line.detail).toMatch(/standing \(idle ~100 W\)/);
    expect(line.detail).toMatch(/serving our sessions/);
    // The session's quarter hour above idle, booked to its project: 300 W for 0.25 h.
    expect(r.electricityByProject).toEqual([{ project: 'acme', usd: expect.closeTo(0.3 * 0.25 * 0.5, 3) }]);
    // It explains part of the electricity line; it is not added to model spend.
    expect(r.byProject).toEqual([]);
  });

  it('a filed month reads back as filed, whatever the attribution tables learn later', () => {
    for (let i = 0; i <= 240; i++) sample('cammy', new Date(Date.parse('2026-10-10T00:00:00Z') + i * 15_000).toISOString(), 800, 200);
    const before = buildMonthlyCostReport(db, { ...base, settings });
    const key = costReportKey('2026-10', 'UTC', 'USD');
    fileReport(key, before);
    seedAttributed();
    expect(readFiledReport(key)).toEqual(JSON.parse(JSON.stringify(before)));
    expect(readFiledReport(key)!.electricityByProject).toEqual([]);
  });
});

describe('extra usage and the running month', () => {
  it('counts a card-charge snapshot taken in the month, and marks a month still running', () => {
    const settings = { extra_usage_spent: '$42.50', extra_usage_updated_at: '2026-11-02T09:00:00Z', extra_usage_reset_date: 'Nov 1' };
    const oct = buildMonthlyCostReport(db, { ...base, settings });
    expect(oct.lines).toEqual([expect.objectContaining({ category: 'extra-usage', usd: 42.5, basis: 'stated' })]);
    const sep = buildMonthlyCostReport(db, { ...base, month: '2026-09', settings });
    expect(sep.lines).toEqual([]);
    const nov = buildMonthlyCostReport(db, { ...base, month: '2026-11' });
    expect(nov.closed).toBe(false);
    expect(nov.notes.some((n) => n.startsWith('Month to date'))).toBe(true);
  });
});

describe('CSV', () => {
  it('writes one row per line, memo rows marked not counted, a total, and the rate it converted at', () => {
    msg(session('-home-fox-git-acme', 'claude-code'), '2026-10-03T10:00:00.000Z', 'claude-opus-5', 1_000_000, 1_000_000);
    const r = buildMonthlyCostReport(db, {
      ...base, claudePlan: { name: 'Claude Max 20x', monthlyUSD: 200 },
      currency: { code: 'EUR', rate: 0.9, rateDate: '2026-10-30', source: 'ECB via Frankfurter' },
    });
    const rows = costReportCsv(r).trimEnd().split('\r\n');
    expect(rows[0]).toBe('month,category,item,detail,basis,amount_eur,amount_usd,counted');
    expect(rows[1]).toBe('2026-10,Subscriptions,Claude Max 20x,monthly plan price for the detected subscription tier,flat,180.00,200.00,yes');
    expect(rows[2]).toMatch(/^2026-10,Memo,Claude Code usage covered by Claude Max 20x,".*",,27\.00,30\.00,no$/);
    expect(rows[3]).toBe('2026-10,Total,,closed month,,180.00,200.00,yes');
    expect(rows[4]).toBe('2026-10,Rate,1 USD = 0.9 EUR,ECB via Frankfurter rate for 2026-10-30,,,,no');
  });
});
