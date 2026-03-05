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
