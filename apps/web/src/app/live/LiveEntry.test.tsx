// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { LiveEntry, formatOutput } from './page';

/**
 * One row of the live feed.
 *
 * It was a two-hundred-line callback inside the page's map — the branchiest
 * function in the repo — and reaching any of it meant driving the whole
 * page with a stream behind it. As a component it can be shown one entry at
 * a time, which is what these do: a user turn, an assistant turn, a tool
 * call, sealed reasoning, an error.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }), useParams: () => ({}),
  usePathname: () => '/live', useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as never;
});

afterEach(cleanup);

const entry = (over: Record<string, unknown> = {}) => ({
  type: 'assistant',
  role: 'assistant',
  uuid: 'm1',
  timestamp: '2026-09-04T12:00:00.000Z',
  durationMs: 1200,
  message: { role: 'assistant', model: 'claude-opus-4-6', content: [{ type: 'text', text: 'here is an answer' }] },
  ...over,
});

const item = (over: Record<string, unknown> = {}) => ({
  entry: entry(), sessionId: 'sess-1', projectName: 'demo', harness: 'claude-code', ...over,
});

const show = (over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) =>
  render(
    <LiveEntry
      item={item(over)}
      i={0}
      getColorForSession={() => '#10b981'}
      reasoningOnly={false}
      showThinking
      entries={[item(over)]}
      hoveredEntry={null}
      mostRecentOutputIdx={0}
      onEntryMouseEnter={vi.fn()}
      onEntryMouseLeave={vi.fn()}
      {...props}
    />,
  );

describe('LiveEntry', () => {
  it('shows an assistant turn with its text', () => {
    expect(show().container.textContent).toContain('here is an answer');
  });

  it('shows which project and harness a turn came from', () => {
    // The feed interleaves every project, so a row that does not say where
    // it came from is unreadable.
    const { container } = show();
    expect(container.textContent).toContain('demo');
    expect(container.textContent).toContain('claude-code');
  });

  it('shows a user turn', () => {
    const { container } = show({
      entry: entry({ type: 'user', role: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] } }),
    });
    expect(container.textContent).toContain('do the thing');
  });

  it('shows a tool call by name', () => {
    const { container } = show({
      entry: entry({
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
      }),
    });
    expect(container.textContent).toContain('Bash');
  });

  it('renders a turn carrying reasoning', () => {
    const { container } = show({
      entry: entry({
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'weighing the options' }, { type: 'text', text: 'answer' }],
        },
      }),
    });
    expect(container.textContent).toContain('answer');
  });

  it('renders sealed reasoning, which carries a signature and no text', () => {
    // opus-4-7 ships reasoning we cannot read. The row still has to say
    // that thinking happened rather than showing an empty block.
    const { container } = show({
      entry: entry({
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: '', thinking_signature: 'sig' }, { type: 'text', text: 'done' }],
        },
      }),
    });
    expect(container.textContent).toContain('done');
  });

  it('hides a row with no reasoning when the feed is filtered to reasoning', () => {
    const { container } = show({}, { reasoningOnly: true });
    expect(container.textContent).toBe('');
  });

  it('keeps a reasoning row when the feed is filtered to reasoning', () => {
    const { container } = show({
      entry: entry({
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'because' }] },
      }),
    }, { reasoningOnly: true });
    expect(container.textContent).not.toBe('');
  });

  it('renders an entry with no content at all', () => {
    // A stream can deliver a header row before anything else arrives.
    expect(() => show({ entry: entry({ message: { role: 'assistant', content: [] } }) })).not.toThrow();
  });

  it('renders an entry that reports an API error', () => {
    const { container } = show({
      entry: entry({
        isApiErrorMessage: true, apiErrorStatus: 529, error: 'server_error',
        message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 Overloaded' }] },
      }),
    });
    expect(container.textContent).toContain('529');
  });

  it('renders without a harness, which older rows lack', () => {
    expect(() => show({ harness: undefined })).not.toThrow();
  });
});

describe('formatOutput', () => {
  it('leaves plain text exactly as it arrived', () => {
    // Most tool results are shell output, and the feed shows it verbatim.
    expect(formatOutput('a.ts  b.ts\n')).toEqual({ formatted: 'a.ts  b.ts\n', isJson: false });
  });

  it('indents JSON, which is unreadable in the feed otherwise', () => {
    const r = formatOutput('{"ok":true,"count":2}');
    expect(r.isJson).toBe(true);
    expect(r.formatted).toBe('{\n  "ok": true,\n  "count": 2\n}');
  });

  it('indents a JSON array too', () => {
    expect(formatOutput('[1,2]').isJson).toBe(true);
  });

  it('leaves alone a string that only looks like JSON', () => {
    // A brace at each end is not a guarantee. Reformatting this would
    // mangle it, and the feed is the only record of what a tool returned.
    const brace = '{ this is prose in braces }';
    expect(formatOutput(brace)).toEqual({ formatted: brace, isJson: false });
  });

  it('leaves alone JSON that was cut off mid-write', () => {
    const partial = '{"ok":true,"items":[1,2';
    expect(formatOutput(partial).isJson).toBe(false);
  });

  it('sees through surrounding whitespace to decide, and keeps it when it cannot', () => {
    expect(formatOutput('  {"a":1}  ').isJson).toBe(true);
    expect(formatOutput('  not json  ').formatted).toBe('  not json  ');
  });

  it('treats an empty result as plain', () => {
    expect(formatOutput('')).toEqual({ formatted: '', isJson: false });
  });
});
