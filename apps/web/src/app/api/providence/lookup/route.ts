import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';

// GET /api/providence/lookup
// Required: root= (Merkle/git root) and q= (question text)
// Optional tier-1 key inputs: model_id, model_revision, quantization, conversation_hash, seed
//
// Cache key = sha256(root + question_hash + model_id + model_revision + quantization + conversation_hash + seed)
// All tier-1 fields that differ = cache miss — a different model/quant/prompt gets its own entry.
export async function GET(request: NextRequest) {
  const root               = request.nextUrl.searchParams.get('root');
  const git                = request.nextUrl.searchParams.get('git');
  const q                  = request.nextUrl.searchParams.get('q');
  const model_id           = request.nextUrl.searchParams.get('model_id')           ?? '';
  const model_revision     = request.nextUrl.searchParams.get('model_revision')     ?? '';
  const quantization       = request.nextUrl.searchParams.get('quantization')       ?? '';
  const conversation_hash = request.nextUrl.searchParams.get('conversation_hash') ?? '';
  const seed               = request.nextUrl.searchParams.get('seed');

  if (!q)           return NextResponse.json({ error: 'q (question) required' },      { status: 400 });
  if (!root && !git) return NextResponse.json({ error: 'root or git required' },      { status: 400 });

  try {
    const document_root  = root ?? git!;
    const question_hash  = await sha256short(q);
    const key_material   = [document_root, question_hash, model_id, model_revision,
                            quantization, conversation_hash,
                            seed != null ? seed : ''].join(':');
    const cache_key      = await sha256short(key_material);

    const db = getDb();
    const row = db.prepare(`
      SELECT id, answer_text,
             model_id, model_revision, quantization, conversation_hash, seed,
             base_uri, temperature, top_p, top_k, repetition_penalty, frequency_penalty,
             presence_penalty, max_tokens, context_window, backend, node_id, inference_ms,
             source_type, git_commit,
             chain_tip, token_root, code_hash, privacy_mode, signature, public_key,
             poly_session_id, turn_number,
             created_at, hit_count
      FROM providence_cache WHERE cache_key = ?
    `).get(cache_key) as Record<string, unknown> | undefined;

    if (!row) return NextResponse.json({ hit: false, cache_key, document_root, question_hash });

    db.prepare('UPDATE providence_cache SET hit_count = hit_count + 1, last_hit_at = unixepoch() WHERE id = ?')
      .run(row.id as number);

    return NextResponse.json({
      hit: true,
      cache_key,
      document_root,
      question_hash,
      answer:          row.answer_text,
      // tier 1
      model_id:        row.model_id,
      model_revision:  row.model_revision,
      quantization:    row.quantization,
      seed:            row.seed,
      // tier 2
      base_uri:        row.base_uri,
      temperature:     row.temperature,
      top_p:           row.top_p,
      top_k:           row.top_k,
      repetition_penalty:  row.repetition_penalty,
      frequency_penalty:   row.frequency_penalty,
      presence_penalty:    row.presence_penalty,
      max_tokens:      row.max_tokens,
      context_window:  row.context_window,
      backend:         row.backend,
      node_id:         row.node_id,
      inference_ms:    row.inference_ms,
      // polyglot proof
      chain_tip:       row.chain_tip,
      token_root:      row.token_root,
      code_hash:       row.code_hash,
      privacy_mode:    row.privacy_mode,
      signature:       row.signature,
      public_key:      row.public_key,
      poly_session_id: row.poly_session_id,
      turn_number:     row.turn_number,
      // bookkeeping
      created_at:      row.created_at,
      hit_count:       (row.hit_count as number) + 1,
    });
  } catch (err) {
    return NextResponse.json({ error: 'Lookup failed', detail: String(err) }, { status: 500 });
  }
}

async function sha256short(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
