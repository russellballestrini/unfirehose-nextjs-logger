/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Normalizes an uncloseai-cli JSONL event into the shape that
 * insertMessage / insertContentBlocks expect (Claude Code format).
 *
 * Returns null for event types that should be skipped.
 */
export function normalizeUncloseaiEntry(raw: any): any | null {
  switch (raw.type) {
    case 'session_start':
      // Map the initial prompt as a user message
      return {
        type: 'user',
        uuid: null,
        parentUuid: null,
        timestamp: raw.timestamp ?? null,
        message: {
          role: 'user',
          content: [{ type: 'text', text: raw.prompt ?? '' }],
        },
        isSidechain: false,
      };

    case 'assistant':
      return {
        type: 'assistant',
        uuid: null,
        parentUuid: null,
        timestamp: raw.timestamp ?? null,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: raw.content ?? '' }],
          model: 'hermes-3-8b',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
        isSidechain: false,
      };

    case 'tool_call': {
      let parsedInput: Record<string, unknown> = {};
      try {
        parsedInput = typeof raw.args === 'string' ? JSON.parse(raw.args) : (raw.args ?? {});
      } catch {
        parsedInput = { raw: raw.args };
      }

      return {
        type: 'assistant',
        uuid: null,
        parentUuid: null,
        timestamp: raw.timestamp ?? null,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: `uncloseai-${raw.tool}-${raw.timestamp ?? Date.now()}`,
              name: raw.tool ?? 'unknown',
              input: parsedInput,
            },
          ],
          model: 'hermes-3-8b',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
        isSidechain: false,
      };
    }

    case 'session_end':
      return {
        type: 'system',
        uuid: null,
        parentUuid: null,
        timestamp: raw.timestamp ?? null,
        subtype: 'session_end',
        isSidechain: false,
      };

    default:
      return null;
  }
}

/**
 * Normalizes a native unfirehose/1.0 entry into the shape that
 * insertMessage / insertContentBlocks expect (Claude Code internal format).
 *
 * Handles the field renames: role→type, id→uuid, parentId→parentUuid,
 * content block type renames (tool-call→tool_use, tool-result→tool_result,
 * reasoning→thinking), and usage camelCase→snake_case.
 *
 * Returns null for non-message entries (session headers, etc).
 */
export function normalizeNativeEntry(raw: any): any | null {
  // Only handle message entries — skip session headers, todos, etc.
  if (raw.type !== 'message') return null;
  const role = raw.role;
  if (!['user', 'assistant', 'system'].includes(role)) return null;

  // Map content blocks from unfirehose/1.0 → Claude Code internal names
  const content = Array.isArray(raw.content)
    ? raw.content.map((block: any) => {
        switch (block.type) {
          case 'tool-call':
            return {
              type: 'tool_use',
              id: block.toolCallId ?? null,
              name: block.toolName ?? 'unknown',
              input: block.input ?? {},
            };
          case 'tool-result':
            return {
              type: 'tool_result',
              tool_use_id: block.toolCallId ?? null,
              content: block.output ?? '',
              is_error: block.isError ?? false,
            };
          case 'reasoning':
            return {
              type: 'thinking',
              thinking: block.text ?? '',
            };
          default:
            return block;
        }
      })
    : [];

  // Map usage from camelCase → snake_case
  const rawUsage = raw.usage;
  const usage = rawUsage
    ? {
        input_tokens: rawUsage.inputTokens ?? 0,
        output_tokens: rawUsage.outputTokens ?? 0,
        cache_read_input_tokens: rawUsage.inputTokenDetails?.cacheReadTokens ?? 0,
        cache_creation_input_tokens: rawUsage.inputTokenDetails?.cacheWriteTokens ?? 0,
      }
    : { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  return {
    type: role,
    uuid: raw.id ?? null,
    parentUuid: raw.parentId ?? null,
    timestamp: raw.timestamp ?? null,
    subtype: raw.subtype ?? null,
    durationMs: raw.durationMs ?? null,
    isSidechain: raw.sidechain ?? false,
    message: {
      role,
      content,
      model: raw.model ?? null,
      usage,
    },
  };
}
