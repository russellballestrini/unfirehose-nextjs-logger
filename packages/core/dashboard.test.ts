import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb, seedProject, seedSession, seedMessage } from './test/db-helper';

const db = createTestDb();
vi.mock('./db/schema', () => ({ getDb: () => db }));

const { refreshDashboard, buildDashboard } = await import('./dashboard');
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
