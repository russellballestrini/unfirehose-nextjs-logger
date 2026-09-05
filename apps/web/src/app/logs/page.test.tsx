// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

/**
 * Every message we have, in one list.
 *
 * This page is the last resort when something is not where it should be, so
 * its job is to be honest about what it is showing: which filter is on, how
 * far into the results you are, and what matched your search. The row is
 * where that lives, and none of it was covered.
 */

let data: Record<string, unknown> | undefined;
let lastKey = '';
vi.mock('swr', () => ({
  default: (key: string) => {
    lastKey = String(key);
    return { data, error: undefined, isLoading: data === undefined, mutate: vi.fn() };
  },
}));
vi.mock('@unturf/unfirehose-ui/TimeRangeSelect', () => ({
  TimeRangeSelect: () => null,
  useTimeRange: () => ['24h', vi.fn()],
  getTimeRangeFrom: () => '2026-09-04T00:00:00Z',
}));
vi.mock('@unturf/unfirehose-ui/PageContext', () => ({ PageContext: () => null }));

const LogsPage = (await import('./page')).default;

const entry = (over: Record<string, unknown> = {}) => ({
  type: 'assistant',
  projectName: '-home-fox-git-unfirehose',
  projectDisplay: 'unfirehose',
  sessionUuid: 'sess-abc',
  sessionDisplay: 'a session',
  model: 'claude-opus-4-6-20260101',
  timestamp: '2026-09-05T11:00:00Z',
  preview: 'the quick brown fox\njumped over',
  ...over,
});

beforeEach(() => { data = { entries: [entry()], total: 1 }; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('a log row', () => {
  it('labels who spoke, in three letters that line up', () => {
    // The column is fixed-width; a full word would push every row's text to
    // a different place and make the list unreadable at a glance.
    data = { entries: [entry({ type: 'user' }), entry({ type: 'assistant' }), entry({ type: 'system' })], total: 3 };
    render(<LogsPage />);
    expect(screen.getByText('USR')).toBeTruthy();
    expect(screen.getByText('AST')).toBeTruthy();
    expect(screen.getByText('SYS')).toBeTruthy();
  });

  it('falls back to the system label for a type it does not know', () => {
    // Types arrive from whatever harness wrote the transcript. An unknown
    // one must render as a row, not as a blank.
    data = { entries: [entry({ type: 'tool-result' })], total: 1 };
    render(<LogsPage />);
    expect(screen.getByText('SYS')).toBeTruthy();
  });

  it('links to the project and to the session separately', () => {
    render(<LogsPage />);
    const hrefs = Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/projects/-home-fox-git-unfirehose');
    expect(hrefs).toContain('/projects/-home-fox-git-unfirehose/sess-abc');
  });

  it('encodes a project name so a slash in it cannot break the link', () => {
    // Encoded project names are paths. An unescaped one lands on a route
    // that does not exist.
    data = { entries: [entry({ projectName: 'uncloseai:tmp/x' })], total: 1 };
    render(<LogsPage />);
    const hrefs = Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/projects/uncloseai%3Atmp%2Fx');
  });

  it('omits the session link when the row does not know its session', () => {
    data = { entries: [entry({ sessionDisplay: null })], total: 1 };
    render(<LogsPage />);
    const hrefs = Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).not.toContain('/projects/-home-fox-git-unfirehose/sess-abc');
  });

  it('shortens a model name to the part that differs', () => {
    // Every model here starts "claude-" and ends in a date. Neither
    // distinguishes one row from another; the middle does.
    render(<LogsPage />);
    expect(screen.getByText('opus-4-6')).toBeTruthy();
  });

  it('leaves out the model when a row has none', () => {
    data = { entries: [entry({ model: null })], total: 1 };
    expect(() => render(<LogsPage />)).not.toThrow();
  });

  it('flattens newlines in the collapsed preview, so one row stays one row', () => {
    render(<LogsPage />);
    expect(screen.getByText('the quick brown fox jumped over')).toBeTruthy();
  });

  it('shows the text as written once the row is expanded', () => {
    render(<LogsPage />);
    fireEvent.click(screen.getByText('the quick brown fox jumped over'));
    const expanded = screen.getByText((_, el) => el?.className.includes('whitespace-pre-wrap') ?? false);
    expect(expanded.textContent).toBe('the quick brown fox\njumped over');
  });

  it('collapses again on a second click', () => {
    render(<LogsPage />);
    const row = document.querySelector('.border-l-2') as HTMLElement;
    fireEvent.click(row);
    expect(document.querySelector('.whitespace-pre-wrap')).toBeTruthy();
    fireEvent.click(row);
    expect(document.querySelector('.whitespace-pre-wrap')).toBeNull();
    expect(document.querySelector('.line-clamp-2')).toBeTruthy();
  });

  it('renders a row whose preview never arrived', () => {
    // Rows come from a query that can select a message with no text block.
    data = { entries: [entry({ preview: null })], total: 1 };
    expect(() => render(<LogsPage />)).not.toThrow();
  });
});

describe('search highlighting', () => {
  /** Type into the box and let the 300ms debounce fire. */
  function searchFor(term: string) {
    vi.useFakeTimers();
    render(<LogsPage />);
    const box = document.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.change(box, { target: { value: term } });
    act(() => { vi.advanceTimersByTime(300); });
  }

  it('marks the matched span and leaves the rest of the line alone', () => {
    searchFor('brown');
    const mark = document.querySelector('.bg-yellow-400\\/30');
    expect(mark?.textContent).toBe('brown');
    expect(document.body.textContent).toContain('the quick ');
    expect(document.body.textContent).toContain(' fox jumped over');
  });

  it('matches regardless of case but highlights what the text actually says', () => {
    // Highlighting the search term instead of the matched text would
    // rewrite the log in front of the reader.
    searchFor('BROWN');
    expect(document.querySelector('.bg-yellow-400\\/30')?.textContent).toBe('brown');
  });

  it('highlights nothing when the term is not in this row', () => {
    searchFor('zebra');
    expect(document.querySelector('.bg-yellow-400\\/30')).toBeNull();
  });

  it('waits for the typing to stop before asking the server', () => {
    // Every keystroke firing a query over 1.6M rows is how this page used
    // to make the whole server slow.
    vi.useFakeTimers();
    render(<LogsPage />);
    const box = document.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'b' } });
    fireEvent.change(box, { target: { value: 'br' } });
    expect(lastKey).not.toContain('search=');
    act(() => { vi.advanceTimersByTime(300); });
    expect(lastKey).toContain('search=br');
  });
});

describe('what the page asks for', () => {
  it('asks only for reasoning when that filter is chosen', () => {
    // 'Reasoning' is not a message type. It is assistant messages that
    // carry a reasoning block, which is a different question entirely.
    render(<LogsPage />);
    const select = Array.from(document.querySelectorAll('select'))
      .find((s) => s.textContent?.includes('Reasoning'))!;
    fireEvent.change(select, { target: { value: 'reasoning' } });
    expect(lastKey).toContain('types=assistant');
    expect(lastKey).toContain('has_thinking=true');
  });

  it('does not ask for thinking on any other filter', () => {
    render(<LogsPage />);
    expect(lastKey).not.toContain('has_thinking');
  });

  it('carries the time range into the query', () => {
    render(<LogsPage />);
    expect(lastKey).toContain('from=2026-09-04');
  });
});

/**
 * The redesign. For a long time most rows here said nothing; these pin that
 * every kind of message now says what it did, and that a session's rows sit
 * under one header instead of repeating the project and session two hundred
 * times down the page.
 */
describe('what a row says', () => {
  const chips = () => [...document.querySelectorAll('.font-mono.rounded')].map((el) => el.textContent?.trim());

  it('names the tool and shows the command for a call', () => {
    data = { entries: [entry({ kind: 'tool-call', tool: 'Bash', toolArg: 'make test', preview: 'Bash make test' })], total: 1 };
    render(<LogsPage />);
    expect(chips()).toContain('Bash');
    // The chip says Bash; the row does not say it twice.
    expect(screen.getByText('make test')).toBeTruthy();
    expect(screen.queryByText('Bash make test')).toBeNull();
  });

  it('marks a result as the answer to its tool, and shows its first line', () => {
    data = { entries: [entry({ type: 'user', kind: 'tool-result', tool: 'Bash', preview: 'M src/a.ts' })], total: 1 };
    render(<LogsPage />);
    expect(chips()).toContain('↳ Bash');
    expect(screen.getByText('M src/a.ts')).toBeTruthy();
  });

  it('shows an error result as one, in the chip and on the row', () => {
    data = { entries: [entry({ type: 'user', kind: 'tool-result', tool: 'Bash', isError: true, preview: 'command not found' })], total: 1 };
    render(<LogsPage />);
    expect(chips().some((c) => c?.includes('✕'))).toBe(true);
    expect((document.querySelector('.border-l-2') as HTMLElement).style.borderColor).toBe('var(--color-error)');
  });

  it('says a message reasoned when that is all it did', () => {
    data = { entries: [entry({ kind: 'reasoning', hasReasoning: true, preview: '(reasoning, sealed)' })], total: 1 };
    render(<LogsPage />);
    expect(chips()).toContain('reasoning');
  });

  it('labels a system row by its subtype', () => {
    data = { entries: [entry({ type: 'system', kind: 'system', subtype: 'turn_duration', preview: 'turn duration 4.2s' })], total: 1 };
    render(<LogsPage />);
    expect(chips()).toContain('turn duration');
    expect(screen.getByText('turn duration 4.2s')).toBeTruthy();
  });

  it('says "no content" rather than leaving a blank row', () => {
    data = { entries: [entry({ kind: 'empty', preview: '' })], total: 1 };
    render(<LogsPage />);
    expect(screen.getByText('no content')).toBeTruthy();
  });

  it('shows a clock time on each row, with the full stamp on hover', () => {
    render(<LogsPage />);
    const t = document.querySelector('[title*="ago"]') as HTMLElement;
    expect(t).toBeTruthy();
    expect(t.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe('grouping by session', () => {
  it('puts consecutive rows from one session under one header', () => {
    data = { entries: [entry({ id: 1 }), entry({ id: 2 }), entry({ id: 3 })], total: 3 };
    render(<LogsPage />);
    expect(document.querySelectorAll('section')).toHaveLength(1);
    expect(document.querySelector('section')?.textContent).toContain('3');
  });

  it('starts a new header when the session changes, and again when it comes back', () => {
    // Grouping is by run, not by identity: interleaved sessions read in
    // the order they happened.
    data = { entries: [entry({ id: 1 }), entry({ id: 2, sessionUuid: 'other', sessionDisplay: 'other' }), entry({ id: 3 })], total: 3 };
    render(<LogsPage />);
    expect(document.querySelectorAll('section')).toHaveLength(3);
  });

  it('names the project and session once, in the header, not on every row', () => {
    data = { entries: [entry({ id: 1 }), entry({ id: 2 })], total: 2 };
    render(<LogsPage />);
    expect(screen.getAllByText('unfirehose')).toHaveLength(1);
    expect(screen.getAllByText('a session')).toHaveLength(1);
  });
});

describe('paging honestly', () => {
  it('asks for a page size the API will actually honour', () => {
    // The API caps a page at 500. The menu used to offer 30,000, and the
    // page count was computed against a size the server never returned.
    render(<LogsPage />);
    expect(lastKey).toContain('limit=250');
    const options = [...document.querySelectorAll('option')].map((o) => o.value).filter((v) => /^\d+$/.test(v)).map(Number);
    expect(Math.max(...options)).toBeLessThanOrEqual(500);
  });

  it('says which rows are on screen', () => {
    data = { entries: [entry({ id: 1 }), entry({ id: 2 })], total: 40 };
    render(<LogsPage />);
    expect(document.body.textContent).toContain('1–2 of 40');
  });
});

