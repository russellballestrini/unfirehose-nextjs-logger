import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';

// GET /api/providence?uri=...&root=...&git=...&model_id=...&limit=50
export async function GET(request: NextRequest) {
  const uri      = request.nextUrl.searchParams.get('uri');
  const root     = request.nextUrl.searchParams.get('root');
  const git      = request.nextUrl.searchParams.get('git');
  const model_id = request.nextUrl.searchParams.get('model_id');
  const limit    = Math.min(parseInt(request.nextUrl.searchParams.get('limit') ?? '50'), 200);

  try {
    const db = getDb();
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (uri)      { conditions.push('document_uri = ?');  params.push(uri); }
    if (root)     { conditions.push('document_root = ?'); params.push(root); }
    if (git)      { conditions.push('git_commit = ?');    params.push(git); }
    if (model_id) { conditions.push('model_id = ?');      params.push(model_id); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db.prepare(
      `SELECT id, cache_key, document_root, document_uri, question_hash, question_text,
              answer_text, model_id, base_uri, temperature, source_type, git_commit,
              chain_tip, token_root, code_hash, privacy_mode, signature, public_key,
              poly_session_id, turn_number, created_at, hit_count, last_hit_at
       FROM providence_cache
       ${where}
       ORDER BY created_at DESC
       LIMIT ?`
    ).all(...params, limit);

    const total = (db.prepare(
      `SELECT COUNT(*) as c FROM providence_cache ${where}`
    ).get(...params) as { c: number }).c;

    return NextResponse.json({ total, rows });
  } catch (err) {
    return NextResponse.json({ error: 'Failed to query providence cache', detail: String(err) }, { status: 500 });
  }
}

// POST /api/providence
// Body: {
//   document_root, document_uri, question_text, answer_text,
//   model_id, base_uri, temperature?,
//   source_type?, git_commit?,
//   -- polyglot proof fields (all optional) --
//   chain_tip?, token_root?, code_hash?, privacy_mode?,
//   signature?, public_key?, poly_session_id?, turn_number?,
//   merkle_proof?
// }
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      document_root, document_uri, question_text, answer_text,
      model_id, base_uri, temperature,
      source_type, git_commit, merkle_proof,
      chain_tip, token_root, code_hash, privacy_mode,
      signature, public_key, poly_session_id, turn_number,
    } = body;

    if (!document_root || !document_uri || !question_text || !answer_text) {
      return NextResponse.json(
        { error: 'Missing required fields: document_root, document_uri, question_text, answer_text' },
        { status: 400 }
      );
    }

    const question_hash = await hashText(question_text);
    const cache_key = `${document_root}:${question_hash}`;

    const db = getDb();
    const existing = db.prepare('SELECT id, hit_count FROM providence_cache WHERE cache_key = ?')
      .get(cache_key) as { id: number, hit_count: number } | undefined;

    if (existing) {
      db.prepare('UPDATE providence_cache SET hit_count = ?, last_hit_at = unixepoch() WHERE id = ?')
        .run(existing.hit_count + 1, existing.id);
      return NextResponse.json({ id: existing.id, cache_key, hit: true });
    }

    const result = db.prepare(`
      INSERT INTO providence_cache (
        cache_key, document_root, document_uri, question_hash, question_text, answer_text,
        merkle_proof, model_id, base_uri, temperature, source_type, git_commit,
        chain_tip, token_root, code_hash, privacy_mode,
        signature, public_key, poly_session_id, turn_number
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cache_key, document_root, document_uri, question_hash, question_text, answer_text,
      JSON.stringify(merkle_proof ?? []),
      model_id   ?? '',
      base_uri   ?? '',
      temperature ?? null,
      source_type ?? 'web',
      git_commit  ?? null,
      chain_tip   ?? null,
      token_root  ?? null,
      code_hash   ?? null,
      privacy_mode ?? 'transparent',
      signature   ?? null,
      public_key  ?? null,
      poly_session_id ?? null,
      turn_number ?? null,
    );

    return NextResponse.json({ id: result.lastInsertRowid, cache_key, hit: false }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: 'Failed to store providence record', detail: String(err) }, { status: 500 });
  }
}

// DELETE /api/providence?id=... or ?uri=...
export async function DELETE(request: NextRequest) {
  const id  = request.nextUrl.searchParams.get('id');
  const uri = request.nextUrl.searchParams.get('uri');

  if (!id && !uri) return NextResponse.json({ error: 'Provide id or uri' }, { status: 400 });

  try {
    const db = getDb();
    const result = id
      ? db.prepare('DELETE FROM providence_cache WHERE id = ?').run(parseInt(id))
      : db.prepare('DELETE FROM providence_cache WHERE document_uri = ?').run(uri!);
    return NextResponse.json({ deleted: result.changes });
  } catch (err) {
    return NextResponse.json({ error: 'Failed to delete', detail: String(err) }, { status: 500 });
  }
}

async function hashText(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.trim().toLowerCase()));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
