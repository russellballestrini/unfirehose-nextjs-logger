import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { buildCacheKey } from '@/lib/providence-key';
import { buildWhere } from '@/lib/sql-filters';

// GET /api/providence?uri=...&root=...&git=...&model_id=...&backend=...&node_id=...&limit=50
/** Which query parameter narrows which column. */
const LOOKUP_COLUMNS = {
  uri: 'document_uri',
  root: 'document_root',
  git: 'git_commit',
  model_id: 'model_id',
  backend: 'backend',
  node_id: 'node_id',
} as const;

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const limit = Math.min(parseInt(q.get('limit') ?? '50'), 200);

  try {
    const db = getDb();
    // Six parameters that all narrow one column each. Written out, the
    // clause and its value sat in separate statements six times over, where
    // a seventh added to one and missed in the other binds the wrong value
    // to the wrong placeholder — which answers plausibly rather than failing.
    const built = buildWhere('1=1', Object.entries(LOOKUP_COLUMNS).map(
      ([param, column]) => [`${column} = ?`, q.get(param)] as const,
    ));
    const params = built.params;
    const where = `WHERE ${built.where}`;
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

/**
 * Every column we store, with what to write when a caller omits it.
 *
 * This was three parallel lists — the column names, a row of thirty-four
 * question marks, and thirty-four values each with its own default —
 * which had to be kept in the same order and the same length by counting.
 * Miscounting the placeholders is a runtime error on a route that only
 * fails when somebody is trying to record something.
 *
 * A missing optional field is null rather than absent, because these rows
 * are read back as a provenance record: "we did not capture the seed" and
 * "the seed was zero" are different claims.
 */
const COLUMNS: ReadonlyArray<readonly [string, unknown]> = [
  ['cache_key', null], ['document_root', null], ['document_uri', null],
  ['question_hash', null], ['question_text', null],
  ['model_id', ''], ['model_revision', null], ['quantization', null],
  ['conversation_hash', null], ['seed', null],
  ['answer_text', null], ['merkle_proof', '[]'],
  ['base_uri', ''], ['temperature', null], ['top_p', null], ['top_k', null],
  ['repetition_penalty', null], ['frequency_penalty', null],
  ['presence_penalty', null], ['max_tokens', null], ['context_window', null],
  ['backend', null], ['node_id', null], ['inference_ms', null],
  ['source_type', 'web'], ['git_commit', null],
  ['chain_tip', null], ['token_root', null], ['code_hash', null],
  ['privacy_mode', 'transparent'],
  ['signature', null], ['public_key', null],
  ['poly_session_id', null], ['turn_number', null],
];

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

    const result = db.prepare(
      `INSERT INTO providence_cache (${COLUMNS.map((c) => c[0]).join(', ')})
       VALUES (${COLUMNS.map(() => '?').join(', ')})`,
    ).run(...COLUMNS.map(([col, fallback]) => {
      if (col === 'cache_key') return cache_key;
      if (col === 'question_hash') return question_hash;
      if (col === 'merkle_proof') return JSON.stringify(b.merkle_proof ?? []);
      return b[col] ?? fallback;
    }));

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

