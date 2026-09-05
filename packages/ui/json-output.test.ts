import { describe, it, expect } from 'vitest';
import { tryPrettyJson } from './json-output';

/**
 * Pretty-printing a tool result that happens to be JSON.
 *
 * Written twice — once in our message viewer, once in our live feed — with
 * the same predicate spelled out in both. The rule that matters: a string
 * that merely looks like JSON is not JSON, and reformatting it anyway
 * mangles output somebody needs to read.
 */

describe('tryPrettyJson', () => {
  it('indents an object so a feed can be read', () => {
    const { pretty, isJson } = tryPrettyJson('{"a":1,"b":[2,3]}');
    expect(isJson).toBe(true);
    expect(pretty).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  });

  it('indents an array too', () => {
    expect(tryPrettyJson('[1,2]').isJson).toBe(true);
  });

  it('tolerates surrounding whitespace, which tool output usually carries', () => {
    expect(tryPrettyJson('\n  {"a":1}\n  ').isJson).toBe(true);
  });

  it('leaves plain text exactly as it arrived', () => {
    const text = 'Compiled successfully in 14.5s';
    expect(tryPrettyJson(text)).toEqual({ pretty: text, isJson: false });
  });

  it('leaves alone a string that looks like JSON and is not', () => {
    // This is the case the shape check alone gets wrong. Returning the
    // input untouched is the only safe answer — a half-parsed reformat
    // destroys output somebody needs to read.
    const text = '{ this is prose, in braces }';
    expect(tryPrettyJson(text)).toEqual({ pretty: text, isJson: false });
  });

  it('does not treat a fragment as JSON just because it opens with a brace', () => {
    // Truncated output is common: a result cut off mid-object still starts
    // with a brace. Both ends must match before we pay for a parse.
    expect(tryPrettyJson('{"a":1,"b":').isJson).toBe(false);
  });

  it('leaves an empty string alone', () => {
    expect(tryPrettyJson('')).toEqual({ pretty: '', isJson: false });
  });

  it('does not claim a bare number or word is JSON', () => {
    // `JSON.parse('42')` succeeds, but reformatting a scalar gains nothing
    // and the shape check keeps us from even trying.
    for (const text of ['42', 'true', 'null', 'ok']) {
      expect(tryPrettyJson(text), text).toEqual({ pretty: text, isJson: false });
    }
  });
});
