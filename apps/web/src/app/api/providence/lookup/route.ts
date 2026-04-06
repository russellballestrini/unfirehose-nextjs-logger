import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';

// GET /api/providence/lookup?root=<merkle_root>&q=<question_text>
// or  ?git=<commit_hash>&q=<question_text>
//
// Called before inference to check for a cache hit.
// Returns { hit: true, answer, model, created_at } or { hit: false }
export async function GET(request: NextRequest) {
  const root = request.nextUrl.searchParams.get('root');
  const git  = request.nextUrl.searchParams.get('git');
  const q    = request.nextUrl.searchParams.get('q');

  if (!q) return NextResponse.json({ error: 'q (question) required' }, { status: 400 });
  if (!root && !git) return NextResponse.json({ error: 'root or git required' }, { status: 400 });

  try {
    const question_hash = await hashText(q);
    const document_root = root ?? git!;
    const cache_key = `${document_root}:${question_hash}`;

    const db = getDb();
    const row = db.prepare(`
      SELECT id, answer_text, model_id, base_uri, temperature, source_type,
             git_commit, chain_tip, token_root, code_hash, privacy_mode,
             signature, public_key, poly_session_id, turn_number,
             created_at, hit_count
      FROM providence_cache WHERE cache_key = ?
    `).get(cache_key) as {
      id: number, answer_text: string, model_id: string, base_uri: string,
      temperature: number | null, source_type: string, git_commit: string | null,
      chain_tip: string | null, token_root: string | null, code_hash: string | null,
      privacy_mode: string, signature: string | null, public_key: string | null,
      poly_session_id: string | null, turn_number: number | null,
      created_at: number, hit_count: number
    } | undefined;

    if (!row) return NextResponse.json({ hit: false, cache_key });

    db.prepare('UPDATE providence_cache SET hit_count = hit_count + 1, last_hit_at = unixepoch() WHERE id = ?').run(row.id);

    return NextResponse.json({
      hit: true,
      cache_key,
      answer:          row.answer_text,
      model_id:        row.model_id,
      base_uri:        row.base_uri,
      temperature:     row.temperature,
      source_type:     row.source_type,
      git_commit:      row.git_commit,
      chain_tip:       row.chain_tip,
      token_root:      row.token_root,
      code_hash:       row.code_hash,
      privacy_mode:    row.privacy_mode,
      signature:       row.signature,
      public_key:      row.public_key,
      poly_session_id: row.poly_session_id,
      turn_number:     row.turn_number,
      created_at:      row.created_at,
      hit_count:       row.hit_count + 1,
    });
  } catch (err) {
    return NextResponse.json({ error: 'Lookup failed', detail: String(err) }, { status: 500 });
  }
}

async function hashText(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.trim().toLowerCase()));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
