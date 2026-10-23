import { NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { getSetting, INGEST_HEARTBEAT_KEY } from '@unturf/unfirehose/db/ingest';
import { detectHarnesses } from '@unturf/unfirehose/harness-detect';
import { harnessSessionStats } from '@unturf/unfirehose/db/harness-stats';

/**
 * GET /api/onboarding — what a first run needs to know, all of it local.
 *
 * Which harnesses this machine has on disk (core's detector, the one Settings
 * and `make doctor` use), how much our database holds, and whether our worker
 * is alive: its ingest heartbeat, and the freshest stamp in the precomputed
 * store. The wizard polls this at the live cadence, so every query here is
 * an index seek or a scan of the small sessions table.
 */

// A worker writes its heartbeat every pass (a minute while active, at most
// five when quiet) and refreshes the project list every three minutes.
const WORKER_FRESH_MS = 10 * 60_000;
const PAYLOAD_KEYS = ['project_list', 'dashboard_7d', 'dashboard_24h', 'tokens_7d'];

export async function GET() {
  const db = getDb();
  const one = <T,>(sql: string) => db.prepare(sql).get() as T;
  const sessions = one<{ n: number }>('SELECT COUNT(*) AS n FROM sessions').n;
  const projects = one<{ n: number }>('SELECT COUNT(*) AS n FROM projects').n;
  // MAX(id) is one seek; COUNT(*) on messages is a scan of millions of rows.
  const messages = one<{ n: number | null }>('SELECT MAX(id) AS n FROM messages').n ?? 0;

  const lastIngestAt = getSetting(INGEST_HEARTBEAT_KEY) ?? null;
  const payloadAt = PAYLOAD_KEYS
    .map((k) => getSetting(`${k}_at`))
    .filter((v): v is string => !!v)
    .sort()
    .at(-1) ?? null;
  const now = Date.now();
  const fresh = (iso: string | null) => !!iso && now - Date.parse(iso) < WORKER_FRESH_MS;

  const stats = new Map(harnessSessionStats(db).map((s) => [s.harness, s]));
  const harnesses = detectHarnesses().map((h) => ({
    ...h,
    sessions: stats.get(h.id)?.sessions ?? 0,
    lastMessageAt: stats.get(h.id)?.lastMessageAt ?? null,
  }));

  return NextResponse.json({
    harnesses,
    sessions, projects, messages,
    lastIngestAt, payloadAt,
    workerAlive: fresh(lastIngestAt) || fresh(payloadAt),
    checkedAt: new Date(now).toISOString(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
