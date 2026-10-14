import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb, seedProject, seedSession, seedMessage, seedContentBlock } from './test/db-helper';

const db = createTestDb();
vi.mock('./db/schema', () => ({ getDb: () => db }));

const {
  buildTokensPayload,
  rangeFrom,
  refreshTokensPayload,
  readTokensPayload,
  storedTokensRanges,
  TOKENS_RANGES,
} = await import('./tokens');
const { readPayload } = await import('./precomputed');

const DAY = 86400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function seedHarnessSession(projectId: number, uuid: string, harness: string): number {
  const id = seedSession(db, projectId, uuid);
  db.prepare('UPDATE sessions SET harness = ? WHERE id = ?').run(harness, id);
  return id;
}

function seedToolMessage(sessionId: number, opts: { model: string; timestamp?: string; tool?: string; input?: number }) {
  const messageId = seedMessage(db, sessionId, {
    model: opts.model,
    timestamp: opts.timestamp,
    inputTokens: opts.input ?? 1_000_000,
    outputTokens: 500_000,
  });
  seedContentBlock(db, messageId, { blockType: 'text' });
  seedContentBlock(db, messageId, { position: 1, blockType: 'tool_use', toolName: opts.tool ?? 'Bash' });
  return messageId;
}

beforeEach(() => {
  db.prepare('DELETE FROM content_blocks').run();
  db.prepare('DELETE FROM messages').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM projects').run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'tokens_%'").run();
});

/**
 * The route used to do all of this itself, and a test of the route is what
 * guarded the shape. The payload now has to carry the same keys whether the
 * worker built it or a request did.
 */
describe('buildTokensPayload', () => {
  it('rolls tokens, cost, tools, harnesses and block types out of one seeded session', () => {
    const projectId = seedProject(db, 'proj-a');
    const sessionId = seedHarnessSession(projectId, 's1', 'claude-code');
    seedToolMessage(sessionId, { model: 'claude-opus-4-6' });

    const p = buildTokensPayload(db);

    expect(p.modelBreakdown).toHaveLength(1);
    expect(p.modelBreakdown[0].model).toBe('claude-opus-4-6');
    expect(p.modelBreakdown[0].costUSD).toBeGreaterThan(0);
    expect(p.totalCost).toBeCloseTo(p.modelBreakdown[0].costUSD, 10);
    expect(p.totalTokens).toBe(1_500_000);
    expect(p.toolCalls).toEqual([{ tool_name: 'Bash', count: 1 }]);
    expect(p.toolsByModel).toEqual([{ model: 'claude-opus-4-6', count: 1 }]);
    expect(p.toolsByHarness).toEqual([{ harness: 'claude-code', tool_name: 'Bash', count: 1 }]);
    expect(p.harnessData.map((h: { harness: string }) => h.harness)).toEqual(['claude-code']);
    expect(p.harnessSessions).toEqual([{ harness: 'claude-code', sessions: 1 }]);
    expect(p.harnessModelBreakdown[0]).toMatchObject({ harness: 'claude-code', model: 'claude-opus-4-6', sessions: 1 });
    // Two, because the seeded tool call IS a content block with its own type.
    expect(p.blockTypes.map((b: { block_type: string }) => b.block_type).sort()).toEqual(['text', 'tool_use']);
    expect(p.dailyByHarness).toHaveLength(1);
    expect(p.dailyByHarness[0]).toMatchObject({ harness: 'claude-code', tokens: 1_500_000, messages: 1 });
  });

  it('carries every key the Tokens page reads', () => {
    const p = buildTokensPayload(db);
    expect(Object.keys(p).sort()).toEqual([
      'blockTypes', 'dailyByHarness', 'harnessData', 'harnessModelBreakdown', 'harnessSessions',
      'modelBreakdown', 'toolCalls', 'toolsByHarness', 'toolsByModel',
      'totalCacheRead', 'totalCacheReadCost', 'totalCacheWrite', 'totalCacheWriteCost',
      'totalCost', 'totalInput', 'totalInputCost', 'totalOutput', 'totalOutputCost', 'totalTokens',
    ]);
  });

  // The bounded build takes a different path through SQL than lifetime does
  // — messages as the outer loop, the window index — so a message outside
  // the window has to vanish from every figure, not just the first one.
  it('a date window excludes older messages from tokens, tools and block types alike', () => {
    const projectId = seedProject(db, 'proj-a');
    const sessionId = seedHarnessSession(projectId, 's1', 'claude-code');
    seedToolMessage(sessionId, { model: 'old-model', timestamp: iso(40 * DAY), tool: 'Read' });
    seedToolMessage(sessionId, { model: 'new-model', timestamp: iso(1 * DAY), tool: 'Bash' });

    const week = buildTokensPayload(db, { from: iso(7 * DAY) });
    expect(week.modelBreakdown.map((m: { model: string }) => m.model)).toEqual(['new-model']);
    expect(week.toolCalls).toEqual([{ tool_name: 'Bash', count: 1 }]);
    expect(week.blockTypes.reduce((s: number, b: { count: number }) => s + b.count, 0)).toBe(2);

    const all = buildTokensPayload(db);
    expect(all.modelBreakdown).toHaveLength(2);
    expect(all.toolCalls.map((t: { tool_name: string }) => t.tool_name).sort()).toEqual(['Bash', 'Read']);

    // A long window takes lifetime's path through SQL — tool blocks as the
    // outer loop — with the date filter riding along. Same answer.
    const year = buildTokensPayload(db, { from: iso(365 * DAY) });
    expect(year.modelBreakdown).toHaveLength(2);
    expect(year.toolCalls.map((t: { tool_name: string }) => t.tool_name).sort()).toEqual(['Bash', 'Read']);
    const yearButNotThen = buildTokensPayload(db, { from: iso(365 * DAY), to: iso(10 * DAY) });
    expect(yearButNotThen.modelBreakdown.map((m: { model: string }) => m.model)).toEqual(['old-model']);
    expect(yearButNotThen.toolCalls).toEqual([{ tool_name: 'Read', count: 1 }]);
  });

  it('an explicit `to` bounds the window from above', () => {
    const projectId = seedProject(db, 'proj-a');
    const sessionId = seedHarnessSession(projectId, 's1', 'claude-code');
    seedToolMessage(sessionId, { model: 'old-model', timestamp: iso(40 * DAY) });
    seedToolMessage(sessionId, { model: 'new-model', timestamp: iso(1 * DAY) });

    const p = buildTokensPayload(db, { from: iso(60 * DAY), to: iso(30 * DAY) });
    expect(p.modelBreakdown.map((m: { model: string }) => m.model)).toEqual(['old-model']);
  });

  // The project filter used to run in JS after a full scan. It is SQL now,
  // and the figures a project sees must be its own.
  it('a project scope keeps only that project\'s tokens and tools', () => {
    const a = seedHarnessSession(seedProject(db, 'proj-a'), 's-a', 'claude-code');
    const b = seedHarnessSession(seedProject(db, 'proj-b'), 's-b', 'uncloseai');
    seedToolMessage(a, { model: 'model-a', tool: 'Bash', input: 10 });
    seedToolMessage(b, { model: 'model-b', tool: 'Edit', input: 20 });

    const p = buildTokensPayload(db, { project: 'proj-b' });
    expect(p.modelBreakdown.map((m: { model: string }) => m.model)).toEqual(['model-b']);
    expect(p.totalInput).toBe(20);
    expect(p.toolCalls).toEqual([{ tool_name: 'Edit', count: 1 }]);
    expect(p.harnessData.map((h: { harness: string }) => h.harness)).toEqual(['uncloseai']);
    expect(p.harnessSessions).toEqual([{ harness: 'uncloseai', sessions: 1 }]);
  });

  it('a project scope and a window compose', () => {
    const a = seedHarnessSession(seedProject(db, 'proj-a'), 's-a', 'claude-code');
    seedToolMessage(a, { model: 'old-model', timestamp: iso(40 * DAY) });
    seedToolMessage(a, { model: 'new-model', timestamp: iso(1 * DAY) });
    seedToolMessage(seedHarnessSession(seedProject(db, 'proj-b'), 's-b', 'claude-code'), { model: 'other' });

    const p = buildTokensPayload(db, { project: 'proj-a', from: iso(7 * DAY) });
    expect(p.modelBreakdown.map((m: { model: string }) => m.model)).toEqual(['new-model']);
  });

  it('a session without a harness books under unknown', () => {
    const sessionId = seedSession(db, seedProject(db, 'proj-a'), 's1');
    seedToolMessage(sessionId, { model: 'm' });
    const p = buildTokensPayload(db);
    expect(p.harnessData.map((h: { harness: string }) => h.harness)).toEqual(['unknown']);
    expect(p.toolsByHarness[0].harness).toBe('unknown');
  });
});

describe('rangeFrom', () => {
  const now = Date.parse('2026-10-14T12:00:00.000Z');

  it('lifetime has no lower bound', () => {
    expect(rangeFrom('all', now)).toBeUndefined();
  });

  it('a named range is its minutes back from now', () => {
    for (const [range, minutes] of Object.entries(TOKENS_RANGES)) {
      if (!minutes) continue;
      expect(rangeFrom(range, now)).toBe(new Date(now - minutes * 60_000).toISOString());
    }
  });
});

/**
 * Same contract as the dashboard: rebuild only when a message has landed or
 * the bound has passed, so a quiet worker does not rewrite what is there.
 */
describe('refreshTokensPayload', () => {
  let sessionId: number;
  beforeEach(() => {
    sessionId = seedHarnessSession(seedProject(db, 'proj-a'), `s-${Math.random()}`, 'claude-code');
    seedToolMessage(sessionId, { model: 'm' });
  });

  it('builds when nothing is stored, and the store reads back', () => {
    expect(refreshTokensPayload('7d', { unlessCurrentMs: 60_000 }, db)).not.toBeNull();
    expect(readTokensPayload('7d', 60_000)?.payload.modelBreakdown).toHaveLength(1);
    expect(readPayload('tokens_7d', 60_000)).not.toBeNull();
  });

  it('skips a rebuild while no message has landed', () => {
    refreshTokensPayload('7d', { unlessCurrentMs: 60_000 }, db);
    expect(refreshTokensPayload('7d', { unlessCurrentMs: 60_000 }, db)).toBeNull();
  });

  it('rebuilds once a message lands', () => {
    refreshTokensPayload('7d', { unlessCurrentMs: 60_000 }, db);
    seedToolMessage(sessionId, { model: 'm2' });
    const p = refreshTokensPayload('7d', { unlessCurrentMs: 60_000 }, db);
    expect(p).not.toBeNull();
    expect(p.modelBreakdown).toHaveLength(2);
  });

  it('always builds without a bound — the route path', () => {
    refreshTokensPayload('7d', {}, db);
    expect(refreshTokensPayload('7d', {}, db)).not.toBeNull();
  });

  it('a range is its window: lifetime sees what 24h does not', () => {
    seedToolMessage(sessionId, { model: 'old', timestamp: iso(40 * DAY) });
    expect(refreshTokensPayload('24h', {}, db).modelBreakdown).toHaveLength(1);
    expect(refreshTokensPayload('all', {}, db).modelBreakdown).toHaveLength(2);
  });

  it('lists the ranges it has stored, and only ranges', () => {
    expect(storedTokensRanges(db)).toEqual([]);
    refreshTokensPayload('90d', {}, db);
    refreshTokensPayload('all', {}, db);
    db.prepare("INSERT INTO settings (key, value) VALUES ('tokens_bogus_at', 'x')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('tokensXall_at', 'x')").run();
    expect(storedTokensRanges(db).sort()).toEqual(['90d', 'all']);
  });
});
