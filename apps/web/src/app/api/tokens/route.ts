import { readFile, stat } from 'fs/promises';
import { claudePaths } from '@unturf/unfirehose/claude-paths';
import { NextRequest, NextResponse } from 'next/server';
import type { StatsCache } from '@unturf/unfirehose/types';
import { getDb } from '@unturf/unfirehose/db/schema';
import {
  TOKENS_RANGES,
  buildTokensPayload,
  rangeFrom,
  readTokensPayload,
  refreshTokensPayload,
} from '@unturf/unfirehose/tokens';
import { Timing } from '@/lib/timing';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Serve the Tokens payload the worker built.
 *
 * Building it was 13 s for lifetime and 6 s for the week the page opens on,
 * all of it on this single-threaded server, charged to every other request
 * while a Tokens page loaded. The worker now builds the ranges the page
 * offers (packages/core/tokens.ts); the page asks for one by name
 * (`?range=7d`, the dashboard's contract) and this serves it stale rather
 * than rebuilt, saying how old it is in X-Computed-At. No parameters at all
 * means lifetime. A range nobody warmed is built on its first request and
 * stored for the next.
 *
 * Two kinds of request cannot be answered from the store and build live, on
 * the fast query shapes: a project filter (one of thousands, never stored),
 * and explicit instants — `from` and `to` — which outside callers send and
 * which stand for whatever window they say, not for a stored range.
 */

// In-process memo of the stats-cache JSON keyed by mtime. The file is only
// touched by our background ingester so this hits 100% between ingests and
// we skip a 5-1800ms readFile+JSON.parse round-trip on every request.
let statsCacheMemo: { mtimeMs: number; data: StatsCache } | null = null;

export async function GET(request: NextRequest) {
  const t = new Timing();
  try {
    const url = request.nextUrl;
    const rangeParam = url.searchParams.get('range');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const project = url.searchParams.get('project');

    if (rangeParam !== null && !(rangeParam in TOKENS_RANGES)) {
      return NextResponse.json(
        { error: `Unknown range "${rangeParam}"`, ranges: Object.keys(TOKENS_RANGES) },
        { status: 400, headers: { 'Server-Timing': t.header() } },
      );
    }
    // No parameters at all is lifetime, as it always was.
    const range = rangeParam ?? (from || to ? null : 'all');

    const db = getDb();
    let payload: any;
    let computedAt: string | null = null;

    if (range && !project && !from && !to) {
      // Keep the last successful result available while the worker is busy.
      // X-Computed-At exposes its age; expiry must not move rebuilds here.
      const stored = readTokensPayload(range, Infinity);
      if (stored) {
        payload = stored.payload;
        computedAt = stored.at;
        t.mark('stored');
      } else {
        payload = refreshTokensPayload(range, {}, db);
        t.mark('built');
      }
    } else {
      // A named range with a project filter is that range's window, scoped.
      payload = buildTokensPayload(db, { from: from ?? (range ? rangeFrom(range) : undefined), to, project });
      t.mark('live');
    }

    // Read stats cache for daily activity (mtime-keyed memo to skip cold
    // disk reads under dev-mode FS contention).
    let dailyActivity: any[] = [];
    let dailyModelTokens: any[] = [];
    try {
      const st = await stat(claudePaths.statsCache);
      if (statsCacheMemo && statsCacheMemo.mtimeMs === st.mtimeMs) {
        dailyActivity = statsCacheMemo.data.dailyActivity ?? [];
        dailyModelTokens = statsCacheMemo.data.dailyModelTokens ?? [];
      } else {
        const raw = await readFile(claudePaths.statsCache, 'utf-8');
        const stats: StatsCache = JSON.parse(raw);
        statsCacheMemo = { mtimeMs: st.mtimeMs, data: stats };
        dailyActivity = stats.dailyActivity ?? [];
        dailyModelTokens = stats.dailyModelTokens ?? [];
      }
    } catch { /* stats cache missing is fine */ }
    t.mark('stats-cache');

    const headers: Record<string, string> = { 'Server-Timing': t.header() };
    if (computedAt) headers['X-Computed-At'] = computedAt;
    return NextResponse.json({ ...payload, dailyActivity, dailyModelTokens }, { headers });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to read token data', detail: String(err) },
      { status: 500, headers: { 'Server-Timing': t.header() } }
    );
  }
}
