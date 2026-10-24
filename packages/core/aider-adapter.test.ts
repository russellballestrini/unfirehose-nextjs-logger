import { describe, it, expect } from 'vitest';
import {
  aiderLocalTime, aiderReplyBlocks, parseAiderInputHistory, parseAiderModel, parseAiderTokens, parseAiderVersion, splitAiderLines,
} from './aider-adapter';

const lines = (text: string) => {
  let offset = 0;
  return text.split('\n').map((t) => { const l = { text: t, offset }; offset += Buffer.byteLength(t) + 1; return l; });
};

describe('parseAiderTokens', () => {
  it('reads counts as printed and says when they were rounded', () => {
    expect(parseAiderTokens('Tokens: 980 sent, 64 received. Cost: $0.0039 message, $0.02 session.')).toEqual({
      inputTokens: 980, outputTokens: 64, inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 }, approximate: false,
    });
    expect(parseAiderTokens('Tokens: 12k sent, 2.1k cache write, 8.4k cache hit, 1.5k received.')).toEqual({
      inputTokens: 12_000, outputTokens: 1500, inputTokenDetails: { cacheReadTokens: 8400, cacheWriteTokens: 2100 }, approximate: true,
    });
    expect(parseAiderTokens('Added src/x.ts to the chat')).toBeNull();
  });
});

describe('announcements', () => {
  it('finds the model in each wording Aider has used, and its version', () => {
    expect(parseAiderModel('Main model: anthropic/claude-sonnet-4-5 with diff edit format, infinite output')).toBe('anthropic/claude-sonnet-4-5');
    expect(parseAiderModel('Model: gpt-4-0613 using diff edit format')).toBe('gpt-4-0613');
    expect(parseAiderModel('Models: claude-3-opus with diff edit format, weak model claude-3-haiku')).toBe('claude-3-opus');
    expect(parseAiderModel('Weak model: claude-3-haiku')).toBeNull();
    expect(parseAiderVersion('Aider v0.86.1')).toBe('0.86.1');
  });
});

describe('aiderReplyBlocks', () => {
  it('reads the diff-fenced format, and a second edit without a file name as the same file', () => {
    const reply = [
      'Two changes:', '```', 'src/a.ts', '<<<<<<< SEARCH', 'a', '=======', 'b', '>>>>>>> REPLACE', '```',
      '```', '<<<<<<< SEARCH', 'c', '=======', 'd', '>>>>>>> REPLACE', '```', 'Done.',
    ].join('\n');
    const blocks = aiderReplyBlocks(reply, 'x');
    expect(blocks.map((b) => b.type)).toEqual(['text', 'tool-call', 'tool-call', 'text']);
    expect(blocks[1].input).toEqual({ file_path: 'src/a.ts', old_string: 'a', new_string: 'b' });
    expect(blocks[2]).toMatchObject({ toolCallId: 'x:edit-1', input: { file_path: 'src/a.ts', old_string: 'c', new_string: 'd' } });
  });

  it('leaves an unfinished edit as prose', () => {
    expect(aiderReplyBlocks('x.ts\n<<<<<<< SEARCH\nonly half', 'x')).toEqual([{ type: 'text', text: 'x.ts\n<<<<<<< SEARCH\nonly half' }]);
  });
});

describe('splitAiderLines', () => {
  it('keeps a fenced block whole even when its lines look like markers', () => {
    const items = splitAiderLines(lines('#### show me  \n\n```\n> not output  \n#### not input  \n```\n\n> Tokens: 1 sent, 1 received.  \n'));
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'output']);
    expect(items[1].lines).toEqual(['```', '> not output  ', '#### not input  ', '```']);
    expect(items[2].offset).toBe(Buffer.byteLength('#### show me  \n\n```\n> not output  \n#### not input  \n```\n\n'));
  });
});

describe('input history', () => {
  it('pairs each stamp with its lines, in local time', () => {
    expect(parseAiderInputHistory('\n# 2026-10-20 09:15:31.250000\n+one\n+two\n\n# 2026-10-20 09:16:00\n+three\n')).toEqual([
      { ms: new Date(2026, 9, 20, 9, 15, 31, 250).getTime(), text: 'one\ntwo' },
      { ms: new Date(2026, 9, 20, 9, 16, 0).getTime(), text: 'three' },
    ]);
    expect(aiderLocalTime('not a time')).toBeNaN();
  });
});
