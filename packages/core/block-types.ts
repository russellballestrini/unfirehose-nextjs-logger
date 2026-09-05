/**
 * Canonical content-block type names, and the legacy names still in our data.
 *
 * unfirehose/1.0 renamed three block types when the adapter layer landed:
 * `thinking` became `reasoning`, `tool_use` became `tool-call`, and
 * `tool_result` became `tool-result`. Ingestion has written the new names
 * ever since, but rows written before that migration keep the old ones and
 * are not rewritten — the transcripts they came from are gone (Claude Code
 * reaps `~/.claude` after 30 days), so a rewrite could not be verified
 * against a source.
 *
 * That leaves every read spanning both. A query naming one name silently
 * answers about part of our history: on this machine `tool-call` has 449k
 * rows and `tool_use` 67k, so a tool breakdown filtering the legacy name
 * alone under-reports by an order of magnitude while looking perfectly
 * healthy. Both spellings must appear in every predicate.
 */

/** Every spelling of a tool invocation, canonical first. */
export const TOOL_CALL_TYPES = ['tool-call', 'tool_use'] as const;
/** Every spelling of a tool's returned output. */
export const TOOL_RESULT_TYPES = ['tool-result', 'tool_result'] as const;
/** Every spelling of a model's reasoning block. */
export const REASONING_TYPES = ['reasoning', 'thinking'] as const;

/**
 * A SQL `IN (…)` list for one of the sets above.
 *
 * Inlined rather than bound because these are compile-time constants and
 * the queries using them are frequently built by concatenation, where a
 * varying number of placeholders is how a parameter index slips.
 */
export function sqlIn(types: readonly string[]): string {
  return `(${types.map(t => `'${t}'`).join(', ')})`;
}

/** `block_type IN ('tool-call', 'tool_use')`, ready to drop into a WHERE. */
export const TOOL_CALL_SQL = `IN ${sqlIn(TOOL_CALL_TYPES)}`;
export const TOOL_RESULT_SQL = `IN ${sqlIn(TOOL_RESULT_TYPES)}`;
export const REASONING_SQL = `IN ${sqlIn(REASONING_TYPES)}`;

/** True for either spelling — for filtering rows already in hand. */
export const isToolCall = (t: string): boolean => (TOOL_CALL_TYPES as readonly string[]).includes(t);
export const isToolResult = (t: string): boolean => (TOOL_RESULT_TYPES as readonly string[]).includes(t);
export const isReasoning = (t: string): boolean => (REASONING_TYPES as readonly string[]).includes(t);
