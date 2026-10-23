import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb, seedProject, seedSession, seedMessage } from '@unturf/unfirehose/test/db-helper';
import { setPriceCatalog } from '@unturf/unfirehose/pricing';

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));
vi.mock('@unturf/unfirehose/pricing-sync', () => ({ ensurePricingHydrated: () => {} }));
// No credentials are read in a test: the plan is whatever this says.
let tier = 'default_claude_max_20x';
vi.mock('@/lib/claude-plan', async (orig) => ({
  ...(await orig<typeof import('@/lib/claude-plan')>()),
  readClaudePlanIdentity: async () => ({ subscriptionType: 'max', rateLimitTier: tier, hasExtraUsageEnabled: false }),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { GET } = await import('./route');
const { setSetting } = await import('@unturf/unfirehose/db/ingest');

setPriceCatalog('openrouter', [
  { id: 'anthropic/claude-opus-5', source: 'openrouter', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, fetchedAt: 0 } as never,
]);

const get = (query: string) =>
  GET({ nextUrl: new URL(`http://localhost:3000/api/reports/monthly?${query}`) } as never);

beforeEach(() => {
  db.prepare("DELETE FROM settings WHERE key LIKE 'cost_report_%' OR key = 'display_currency' OR key = 'mesh_currency_oracle'").run();
  fetchMock.mockReset();
  tier = 'default_claude_max_20x';
});

const p = seedProject(db, '-home-fox-git-acme', 'acme');
const s = seedSession(db, p, 'r-1');
db.prepare("UPDATE sessions SET harness = 'uncloseai' WHERE id = ?").run(s);
seedMessage(db, s, { timestamp: '2026-09-15T12:00:00.000Z', model: 'claude-opus-5', inputTokens: 1_000_000, outputTokens: 1_000_000 });
db.prepare("UPDATE messages SET provider = 'anthropic'").run();

describe('GET /api/reports/monthly', () => {
  it('reports a closed month in dollars, with the subscription and the API usage', async () => {
    const res = await get('month=2026-09&tz=UTC');
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r).toMatchObject({ month: '2026-09', closed: true, totalUSD: 230, currency: { code: 'USD', rate: 1 } });
    expect(r.byProject).toEqual([{ project: 'acme', usd: 30 }]);
  });

  it('says beside the report, not in it, whether any message has ever landed', async () => {
    const r = await (await get('month=2026-08&tz=UTC')).json();
    expect(r.hasAnyMessages).toBe(true);
    const csv = await (await get('month=2026-08&tz=UTC&format=csv')).text();
    expect(csv).not.toContain('hasAnyMessages');
  });

  it('converts at the published rate for the month\'s last day, and files it so later downloads match', async () => {
    setSetting('display_currency', 'EUR,USD');
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ date: '2026-09-30', rates: { EUR: 0.9 } })));
    const first = await (await get('month=2026-09&tz=UTC&format=csv')).text();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('https://api.frankfurter.dev/v1/2026-09-30?base=USD&symbols=EUR'), expect.anything());
    expect(first).toContain('amount_eur');
    expect(first).toContain('2026-09,Total,,closed month,,207.00,230.00,yes');

    // The ledger moves and the rate moves; the filed month does not.
    tier = 'default_claude_pro';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ date: '2026-09-30', rates: { EUR: 2 } })));
    const pdf1 = Buffer.from(await (await get('month=2026-09&tz=UTC&format=pdf')).arrayBuffer());
    const pdf2 = Buffer.from(await (await get('month=2026-09&tz=UTC&format=pdf')).arrayBuffer());
    expect(pdf1.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf1.equals(pdf2)).toBe(true);
    expect(await (await get('month=2026-09&tz=UTC&format=csv')).text()).toBe(first);
    // Until asked to file it again.
    const rebuilt = await (await get('month=2026-09&tz=UTC&rebuild=1')).json();
    expect(rebuilt.totalUSD).toBe(50);
  });

  it('stays in dollars and says why when the rate cannot be had, and does not file that copy', async () => {
    setSetting('display_currency', 'NGN');
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ date: '2026-09-30', rates: {} })));
    const r = await (await get('month=2026-09&tz=UTC')).json();
    expect(r.currency).toMatchObject({ code: 'USD', rate: 1, fallbackReason: 'NGN unavailable: the ECB does not publish this currency' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'cost_report_%'").get()).toEqual({ n: 0 });
  });

  it('asks no oracle when the currency oracle is off', async () => {
    setSetting('display_currency', 'EUR');
    setSetting('mesh_currency_oracle', 'false');
    const r = await (await get('month=2026-09&tz=UTC')).json();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.currency.fallbackReason).toMatch(/turned off/);
  });

  it('refuses a bad month, zone or format, and a month not yet begun', async () => {
    expect((await get('month=2026-9')).status).toBe(400);
    expect((await get('month=2026-09&tz=Mars/Olympus')).status).toBe(400);
    expect((await get('month=2026-09&format=xlsx')).status).toBe(400);
    expect((await get('month=2999-01&tz=UTC')).status).toBe(400);
  });
});
