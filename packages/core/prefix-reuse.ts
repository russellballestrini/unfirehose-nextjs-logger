// How much of a self-hosted model's prompt was a re-send of something we had
// ALREADY sent it — derived from the shape of the conversation, because vLLM
// will not tell us.
//
// vLLM's V1 engine never maps num_cached_tokens into prompt_tokens_details in
// its OpenAI serving layer (vllm-project/vllm#44961, open 14+ months; V0 does
// it correctly, and --enable-prompt-tokens-details does not help because the
// flag is honored upstream of the gap). So every self-hosted row reports
// cache_read_tokens = 0 no matter how well the cache is working.
//
// The fallback we shipped first was vLLM's Prometheus counters. Those are
// real, but they are a property of the NODE, not of our traffic: over one
// 7-day window the 3090 and 4090 together answered 6.6B prefix-cache query
// tokens while our own logged prompts came to 791M. Dividing one by the other
// produced "8.4% hit" on a model row, which is not our hit rate and not
// anybody's — it is our numerator over the whole mesh's denominator.
//
// This computes the honest question instead, from data we own. An agent loop
// appends: request n's prompt is request n-1's prompt plus the reply and the
// next turn. So the prefix shared with the previous request is the previous
// request's whole prompt, and the reusable share of request n is
// min(prompt[n-1], prompt[n]), floored to vLLM's block size because the cache
// matches whole blocks.
//
// This is a CEILING, not a measurement. It says what a perfect, never-evicted
// cache could have served. Real hits are lower by whatever eviction takes, and
// nothing we can see from outside distinguishes the two. Label it as derived
// wherever it is rendered — an estimate that dresses as a measurement is the
// defect this whole file exists to correct, not to repeat.

/** vLLM matches prefixes in whole blocks; 16 tokens is its default. */
export const VLLM_BLOCK_TOKENS = 16;

export interface PrefixReuse {
  /** Total prompt tokens across the calls examined. */
  prompt: number;
  /** Of those, how many were a re-send of the previous call's prompt. */
  reusable: number;
  /** reusable / prompt, or null when there were no prompt tokens at all. */
  rate: number | null;
}

/**
 * Reusable prefix across one session's calls, in order.
 *
 * `prompts` must be one session's prompt sizes in timestamp order — mixing
 * sessions would pair unrelated conversations and invent a shared prefix that
 * never existed.
 */
export function structuralPrefixReuse(
  prompts: Iterable<number>,
  blockTokens: number = VLLM_BLOCK_TOKENS,
): PrefixReuse {
  const block = blockTokens > 0 ? blockTokens : 1;
  let prompt = 0;
  let reusable = 0;
  let prev = 0;
  for (const raw of prompts) {
    const p = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    if (p === 0) continue;
    prompt += p;
    if (prev > 0) {
      // A shrinking prompt means the conversation was trimmed or restarted;
      // only the part both calls share can have been held.
      const shared = Math.min(prev, p);
      reusable += Math.floor(shared / block) * block;
    }
    prev = p;
  }
  return { prompt, reusable, rate: prompt > 0 ? reusable / prompt : null };
}

/** Sum reuse over many sessions, each already in timestamp order. */
export function structuralPrefixReuseBySession(
  sessions: Iterable<Iterable<number>>,
  blockTokens: number = VLLM_BLOCK_TOKENS,
): PrefixReuse {
  let prompt = 0;
  let reusable = 0;
  for (const s of sessions) {
    const r = structuralPrefixReuse(s, blockTokens);
    prompt += r.prompt;
    reusable += r.reusable;
  }
  return { prompt, reusable, rate: prompt > 0 ? reusable / prompt : null };
}
