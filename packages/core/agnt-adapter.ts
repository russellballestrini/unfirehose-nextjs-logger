/**
 * Adapter for native unfirehose/1.0 JSONL (agnt format).
 *
 * Converts unfirehose/1.0 messages to the Claude Code-compatible format
 * used by the insertMessage/insertContentBlocks pipeline.
 *
 * Since agnt writes unfirehose/1.0 natively, this is a thin transform:
 *   unfirehose/1.0 → Claude Code ingest shape
 *
 * The transform maps:
 *   { type: "message", role: "user", content: [{type: "text", text}] }
 *   → { type: "user", uuid: id, message: { content: [...], model, usage: {...} } }
 */

/**
 * Normalize a native unfirehose/1.0 entry to the Claude Code ingest format.
 * Returns null for non-message entries (session envelopes, training events, etc.).
 */
export function normalizeUnfirehoseEntry(entry: any): any | null {
  // Only process message entries
  if (entry.type !== 'message') return null;
  if (!entry.role) return null;

  // Map role to Claude Code type
  const type = entry.role; // user, assistant, system, tool

  // Map content blocks from unfirehose/1.0 → Claude Code format
  const content = Array.isArray(entry.content)
    ? entry.content.map(mapContentBlock)
    : [];

  // Map usage from unfirehose camelCase → Claude Code snake_case
  const usage = entry.usage ? {
    input_tokens: entry.usage.inputTokens ?? 0,
    output_tokens: entry.usage.outputTokens ?? 0,
    cache_read_input_tokens: entry.usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cache_creation_input_tokens: entry.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
  } : undefined;

  return {
    type,
    uuid: entry.id ?? null,
    parentUuid: entry.parentId ?? null,
    timestamp: entry.timestamp ?? null,
    subtype: entry.subtype ?? null,
    durationMs: entry.durationMs ?? null,
    isSidechain: entry.sidechain ?? false,
    message: {
      content,
      model: entry.model ?? null,
      usage,
    },
  };
}

/**
 * Map a unfirehose/1.0 content block to Claude Code format.
 */
function mapContentBlock(block: any): any {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };

    case 'reasoning':
      return { type: 'thinking', thinking: block.text };

    case 'tool-call':
      return {
        type: 'tool_use',
        id: block.toolCallId,
        name: block.toolName,
        input: block.input,
      };

    case 'tool-result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolCallId,
        content: block.output,
        is_error: block.isError ?? false,
      };

    case 'image':
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.mediaType,
          data: block.data,
        },
      };

    default:
      return block;
  }
}
