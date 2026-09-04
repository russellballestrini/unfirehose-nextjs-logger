/**
 * The cache key a providence record is stored and found under.
 *
 * The writer and the reader each computed this independently — one as a
 * named function, one inline in a query handler — from the same seven
 * fields in the same order. They agreed, which is the only reason the cache
 * worked; nothing made them agree, and a key computed two ways is a cache
 * that silently stops hitting the moment one side changes.
 *
 * The key covers the tier-1 inputs, the ones that change the answer:
 *
 *   document_root + question_hash + model_id + model_revision
 *   + quantization + conversation_hash + seed
 *
 * conversation_hash is a SHA-256 of the full normalised message array, so a
 * single-turn question and a multi-turn conversation arriving at the same
 * final question are different keys. Callers hash it themselves and send
 * only the hash; message content never reaches us.
 *
 * Tier-2 metadata — base_uri, temperature, sampling parameters, backend,
 * node_id, inference_ms — is stored for audit and deliberately excluded: it
 * describes how an answer was produced, not what was asked.
 */

/** SHA-256, first 16 hex characters. The stored `cache_key` format. */
export async function sha256short(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

export interface KeyFields {
  document_root: string;
  question_text: string;
  model_id?: string | null;
  model_revision?: string | null;
  quantization?: string | null;
  conversation_hash?: string | null;
  seed?: number | string | null;
}

export async function buildCacheKey(
  fields: KeyFields,
): Promise<{ cache_key: string; question_hash: string }> {
  const question_hash = await sha256short(fields.question_text);

  // Order and separator are the format. Absent fields are the empty string,
  // never omitted, so a missing quantization cannot collide with a missing
  // model_revision by shifting everything left.
  const material = [
    fields.document_root,
    question_hash,
    fields.model_id ?? '',
    fields.model_revision ?? '',
    fields.quantization ?? '',
    fields.conversation_hash ?? '',
    fields.seed != null ? String(fields.seed) : '',
  ].join(':');

  return { cache_key: await sha256short(material), question_hash };
}
