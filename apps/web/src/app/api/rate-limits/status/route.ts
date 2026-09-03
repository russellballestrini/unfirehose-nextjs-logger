import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { getSetting, setSetting } from '@unturf/unfirehose/db/ingest';
import {
  getStatusCurrent, getStatusHistory, pollAllStatusTargets, STATUS_TARGETS_SETTING,
} from '@unturf/unfirehose/status-pages';

/**
 * Vendor status pages as our worker last saw them.
 *
 *   GET  /api/rate-limits/status                       → { current: [...] }
 *   GET  /api/rate-limits/status?history=<id>&hours=24 → { history: [...] }
 *   POST { action: 'add', target: { id, name, feed, url? } }
 *   POST { action: 'remove', id }
 *   POST { action: 'poll' }                            → poll every target now
 */
export async function GET(req: NextRequest) {
  const db = getDb();
  const history = req.nextUrl.searchParams.get('history');
  if (history) {
    const hours = Number(req.nextUrl.searchParams.get('hours') ?? 24) || 24;
    return NextResponse.json({ target: history, hours, history: getStatusHistory(db, history, hours) });
  }
  return NextResponse.json({ current: getStatusCurrent(db) });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const db = getDb();
  if (body?.action === 'poll') {
    return NextResponse.json({ polls: await pollAllStatusTargets(db) });
  }
  let overrides: { added?: any[]; removed?: string[] } = {};
  try { overrides = JSON.parse(getSetting(STATUS_TARGETS_SETTING) ?? '{}'); } catch { overrides = {}; }
  overrides.added ??= [];
  overrides.removed ??= [];

  if (body?.action === 'add' && body.target?.id && body.target?.feed) {
    const t = body.target;
    let feed: URL;
    try { feed = new URL(t.feed); } catch { return NextResponse.json({ error: 'feed must be a URL' }, { status: 400 }); }
    if (feed.protocol !== 'https:') return NextResponse.json({ error: 'feed must be https' }, { status: 400 });
    overrides.added = overrides.added.filter((x) => x.id !== t.id).concat([{ id: String(t.id), name: String(t.name ?? t.id), feed: feed.toString(), url: t.url ?? feed.origin, kind: 'statuspage-feed' }]);
    overrides.removed = overrides.removed.filter((id) => id !== t.id);
  } else if (body?.action === 'remove' && body.id) {
    overrides.added = overrides.added.filter((x) => x.id !== body.id);
    if (!overrides.removed.includes(body.id)) overrides.removed.push(String(body.id));
  } else {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }
  setSetting(STATUS_TARGETS_SETTING, JSON.stringify(overrides));
  return NextResponse.json({ ok: true, current: getStatusCurrent(db) });
}
