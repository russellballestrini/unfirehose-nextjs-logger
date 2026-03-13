import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';

// GET /api/sessions/nickname — all nicknames as { session_id: { nickname, host, service_name } }
export async function GET() {
  const db = getDb();
  const rows = db.prepare('SELECT session_id, nickname, host, service_name, updated_at FROM session_nicknames').all() as {
    session_id: string; nickname: string; host: string; service_name: string; updated_at: string;
  }[];
  const map: Record<string, { nickname: string; host: string; service_name: string; updated_at: string }> = {};
  for (const r of rows) map[r.session_id] = { nickname: r.nickname, host: r.host, service_name: r.service_name, updated_at: r.updated_at };
  return NextResponse.json(map);
}

// POST /api/sessions/nickname — upsert { session_id, nickname?, host?, service_name? }
export async function POST(request: NextRequest) {
  const { session_id, nickname, host, service_name } = await request.json();
  if (!session_id || typeof session_id !== 'string') {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }
  const db = getDb();
  db.prepare(`
    INSERT INTO session_nicknames (session_id, nickname, host, service_name, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(session_id) DO UPDATE SET
      nickname     = COALESCE(excluded.nickname,     nickname),
      host         = COALESCE(excluded.host,         host),
      service_name = COALESCE(excluded.service_name, service_name),
      updated_at   = datetime('now')
  `).run(
    session_id,
    nickname ?? null,
    host ?? null,
    service_name ?? null,
  );
  return NextResponse.json({ ok: true });
}

// DELETE /api/sessions/nickname — remove a nickname entry
export async function DELETE(request: NextRequest) {
  const { session_id } = await request.json();
  if (!session_id) return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  const db = getDb();
  db.prepare('DELETE FROM session_nicknames WHERE session_id = ?').run(session_id);
  return NextResponse.json({ ok: true });
}
