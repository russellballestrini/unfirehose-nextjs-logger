import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createTestDb, seedProject, seedSession, seedMessage } from './test/db-helper';

const db = createTestDb();
vi.mock('./db/schema', () => ({ getDb: () => db }));

const { buildDashboard } = await import('./dashboard');
const { buildScrobblePayload } = await import('./scrobble');
const { buildProjectList } = await import('./projects-list');

/**
 * The three payloads the worker precomputes, against a database with
 * something in it.
 *
 * They are the most expensive functions we have and the least observed: each
 * one runs on a timer, in another process, and its output reaches a page
 * already serialised. A failure shows up as a blank dashboard, not as an
 * error. These assert the numbers a reader would check first — the ones a
 * silent SQL change would move.
 */
beforeAll(() => {
  const project = seedProject(db, 'demo-project');
  const session = seedSession(db, project, 'session-one');

  // Two models, so the per-model breakdown has something to separate, and a
  // cache read large enough that the cache columns cannot read as zero.
  seedMessage(db, session, {
    model: 'claude-opus-4-6-20260301',
    inputTokens: 1_000,
    outputTokens: 500,
    cacheReadTokens: 100_000,
    cacheCreationTokens: 2_000,
  });
  seedMessage(db, session, {
    model: 'claude-sonnet-4-5-20250929',
    inputTokens: 4_000,
    outputTokens: 250,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
});

describe('buildDashboard', () => {
  it('totals every kind of token it reports separately', () => {
    const payload = buildDashboard('24h');
    const { summary } = payload;

    // The four columns on the page must add up to the number beside them.
    expect(summary.totalTokens).toBe(
      summary.inputTokens + summary.outputTokens +
      summary.cacheReadTokens + summary.cacheWriteTokens,
    );
    expect(summary.inputTokens).toBe(5_000);
    expect(summary.outputTokens).toBe(750);
    expect(summary.cacheReadTokens).toBe(100_000);
    expect(summary.cacheWriteTokens).toBe(2_000);
  });

  it('splits cost by what was billed, not by one blended rate', () => {
    const { summary } = buildDashboard('24h');
    const split = summary.costSplit;

    // Cache read bills at a tenth of input and cache write above it, so a
    // single rate across all four would be wrong in both directions.
    expect(split).toHaveProperty('input');
    expect(split).toHaveProperty('output');
    expect(split).toHaveProperty('cacheRead');
    expect(split).toHaveProperty('cacheWrite');
    const summed = split.input + split.output + split.cacheRead + split.cacheWrite;
    expect(summed).toBeCloseTo(summary.totalCost, 1);
  });

  it('breaks usage down per model', () => {
    const { modelBreakdown } = buildDashboard('24h');
    const models = modelBreakdown.map((m: { model: string }) => m.model);
    expect(models).toContain('claude-opus-4-6-20260301');
    expect(models).toContain('claude-sonnet-4-5-20250929');

    const opus = modelBreakdown.find((m: { model: string }) => m.model === 'claude-opus-4-6-20260301');
    expect(opus.cacheReadTokens).toBe(100_000);
  });

  it('answers every range the worker keeps warm', () => {
    // A range that throws here is a dashboard that renders empty, because
    // the failure happens in the worker where nobody is looking.
    for (const range of ['1h', '24h', '7d', '28d', 'all']) {
      expect(() => buildDashboard(range)).not.toThrow();
    }
  });

  it('reports zeros rather than nulls for a window with no traffic', () => {
    // Every one of these reaches the page as a number to format.
    const { summary } = buildDashboard('1h');
    for (const key of ['sessions', 'messages', 'totalTokens', 'totalCost']) {
      expect(typeof summary[key]).toBe('number');
    }
  });
});

describe('buildScrobblePayload', () => {
  it('counts the work it found, and declares which spec it speaks', () => {
    const payload = buildScrobblePayload(db);
    // A public payload names its own format; a consumer reading it years
    // from now has no other way to know what the fields mean.
    expect(payload.$schema).toBe('unfirehose-scrobble/1.0');
    expect(payload.lifetime.totalSessions).toBe(1);
    expect(payload.lifetime.totalMessages).toBe(2);
    expect(payload.lifetime.totalCacheRead).toBe(100_000);
    expect(payload.streaks.current).toBeGreaterThan(0);
  });

  it('awards badges as facts about the data, not as a fixed list', () => {
    const payload = buildScrobblePayload(db);
    expect(Array.isArray(payload.badges)).toBe(true);
    // Every badge is answerable: it says whether it was earned.
    for (const badge of payload.badges) {
      expect(typeof badge.earned).toBe('boolean');
      expect(badge.id).toBeTruthy();
    }
  });
});

describe('buildProjectList', () => {
  it('lists a project with its session and message counts', async () => {
    const rows = await buildProjectList();
    const demo = rows.find((p) => p.name === 'demo-project');

    expect(demo).toBeTruthy();
    expect(demo!.sessionCount).toBe(1);
    expect(demo!.totalMessages).toBe(2);
    // Token columns stay split by kind all the way to the page, because a
    // blended total cannot be priced.
    expect(demo!.tokens).toEqual({ input: 5_000, output: 750, cacheRead: 100_000, cacheWrite: 2_000 });
  });
});
