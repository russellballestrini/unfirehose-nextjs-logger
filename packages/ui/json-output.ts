/**
 * Deciding whether a tool's output is JSON, and pretty-printing it if so.
 *
 * Tool results arrive as opaque strings and most of them are a JSON
 * envelope, which is unreadable in a feed without indentation. But a string
 * that merely starts with a brace is not JSON, and reformatting it would
 * mangle it — so anything that will not parse is left exactly as it
 * arrived.
 *
 * Our message viewer and our live feed each had a copy of this, with the
 * same predicate written out twice. They differ only in how they present
 * the result, which is why that part stays with each caller.
 */
export function tryPrettyJson(text: string): { pretty: string; isJson: boolean } {
  const trimmed = text.trim();
  // Cheap shape check before paying for a parse: tool output runs to
  // megabytes and most of it is not JSON.
  const looksJson =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (looksJson) {
    try {
      return { pretty: JSON.stringify(JSON.parse(trimmed), null, 2), isJson: true };
    } catch {
      // Looked like JSON and was not. Leave it exactly as it came.
    }
  }
  return { pretty: text, isJson: false };
}
