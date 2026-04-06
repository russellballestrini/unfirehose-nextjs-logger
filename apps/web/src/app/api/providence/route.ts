import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';

// Cache key = hash of tier-1 inputs:
//   document_root + question_hash + model_id + model_revision + quantization
//   + conversation_hash + seed (only when non-null)
//
// conversation_hash = SHA-256 of the full normalized OpenAI messages array:
//   JSON.stringify([{role, content}, ...]) covering all turns in order —
//   system prompt + all prior assistant & user messages + current user question.
//   A single-turn Q&A and a multi-turn conversation arriving at the same final
//   question produce different hashes and different cache keys.
//   Callers hash client-side and pass only the hash — message content never stored.
//
// Tier-2 metadata (base_uri, temperature, sampling params, backend, node_id,
//   inference_ms) stored for research/audit but does not affect the key.
async function buildCacheKey(fields: {
  document_root: string;
  question_text: string;
  model_id?: string;
  model_revision?: string | null;
  quantization?: string | null;
  conversation_hash?: string | null;
  seed?: number | null;
}): Promise<{ cache_key: string; question_hash: string }> {
  const question_hash = await sha256short(fields.question_text);
  const key_material = [
    fields.document_root,
    question_hash,
    fields.model_id       ?? '',
    fields.model_revision ?? '',
    fields.quantization   ?? '',
    fields.conversation_hash ?? '',
    fields.seed != null ? String(fields.seed) : '',
  ].join(':');
  const cache_key = await sha256short(key_material);
  return { cache_key, question_hash };
}

// GET /api/providence?uri=...&root=...&git=...&model_id=...&backend=...&node_id=...&limit=50
export async function GET(request: NextRequest) {
  const uri      = request.nextUrl.searchParams.get('uri');
  const root     = request.nextUrl.searchParams.get('root');
  const git      = request.nextUrl.searchParams.get('git');
  const model_id = request.nextUrl.searchParams.get('model_id');
  const backend  = request.nextUrl.searchParams.get('backend');
  const node_id  = request.nextUrl.searchParams.get('node_id');
  const limit    = Math.min(parseInt(request.nextUrl.searchParams.get('limit') ?? '50'), 200);

  try {
    const db = getDb();
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (uri)      { conditions.push('document_uri = ?');  params.push(uri); }
    if (root)     { conditions.push('document_root = ?'); params.push(root); }
    if (git)      { conditions.push('git_commit = ?');    params.push(git); }
    if (model_id) { conditions.push('model_id = ?');      params.push(model_id); }
    if (backend)  { conditions.push('backend = ?');       params.push(backend); }
    if (node_id)  { conditions.push('node_id = ?');       params.push(node_id); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db.prepare(
      `SELECT id, cache_key, document_root, document_uri, question_hash, question_text,
              answer_text, model_id, model_revision, quantization, conversation_hash, seed,
              base_uri, temperature, top_p, top_k, repetition_penalty, frequency_penalty,
              presence_penalty, max_tokens, context_window, backend, node_id, inference_ms,
              source_type, git_commit,
              chain_tip, token_root, code_hash, privacy_mode, signature, public_key,
              poly_session_id, turn_number,
              created_at, hit_count, last_hit_at
       FROM providence_cache ${where}
       ORDER BY created_at DESC LIMIT ?`
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
export async function POST(request: NextRequest) {
  try {
    const b = await request.json();

    if (!b.document_root || !b.document_uri || !b.question_text || !b.answer_text) {
      return NextResponse.json(
        { error: 'Missing required: document_root, document_uri, question_text, answer_text' },
        { status: 400 }
      );
    }

    const { cache_key, question_hash } = await buildCacheKey({
      document_root:      b.document_root,
      question_text:      b.question_text,
      model_id:           b.model_id,
      model_revision:     b.model_revision,
      quantization:       b.quantization,
      conversation_hash: b.conversation_hash,
      seed:               b.seed,
    });

    const db = getDb();
    const existing = db.prepare('SELECT id, hit_count FROM providence_cache WHERE cache_key = ?')
      .get(cache_key) as { id: number; hit_count: number } | undefined;

    if (existing) {
      db.prepare('UPDATE providence_cache SET hit_count = ?, last_hit_at = unixepoch() WHERE id = ?')
        .run(existing.hit_count + 1, existing.id);
      return NextResponse.json({ id: existing.id, cache_key, hit: true });
    }

    const result = db.prepare(`
      INSERT INTO providence_cache (
        cache_key, document_root, document_uri, question_hash, question_text,
        model_id, model_revision, quantization, conversation_hash, seed,
        answer_text, merkle_proof,
        base_uri, temperature, top_p, top_k, repetition_penalty, frequency_penalty,
        presence_penalty, max_tokens, context_window, backend, node_id, inference_ms,
        source_type, git_commit,
        chain_tip, token_root, code_hash, privacy_mode,
        signature, public_key, poly_session_id, turn_number
      ) VALUES (
        ?,?,?,?,?, ?,?,?,?,?, ?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?, ?,?,?,?, ?,?,?,?
      )
    `).run(
      cache_key, b.document_root, b.document_uri, question_hash, b.question_text,
      b.model_id ?? '', b.model_revision ?? null, b.quantization ?? null,
      b.conversation_hash ?? null, b.seed ?? null,
      b.answer_text, JSON.stringify(b.merkle_proof ?? []),
      b.base_uri ?? '', b.temperature ?? null, b.top_p ?? null, b.top_k ?? null,
      b.repetition_penalty ?? null, b.frequency_penalty ?? null,
      b.presence_penalty ?? null, b.max_tokens ?? null, b.context_window ?? null,
      b.backend ?? null, b.node_id ?? null, b.inference_ms ?? null,
      b.source_type ?? 'web', b.git_commit ?? null,
      b.chain_tip ?? null, b.token_root ?? null, b.code_hash ?? null,
      b.privacy_mode ?? 'transparent',
      b.signature ?? null, b.public_key ?? null,
      b.poly_session_id ?? null, b.turn_number ?? null,
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

async function sha256short(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
