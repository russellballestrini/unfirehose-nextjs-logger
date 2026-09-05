import { describe, it, expect } from 'vitest';
import {
  TOOL_CALL_TYPES, TOOL_RESULT_TYPES, REASONING_TYPES,
  TOOL_CALL_SQL, TOOL_RESULT_SQL, REASONING_SQL,
  sqlIn, isToolCall, isToolResult, isReasoning,
} from './block-types';

/**
 * Both spellings, everywhere.
 *
 * The rename that produced these pairs is done — ingestion writes only the
 * canonical name now. What is not done is our history: rows written before
 * it keep the old name and cannot be rewritten, because the transcripts
 * they came from are reaped after thirty days and nothing could verify the
 * rewrite. So the failure these guard against is not a crash. It is a query
 * that returns a smaller, plausible number.
 */

describe('block type sets', () => {
  it('names the canonical spelling first', () => {
    // Anything writing a block type should reach for [0] and get the new
    // name, not whichever happened to be listed first.
    expect(TOOL_CALL_TYPES[0]).toBe('tool-call');
    expect(TOOL_RESULT_TYPES[0]).toBe('tool-result');
    expect(REASONING_TYPES[0]).toBe('reasoning');
  });

  it('keeps the legacy spelling that is still in our data', () => {
    expect([...TOOL_CALL_TYPES]).toContain('tool_use');
    expect([...TOOL_RESULT_TYPES]).toContain('tool_result');
    expect([...REASONING_TYPES]).toContain('thinking');
  });

  it('builds a predicate that names every spelling', () => {
    expect(TOOL_CALL_SQL).toBe("IN ('tool-call', 'tool_use')");
    expect(TOOL_RESULT_SQL).toBe("IN ('tool-result', 'tool_result')");
    expect(REASONING_SQL).toBe("IN ('reasoning', 'thinking')");
  });

  it('quotes each value separately rather than the whole list', () => {
    expect(sqlIn(['a', 'b'])).toBe("('a', 'b')");
  });

  it('recognises a row already in hand under either name', () => {
    expect(isToolCall('tool-call')).toBe(true);
    expect(isToolCall('tool_use')).toBe(true);
    expect(isToolCall('tool-result')).toBe(false);
    expect(isToolResult('tool_result')).toBe(true);
    expect(isReasoning('thinking')).toBe(true);
    expect(isReasoning('text')).toBe(false);
  });
});
