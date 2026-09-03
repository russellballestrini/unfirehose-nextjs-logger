/**
 * Claude Code → unfirehose/1.0 adapter.
 *
 * Transforms Claude Code native JSONL entries into the canonical
 * unfirehose/1.0 format used by the ingest pipeline.
 *
 * Claude Code writes entries like:
 *   { type: "user"|"assistant"|"system", uuid, parentUuid, message: { content, model, usage } }
 *   usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
 *   blocks: thinking (thinking), tool_use (name, input, id), tool_result (content, tool_use_id, is_error)
 *
 * unfirehose/1.0 canonical format:
 *   { type: "message", role: "user"|"assistant"|"system", id, parentId, content, model, usage }
 *   usage: { inputTokens, outputTokens, inputTokenDetails: { cacheReadTokens, cacheWriteTokens } }
 *   blocks: reasoning (text), tool-call (toolName, input, toolCallId), tool-result (output, toolCallId, isError)
 */

/**
 * A refusal Claude Code reported on its own message.
 *
 * When the API refuses a call Claude Code still writes an assistant row — a
 * synthetic one (`model: "<synthetic>"`, zero usage) carrying the error as
 * its text, stamped `isApiErrorMessage: true` with `error` and
 * `apiErrorStatus`. That is a harness-reported refusal in everything but
 * name, and it is the only Claude Code signal that names the status. The
 * text scanner is a fallback for it, not the source: "API Error: 529
 * Overloaded" went unmatched for a whole outage because a rule wanted
 * "Error: Overloaded" with nothing between.
 */
export interface ClaudeApiRefusal {
  kind: 'rate_limit' | 'quota' | 'overloaded' | 'server_error';
  status: number | null;
  detail: string;
}

/**
 * Classify Claude Code's `error` + `apiErrorStatus` into a refusal kind, or
 * null when the failure was ours. `authentication_failed` is a dead login
 * and `invalid_request` is our payload — a provider that answered and
 * rejected THE REQUEST did not refuse to serve, and counting those would
 * report an outage that never happened. Same policy as uncloseai-cli's
 * `_THROTTLE_KINDS`.
 */
export function classifyClaudeApiError(entry: any): ClaudeApiRefusal | null {
  if (entry?.isApiErrorMessage !== true) return null;
  const error = typeof entry.error === 'string' ? entry.error : '';
  const status = typeof entry.apiErrorStatus === 'number' ? entry.apiErrorStatus : null;
  const raw = entry.message?.content;
  const text = Array.isArray(raw)
    ? raw.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join(' ')
    : typeof raw === 'string' ? raw : '';
  const detail = text.trim().slice(0, 300) || `${error || 'api_error'}${status ? ` ${status}` : ''}`;

  if (error === 'authentication_failed' || error === 'invalid_request') return null;
  if (error === 'rate_limit') {
    // "You've hit your session limit" / "reached your Fable 5 limit" is the
    // plan window running dry, not a per-second throttle: the remedy is
    // wait for the reset, not back off.
    const quota = /\b(?:session|usage|weekly|monthly)\s+limit\b|\breached your\b|\blimit reached\b/i.test(text);
    return { kind: quota ? 'quota' : 'rate_limit', status: status ?? 429, detail };
  }
  if (status === 529 || status === 503 || /\boverloaded\b/i.test(text)) {
    return { kind: 'overloaded', status, detail };
  }
  return { kind: 'server_error', status, detail };
}

/**
 * Normalize a Claude Code native JSONL entry to unfirehose/1.0 format.
 * Returns null for entries that aren't messages (summary, etc.).
 */
export function normalizeClaudeCodeEntry(entry: any): any | null {
  const role = entry.type;
  if (!role || !['user', 'assistant', 'system'].includes(role)) return null;

  // Map content blocks from Claude Code → unfirehose/1.0
  const rawContent = entry.message?.content;
  const content = Array.isArray(rawContent)
    ? rawContent.map(mapBlockToUnfirehose)
    : typeof rawContent === 'string'
      ? [{ type: 'text', text: rawContent }]
      : [];

  // Map usage from Claude Code snake_case → unfirehose/1.0 camelCase
  const ccUsage = entry.message?.usage;
  const usage = ccUsage ? {
    inputTokens: ccUsage.input_tokens ?? 0,
    outputTokens: ccUsage.output_tokens ?? 0,
    inputTokenDetails: {
      cacheReadTokens: ccUsage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: ccUsage.cache_creation_input_tokens ?? 0,
    },
    // Anthropic bills off-band and quotes no per-call price, so this is
    // normally absent. Carried anyway: a harness that does quote one must
    // not have it dropped here for the sake of a shorter mapping.
    costUSD: ccUsage.cost_usd ?? undefined,
  } : undefined;

  return {
    type: 'message',
    role,
    id: entry.uuid ?? null,
    parentId: entry.parentUuid ?? null,
    timestamp: entry.timestamp ?? null,
    subtype: entry.subtype ?? null,
    durationMs: entry.durationMs ?? null,
    sidechain: entry.isSidechain ?? false,
    // A synthetic error row names no real model; null reads as "unknown"
    // downstream where "<synthetic>" would read as a model we never priced.
    model: entry.message?.model === '<synthetic>' ? null : (entry.message?.model ?? null),
    content,
    usage,
    refusal: classifyClaudeApiError(entry),
  };
}

/**
 * Map a Claude Code content block to unfirehose/1.0 format.
 */
function mapBlockToUnfirehose(block: any): any {
  switch (block.type) {
    case 'thinking':
      return { type: 'reasoning', text: block.thinking };

    case 'tool_use':
      return {
        type: 'tool-call',
        toolCallId: block.id,
        toolName: block.name,
        input: block.input,
      };

    case 'tool_result':
      return {
        type: 'tool-result',
        toolCallId: block.tool_use_id,
        output: block.content,
        isError: block.is_error ?? false,
      };

    case 'text':
      return { type: 'text', text: block.text };

    case 'image':
      return block; // pass through as-is

    default:
      return block;
  }
}
