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
    model: entry.message?.model ?? null,
    content,
    usage,
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
