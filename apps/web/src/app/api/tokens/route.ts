import { readFile, stat } from 'fs/promises';
import { claudePaths } from '@unturf/unfirehose/claude-paths';
import { NextRequest, NextResponse } from 'next/server';
import type { StatsCache } from '@unturf/unfirehose/types';
import { getDb } from '@unturf/unfirehose/db/schema';
import {
  buildTokensPayload,
  readTokensPayload,
  refreshTokensPayload,
  snapRange,
} from '@unturf/unfirehose/tokens';
import { Timing } from '@/lib/timing';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Serve the Tokens payload the worker built.
 *
 * Building it was 13 s for lifetime and 6 s for the week the page opens on,
 * all of it on this single-threaded server, charged to every other request
 * while a Tokens page loaded. The worker now builds the ranges the page
 * offers (packages/core/tokens.ts); this serves whichever one the request's
 * window stands for, stale rather than rebuilt, and says how old it is in
 * X-Computed-At.
 *
 * Three requests cannot be answered from the store and build live, on the
 * fast query shapes: a project filter, an explicit `to`, or a `from` that
 * sits between the ranges. A range nobody warmed is built on its first
 * request and stored for the next.
 */

// In-process memo of the stats-cache JSON keyed by mtime. The file is only
// touched by our background ingester so this hits 100% between ingests and
// we skip a 5-1800ms readFile+JSON.parse round-trip on every request.
let statsCacheMemo: { mtimeMs: number; data: StatsCache } | null = null;

export async function GET(request: NextRequest) {
  const t = new Timing();
  try {
    const url = request.nextUrl;
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const project = url.searchParams.get('project');

    const db = getDb();
    let payload: any;
    let computedAt: string | null = null;

    const range = project ? null : snapRange(from, to);
    if (range) {
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
      payload = buildTokensPayload(db, { from, to, project });
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
