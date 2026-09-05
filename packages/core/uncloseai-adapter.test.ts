import { describe, it, expect } from 'vitest';
import { normalizeUncloseaiEntry, normalizeNativeEntry } from './uncloseai-adapter';

/**
 * Two adapters into our internal message shape.
 *
 * Adapters fail silently by design: an unrecognised event returns null and
 * ingestion moves on, so a harness whose format drifted appears as a
 * project with sessions and no messages rather than as an error. These pin
 * the shapes we do recognise, and the renames that separate what a harness
 * writes from what our tables hold.
 */

describe('normalizeUncloseaiEntry', () => {
  it('reads the opening prompt as the user turn it was', () => {
    const e = normalizeUncloseaiEntry({ type: 'session_start', prompt: 'summarise this', timestamp: '2026-09-04T10:00:00Z' });
    expect(e.type).toBe('user');
    expect(e.message.content).toEqual([{ type: 'text', text: 'summarise this' }]);
    expect(e.timestamp).toBe('2026-09-04T10:00:00Z');
  });

  it('gives a session_start with no prompt an empty turn rather than undefined', () => {
    // insertContentBlocks writes text_content straight through; undefined
    // there is a NOT NULL violation mid-ingest.
    expect(normalizeUncloseaiEntry({ type: 'session_start' }).message.content[0].text).toBe('');
  });

  it('parses tool arguments that arrive as a JSON string', () => {
    const e = normalizeUncloseaiEntry({ type: 'tool_call', tool: 'Bash', args: '{"command":"ls"}' });
    expect(e.message.content[0]).toMatchObject({ type: 'tool_use', name: 'Bash', input: { command: 'ls' } });
  });

  it('takes tool arguments that arrive already parsed', () => {
    const e = normalizeUncloseaiEntry({ type: 'tool_call', tool: 'Read', args: { path: '/etc/hosts' } });
    expect(e.message.content[0].input).toEqual({ path: '/etc/hosts' });
  });

  it('keeps malformed arguments as text instead of dropping the call', () => {
    // A truncated write leaves half a JSON object. The call still happened,
    // and losing it loses the turn it belongs to.
    const e = normalizeUncloseaiEntry({ type: 'tool_call', tool: 'Bash', args: '{"command": "ls' });
    expect(e.message.content[0].input).toEqual({ raw: '{"command": "ls' });
  });

  it('names an unnamed tool rather than writing null', () => {
    expect(normalizeUncloseaiEntry({ type: 'tool_call' }).message.content[0].name).toBe('unknown');
  });

  it('marks the end of a session as a system entry', () => {
    const e = normalizeUncloseaiEntry({ type: 'session_end', timestamp: '2026-09-04T11:00:00Z' });
    expect(e).toMatchObject({ type: 'system', subtype: 'session_end' });
  });

  it('skips an event type it does not know', () => {
    expect(normalizeUncloseaiEntry({ type: 'heartbeat' })).toBeNull();
  });
});

describe('normalizeNativeEntry', () => {
  const message = (over: Record<string, unknown> = {}) => ({
    type: 'message', role: 'assistant', id: 'm1', timestamp: '2026-09-04T10:00:00Z', ...over,
  });

  it('ignores a session header, which is not a message', () => {
    expect(normalizeNativeEntry({ type: 'session', harness: 'agnt' })).toBeNull();
  });

  it('ignores a role our tables have no column for', () => {
    expect(normalizeNativeEntry(message({ role: 'tool' }))).toBeNull();
  });

  it('renames every block type the 1.0 spec renamed', () => {
    // Our tables still hold Claude Code's internal names. A block that keeps
    // its spec name lands as an unrecognised type and renders as nothing.
    const e = normalizeNativeEntry(message({
      content: [
        { type: 'tool-call', toolCallId: 't1', toolName: 'Bash', input: { command: 'ls' } },
        { type: 'tool-result', toolCallId: 't1', output: 'a.ts', isError: false },
        { type: 'reasoning', text: 'weighing it' },
        { type: 'text', text: 'done' },
      ],
    }));
    expect(e.message.content.map((b: { type: string }) => b.type))
      .toEqual(['tool_use', 'tool_result', 'thinking', 'text']);
    expect(e.message.content[0]).toMatchObject({ id: 't1', name: 'Bash', input: { command: 'ls' } });
    expect(e.message.content[1]).toMatchObject({ tool_use_id: 't1', content: 'a.ts', is_error: false });
    expect(e.message.content[2].thinking).toBe('weighing it');
  });

  it('passes a block type it does not rename through untouched', () => {
    const block = { type: 'image', source: { data: 'x' } };
    expect(normalizeNativeEntry(message({ content: [block] })).message.content[0]).toEqual(block);
  });

  it('treats missing content as no blocks, not as a crash', () => {
    expect(normalizeNativeEntry(message()).message.content).toEqual([]);
  });
});
