import { describe, it, expect } from 'vitest';
import { summarise, toolArgOf, firstLine, type PreviewBlock } from './log-preview';

/**
 * One line that says what a message did.
 *
 * For a long time most rows on the all-logs page said nothing. These pin the
 * rule for each kind of message, so a blank row is a failing test rather
 * than something a reader learns to scroll past.
 */

const block = (over: Partial<PreviewBlock>): PreviewBlock => ({
  block_type: 'text', text_content: null, tool_name: null, tool_input: null, tool_use_id: null, is_error: 0, ...over,
});
const call = (tool: string, input: unknown, id = 'tu_1') =>
  block({ block_type: 'tool-call', tool_name: tool, tool_input: JSON.stringify(input), tool_use_id: id });
const result = (text: string | null, over: Partial<PreviewBlock> = {}) =>
  block({ block_type: 'tool-result', text_content: text, tool_use_id: 'tu_1', ...over });

describe('toolArgOf', () => {
  it('shows the command for a shell call, which is what a reader wants to see', () => {
    expect(toolArgOf('Bash', JSON.stringify({ command: 'git status --porcelain', description: 'Check tree' })))
      .toBe('git status --porcelain');
  });

  it('knows each harness\'s name for the same thing', () => {
    // Claude Code writes file_path; uncloseai writes path. Both are "the file".
    expect(toolArgOf('Read', JSON.stringify({ file_path: '/a/b.ts' }))).toBe('/a/b.ts');
    expect(toolArgOf('read', JSON.stringify({ path: '/a/b.ts' }))).toBe('/a/b.ts');
  });

  it('shortens a deep path to the tail a reader recognises', () => {
    expect(toolArgOf('Edit', JSON.stringify({ file_path: '/home/fox/git/frank/frank/synth.py' })))
      .toBe('…/frank/frank/synth.py');
  });

  it('shows the pattern for a search and the subject for a task', () => {
    expect(toolArgOf('Grep', JSON.stringify({ pattern: 'def foo', path: '/x' }))).toBe('def foo');
    expect(toolArgOf('TaskCreate', JSON.stringify({ subject: 'Rebuild dataset', description: 'long' }))).toBe('Rebuild dataset');
  });

  it('falls back to the first string for a tool it has no rule for', () => {
    expect(toolArgOf('Mystery', JSON.stringify({ n: 3, thing: 'hello', other: 'x' }))).toBe('hello');
  });

  it('keeps only the first line of a multi-line argument', () => {
    expect(toolArgOf('Bash', JSON.stringify({ command: 'cd x &&\nmake all' }))).toBe('cd x &&');
  });

  it('survives input that is not JSON', () => {
    expect(toolArgOf('Bash', 'not json at all')).toBe('not json at all');
    expect(toolArgOf('Bash', null)).toBeNull();
  });
});

describe('firstLine', () => {
  it('skips leading blank lines and trims', () => {
    expect(firstLine('\n\n   hello world  \nmore')).toBe('hello world');
  });
  it('caps long lines with an ellipsis', () => {
    expect(firstLine('x'.repeat(300), 20)).toHaveLength(20);
    expect(firstLine('x'.repeat(300), 20).endsWith('…')).toBe(true);
  });
});

describe('summarise', () => {
  it('names the tool and its argument for a call, not just "[Bash]"', () => {
    const s = summarise([call('Bash', { command: 'make test' })]);
    expect(s).toMatchObject({ kind: 'tool-call', tool: 'Bash', toolArg: 'make test' });
    expect(s.preview).toBe('Bash make test');
  });

  it('shows the first line of a tool result, which used to be an empty row', () => {
    // 607 of the last 2,000 messages' blocks were results the preview query
    // did not even select. Every one of those rows was blank.
    const s = summarise([result('\n M src/a.ts\n?? src/b.ts\n')], { type: 'user' });
    expect(s.kind).toBe('tool-result');
    expect(s.preview).toBe('M src/a.ts');
  });

  it('resolves a result\'s tool from the call that produced it', () => {
    // The call is a different message; the caller supplies the lookup.
    const s = summarise([result('ok')], { type: 'user', toolNameFor: (id) => (id === 'tu_1' ? 'Bash' : null) });
    expect(s.tool).toBe('Bash');
  });

  it('flags an error result and says so when it produced no output', () => {
    const s = summarise([result('', { is_error: 1 })], { type: 'user' });
    expect(s.isError).toBe(true);
    expect(s.preview).toBe('(error, no output)');
  });

  it('says a message reasoned even when the reasoning is sealed', () => {
    // opus-4-7 ships a signature and no text. 401 of 429 recent reasoning
    // blocks were sealed, and every row that was only that showed nothing.
    const s = summarise([block({ block_type: 'reasoning', text_content: '' })]);
    expect(s).toMatchObject({ kind: 'reasoning', sealedReasoning: true, preview: '(reasoning, sealed)' });
  });

  it('excerpts readable reasoning and marks it', () => {
    const s = summarise([block({ block_type: 'thinking', text_content: 'Let me weigh this.\nMore.' })]);
    expect(s.preview).toBe('[reasoning] Let me weigh this.');
    expect(s.hasReasoning).toBe(true);
  });

  it('lets text lead when a message has text and a tool call', () => {
    const s = summarise([block({ text_content: 'Running the tests now.' }), call('Bash', { command: 'make test' })]);
    expect(s.kind).toBe('text');
    expect(s.preview).toBe('Running the tests now. · Bash make test');
    expect(s.tool).toBe('Bash');
  });

  it('labels a system event by its subtype, with the duration when it has one', () => {
    expect(summarise([], { type: 'system', subtype: 'turn_duration', durationMs: 4200 }).preview).toBe('turn duration 4.2s');
    expect(summarise([], { type: 'system', subtype: 'session_end' }).preview).toBe('session end');
    expect(summarise([], { type: 'system', subtype: 'turn_duration', durationMs: 125_000 }).preview).toBe('turn duration 2m 5s');
  });

  it('is empty, and says so, only when there is truly nothing', () => {
    expect(summarise([]).kind).toBe('empty');
    expect(summarise([]).preview).toBe('');
  });

  it('caps the preview so a pasted file does not become the row', () => {
    expect(summarise([block({ text_content: 'x'.repeat(5000) })]).preview.length).toBeLessThanOrEqual(500);
  });
});
