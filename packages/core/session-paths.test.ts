import { describe, it, expect } from 'vitest';
import { harnessFor, parseProjectName, resolveSessionFile } from './session-paths';

/**
 * Every harness reaches the session viewer through this registry, so a
 * project name that resolves to the wrong adapter shows an empty session
 * rather than an error — the file is simply looked for in the wrong place,
 * or its entries normalise to nothing.
 */
const normalize = (projectName: string, raw: unknown) =>
  harnessFor(projectName).adapter.normalize(raw);

describe('harnessFor', () => {
  it('reads a name with no prefix as Claude Code, which predates the convention', () => {
    const { adapter, slug } = harnessFor('-home-fox-git-demo');
    expect(adapter.name).toBe('claude-code');
    expect(slug).toBe('-home-fox-git-demo');
  });

  it('splits {harness}:{slug} at the first colon', () => {
    const { adapter, slug } = harnessFor('agnt:-home-fox-git-demo');
    expect(adapter.name).toBe('agnt');
    expect(slug).toBe('-home-fox-git-demo');
  });

  it('serves a harness it has never heard of', () => {
    // Native adopters write unfirehose/1.0 to ~/.{harness}/unfirehose/, so a
    // new one works before anyone adds it here. That is the point of the
    // spec, and it is why the fallback is a real adapter and not an error.
    const { adapter, slug } = harnessFor('brand-new-agent:some-project');
    expect(adapter.name).toBe('brand-new-agent');
    expect(slug).toBe('some-project');
    expect(adapter.sessionFile('some-project', 'abc')).toContain('/.brand-new-agent/unfirehose/');
  });

  it('files each known harness under its own directory', () => {
    expect(resolveSessionFile('fetch:proj', 'sid')).toContain('/.fetch/');
    expect(resolveSessionFile('agnt:proj', 'sid')).toContain('/.agnt/');
    expect(resolveSessionFile('uncloseai:proj', 'sid')).toContain('/.uncloseai/');
    expect(resolveSessionFile('fetch:proj', 'sid').endsWith('/sid.jsonl')).toBe(true);
  });

  it('reports the harness and slug a name carries', () => {
    expect(parseProjectName('uncloseai-cli:demo')).toEqual({ harness: 'uncloseai-cli', slug: 'demo' });
    expect(parseProjectName('plain-name')).toEqual({ harness: 'claude-code', slug: 'plain-name' });
  });
});

describe('native harnesses', () => {
  it('pass an unfirehose/1.0 message through untouched', () => {
    const message = { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] };
    expect(normalize('agnt:proj', message)).toBe(message);
  });

  it('reject an entry that is not a message', () => {
    expect(normalize('agnt:proj', { type: 'metric', value: 1 })).toBeNull();
  });

  it('reject a role the spec does not define', () => {
    expect(normalize('agnt:proj', { type: 'message', role: 'narrator' })).toBeNull();
  });
});

describe('uncloseai-cli, which writes a pre-1.0 shape', () => {
  it('reads a session_start as the prompt that opened it', () => {
    const m = normalize('uncloseai-cli:proj', {
      type: 'session_start', timestamp: '2026-09-04T12:00:00Z', prompt: 'find the leak',
    })!;
    expect(m.role).toBe('user');
    expect(m.content).toEqual([{ type: 'text', text: 'find the leak' }]);
  });

  it('names a model even when the entry does not', () => {
    // Unattributed tokens are unpriceable, and this harness serves one model.
    const m = normalize('uncloseai-cli:proj', { type: 'assistant', content: 'done' })!;
    expect(m.model).toBe('hermes-3-8b');
  });

  it('parses tool arguments that arrive as a JSON string', () => {
    const m = normalize('uncloseai-cli:proj', {
      type: 'tool_call', tool: 'read_file', args: '{"path":"/tmp/x"}',
    })!;
    expect(m.content![0]).toMatchObject({
      type: 'tool-call', toolName: 'read_file', input: { path: '/tmp/x' },
    });
  });

  it('takes tool arguments that arrive already parsed', () => {
    const m = normalize('uncloseai-cli:proj', {
      type: 'tool_call', tool: 'read_file', args: { path: '/tmp/x' },
    })!;
    expect((m.content![0] as { input: unknown }).input).toEqual({ path: '/tmp/x' });
  });

  it('keeps unparseable arguments rather than dropping the call', () => {
    // A tool call that happened is worth recording even when we cannot read
    // what it was given.
    const m = normalize('uncloseai-cli:proj', {
      type: 'tool_call', tool: 'read_file', args: '{ truncated',
    })!;
    expect((m.content![0] as { input: { raw: string } }).input.raw).toBe('{ truncated');
  });

  it('pairs a tool_result with the call it answers', () => {
    const m = normalize('uncloseai-cli:proj', {
      type: 'tool_result', tool: 'read_file', toolCallId: 'call-1', output: 'contents',
    })!;
    expect(m.role).toBe('tool');
    expect(m.content![0]).toMatchObject({ toolCallId: 'call-1', output: 'contents', isError: false });
  });

  it('reads either spelling of a result payload', () => {
    const viaResult = normalize('uncloseai-cli:proj', { type: 'tool_result', result: 'from result' })!;
    expect((viaResult.content![0] as { output: string }).output).toBe('from result');
  });

  it('marks the end of a session as a system note with no content', () => {
    const m = normalize('uncloseai-cli:proj', { type: 'session_end', timestamp: '2026-09-04T13:00:00Z' })!;
    expect(m.role).toBe('system');
    expect(m.subtype).toBe('session_end');
    expect(m.content).toEqual([]);
  });

  it('passes through an entry already in the canonical shape', () => {
    // The harness is migrating; both shapes appear in one file during it.
    const m = normalize('uncloseai-cli:proj', {
      type: 'message', role: 'assistant', content: [{ type: 'text', text: 'new shape' }],
    })!;
    expect(m.role).toBe('assistant');
  });

  it('drops an event it does not recognise', () => {
    expect(normalize('uncloseai-cli:proj', { type: 'heartbeat' })).toBeNull();
  });
});
