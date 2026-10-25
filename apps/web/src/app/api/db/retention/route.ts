import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import {
  getRetentionDays, setRetentionDays, parseRetentionDays, estimateColdMove, thawBatch, coldStats,
  MIN_RETENTION_DAYS, RETENTION_CHOICES,
} from '@unturf/unfirehose/db/block-cold';

export const dynamic = 'force-dynamic';

/** GET /api/db/retention — the window (null: keep everything) and what is cold now. */
export async function GET() {
  const db = getDb();
  return NextResponse.json({
    days: getRetentionDays(db),
    choices: RETENTION_CHOICES,
    minDays: MIN_RETENTION_DAYS,
    cold: coldStats(db),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * POST /api/db/retention
 *   { action: "estimate", days }  dry run: blocks and bytes a window would move; changes nothing
 *   { action: "set", days }       save the window (null or "off": keep everything); our worker moves text when idle
 *   { action: "thaw", days? }     put one batch of cold text back hot: all of it, or only inside `days`
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { action?: string; days?: unknown };
  const db = getDb();
  const days = parseRetentionDays(body.days);
  if (days === 'invalid') {
    return NextResponse.json({ error: `days must be a whole number, at least ${MIN_RETENTION_DAYS}, or null for keep everything` }, { status: 400 });
  }
  try {
    switch (body.action) {
      case 'estimate': {
        if (days == null) return NextResponse.json({ error: 'estimate needs days' }, { status: 400 });
        const t0 = Date.now();
        return NextResponse.json({ ...estimateColdMove(db, days), measuredMs: Date.now() - t0 });
      }
      case 'set':
        setRetentionDays(db, days);
        return NextResponse.json({ days: getRetentionDays(db), cold: coldStats(db) });
      case 'thaw': {
        const r = thawBatch(db, { keepDays: days, limit: 5000 });
        return NextResponse.json({ ...r, cold: coldStats(db) });
      }
      default:
        return NextResponse.json({ error: 'action must be estimate, set or thaw' }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
