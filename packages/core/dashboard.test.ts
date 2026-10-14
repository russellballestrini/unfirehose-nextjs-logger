import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb, seedProject, seedSession, seedMessage } from './test/db-helper';

const db = createTestDb();
vi.mock('./db/schema', () => ({ getDb: () => db }));

const { refreshDashboard, buildDashboard, storedDashboardRanges, WARM_RANGES } = await import('./dashboard');
const { readPayload } = await import('./precomputed');

/**
 * The worker rebuilds the warm ranges every minute. On a 6.6 GB database
 * that was ~3 s of every minute whether or not anything had been ingested,
 * and the payload written was the payload already there.
 */
describe('refreshDashboard', () => {
  let sessionId: number;
  beforeEach(() => {
    db.prepare('DELETE FROM messages').run();
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM projects').run();
    db.prepare("DELETE FROM settings WHERE key LIKE 'dashboard_%'").run();
    sessionId = seedSession(db, seedProject(db), `s-${Math.random()}`);
    seedMessage(db, sessionId, { inputTokens: 100, outputTokens: 10 });
  });

  it('builds when nothing is stored', () => {
    expect(refreshDashboard('24h', { unlessCurrentMs: 60_000 })).not.toBeNull();
    expect(readPayload('dashboard_24h', 60_000)).not.toBeNull();
  });

  it('skips a rebuild while no message has landed', () => {
    refreshDashboard('24h');
    const at = readPayload('dashboard_24h', 60_000)!.at;
    expect(refreshDashboard('24h', { unlessCurrentMs: 60_000 })).toBeNull();
    expect(readPayload('dashboard_24h', 60_000)!.at).toBe(at);
  });

  it('rebuilds once a message lands', () => {
    refreshDashboard('24h');
    seedMessage(db, sessionId, { inputTokens: 5, outputTokens: 5 });
    const payload = refreshDashboard('24h', { unlessCurrentMs: 60_000 });
    expect(payload).not.toBeNull();
    expect(payload.summary.messages).toBe(2);
  });

  it('stamps the watermark from before the build, so a mid-build arrival still triggers a rebuild', async () => {
    // Simulate a message landing while the build runs: the build reads the
    // watermark, then a row appears, then the payload is stored.
    const { messagesWatermark } = await import('./precomputed');
    const before = messagesWatermark();
    refreshDashboard('24h');
    seedMessage(db, sessionId, { inputTokens: 1, outputTokens: 1 });
    // A store stamped with the pre-build watermark reads as behind the table.
    expect(refreshDashboard('24h', { unlessCurrentMs: 60_000 })).not.toBeNull();
    expect(messagesWatermark()).not.toBe(before);
  });

  it('rebuilds a payload that has aged past the bound, message or not', () => {
    refreshDashboard('24h');
    expect(refreshDashboard('24h', { unlessCurrentMs: -1 })).not.toBeNull();
  });

  it('always builds without a bound — the route path', () => {
    refreshDashboard('24h');
    expect(refreshDashboard('24h')).not.toBeNull();
  });

  it('keeps ranges apart', () => {
    refreshDashboard('24h');
    expect(refreshDashboard('7d', { unlessCurrentMs: 60_000 })).not.toBeNull();
  });
});

/**
 * 90d, 365d and lifetime are not warmed. The route builds one on its first
 * request and stores it; the worker must then find it, or that build is
 * what the route serves forever — which is how the live 90d payload came
 * to be a month old.
 */
describe('storedDashboardRanges', () => {
  let sessionId: number;
  beforeEach(() => {
    db.prepare('DELETE FROM messages').run();
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM projects').run();
    db.prepare("DELETE FROM settings WHERE key LIKE 'dashboard_%'").run();
    sessionId = seedSession(db, seedProject(db), `s-${Math.random()}`);
    seedMessage(db, sessionId, { inputTokens: 100, outputTokens: 10 });
  });

  it('lists a range the route stored on first request', () => {
    refreshDashboard('90d'); // the route path: no bound
    expect(storedDashboardRanges()).toEqual(['90d']);
  });

  it('lists warm and unwarmed ranges alike; the worker subtracts its own', () => {
    for (const r of WARM_RANGES) refreshDashboard(r);
    refreshDashboard('365d');
    expect(storedDashboardRanges().sort()).toEqual([...WARM_RANGES, '365d'].sort());
  });

  it('refreshes a legacy payload that carries no watermark', () => {
    refreshDashboard('90d');
    db.prepare("DELETE FROM settings WHERE key = 'dashboard_90d_watermark'").run();
    const at = readPayload('dashboard_90d', Infinity)!.at;
    expect(storedDashboardRanges()).toEqual(['90d']);
    // No watermark means never current: the slow tick rebuilds it.
    expect(refreshDashboard('90d', { unlessCurrentMs: 60 * 60_000 })).not.toBeNull();
    expect(readPayload('dashboard_90d', Infinity)!.at >= at).toBe(true);
    expect(refreshDashboard('90d', { unlessCurrentMs: 60 * 60_000 })).toBeNull();
  });

  it('does not mistake another dashboard setting for a range', () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_theme_at', 'x')").run();
    expect(storedDashboardRanges()).toEqual([]);
  });
});

describe('buildDashboard', () => {
  it('runs the structural-reuse query on the window index the schema carries', () => {
    // INDEXED BY names idx_messages_window_usage; SQLite throws at prepare
    // time if a migration ever drops or renames it.
    const sessionId = seedSession(db, seedProject(db, 'p2', 'p2'), `s-${Math.random()}`);
    const t = new Date().toISOString();
    seedMessage(db, sessionId, { timestamp: t, inputTokens: 1000, outputTokens: 10, model: 'qwen-local' });
    seedMessage(db, sessionId, { timestamp: t, inputTokens: 1200, outputTokens: 10, model: 'qwen-local' });
    const payload = buildDashboard('24h');
    const row = payload.modelBreakdown.find((m: any) => m.model === 'qwen-local');
    expect(row).toBeDefined();
    expect(row.structuralReuseTokens).toBeGreaterThan(0);
  });
});
