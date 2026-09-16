// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { RewritesTab, RewritesTabBadge, summaryLine, rewritesUrl, type RewriteRow, type RewritesResponse } from './RewritesTab';

/**
 * The Rewrites tab of the live view.
 *
 * A harness that rewrites lines near the tail of its own live journal is
 * caught by the witness, and the ingester records the leaf before and
 * after. This tab is where those records are read. The route is stubbed:
 * what these test is the tab's reading of the contract, not the ledger.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }), useParams: () => ({}),
  usePathname: () => '/live', useSearchParams: () => new URLSearchParams(),
}));

const empty: RewritesResponse = {
  summary: { total: 0, sessions: 0, byHarness: {}, maxTailDistance: 0, contentChanged: 0, metadataOnly: 0, byChangedKey: {} },
  rows: [],
};

const row = (over: Partial<RewriteRow> = {}): RewriteRow => ({
  id: 1,
  session_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  project: '-home-fox-git-demo',
  harness: 'claude-code',
  seq: 2255,
  kind: 'rewritten',
  observed_at: '2026-09-16T14:02:11.000Z',
  file_lines: 2258,
  tail_distance: 3,
  before_hash: 'b'.repeat(64),
  after_hash: 'a'.repeat(64),
  before_text: '{"uuid":"m1","type":"assistant","message":{"content":"first"}}',
  after_text: '{"uuid":"m1","type":"assistant","message":{"content":"second"},"isCompactSummary":true}',
  before_len: 62,
  after_len: 88,
  truncated: false,
  changed_keys: ['message', 'isCompactSummary'],
  content_changed: true,
  before_type: 'assistant',
  after_type: 'assistant',
  ...over,
});

const filled: RewritesResponse = {
  summary: {
    total: 3, sessions: 2, byHarness: { 'claude-code': 2, uncloseai: 1 }, maxTailDistance: 7,
    contentChanged: 2, metadataOnly: 1, byChangedKey: { message: 2, isCompactSummary: 1 },
  },
  rows: [
    row(),
    row({ id: 2, harness: 'uncloseai', project: 'uncloseai:demo', seq: 40, tail_distance: 7, content_changed: false, changed_keys: ['ts'], observed_at: '2026-09-16T13:00:00.000Z' }),
    row({ id: 3, kind: 'truncated', seq: 2257, tail_distance: 1, after_hash: null, after_text: null, after_len: null, after_type: null, changed_keys: [], content_changed: false, observed_at: '2026-09-16T14:30:00.000Z' }),
  ],
};

let answer: RewritesResponse = empty;
const calls = () => (global.fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map((c) => c[0]);

beforeEach(() => {
  answer = empty;
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => answer })) as never;
});

afterEach(cleanup);

describe('RewritesTab', () => {
  it('shows the empty state and says what it watches when nothing was rewritten', async () => {
    render(<RewritesTab />);
    await screen.findByTestId('rewrites-empty');
    const t = screen.getByTestId('rewrites-empty').textContent ?? '';
    expect(t).toContain('no rewrites recorded in the last 24h — every unchained live journal has matched its shadow');
    expect(t).toContain('This tab watches');
    expect(calls()[0]).toBe(rewritesUrl());
  });

  it('shows the summary line and rows newest first', async () => {
    answer = filled;
    render(<RewritesTab />);
    await screen.findAllByTestId('rewrite-row');
    expect(screen.getByTestId('rewrites-summary').textContent).toBe(
      '3 rewrites in 2 sessions over 24h · max tail distance 7 · content changed 2 · metadata only 1 · top keys: message ×2, isCompactSummary ×1',
    );
    const rows = screen.getAllByTestId('rewrite-row');
    expect(rows).toHaveLength(3);
    // id 3 was observed last, so it is first.
    expect(rows[0].textContent).toContain('line 2257, 1 from tail');
    expect(rows[0].textContent).toContain('truncated');
    expect(rows[1].textContent).toContain('line 2255, 3 from tail');
    expect(rows[1].textContent).toContain('rewritten');
    expect(rows[1].textContent).toContain('content changed');
    expect(rows[1].textContent).toContain('isCompactSummary');
    // Session id is short and linked to the session page.
    const link = rows[1].querySelector('a') as HTMLAnchorElement;
    expect(link.textContent).toBe('aaaaaaaa');
    expect(link.getAttribute('href')).toBe('/projects/-home-fox-git-demo/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    // A metadata-only row carries no content-changed marker.
    expect(rows[2].querySelector('[data-testid="content-changed"]')).toBeNull();
  });

  it('expands a row into BEFORE and AFTER with both leaf hashes and the changed keys lit', async () => {
    answer = filled;
    render(<RewritesTab />);
    const rows = await screen.findAllByTestId('rewrite-row');
    expect(screen.queryByTestId('before-after')).toBeNull();
    fireEvent.click(rows[1].querySelector('button[aria-expanded]')!);
    const panel = screen.getByTestId('before-after');
    const t = panel.textContent ?? '';
    expect(t).toContain('BEFORE');
    expect(t).toContain('AFTER');
    expect(t).toContain('leaf ' + 'b'.repeat(12));
    expect(t).toContain('leaf ' + 'a'.repeat(12));
    expect(panel.querySelector(`[title="${'b'.repeat(64)}"]`)).not.toBeNull();
    // Pretty-printed, so the nested content sits on its own indented line.
    expect(t).toContain('"content": "second"');
    const lit = Array.from(panel.querySelectorAll('[data-changed="true"]')).map((el) => el.textContent?.trim());
    expect(lit.some((l) => l?.startsWith('"message":'))).toBe(true);
    expect(lit.some((l) => l?.startsWith('"isCompactSummary":'))).toBe(true);
    expect(lit.some((l) => l?.startsWith('"uuid":'))).toBe(false);
    // Click again to fold.
    fireEvent.click(rows[1].querySelector('button[aria-expanded]')!);
    expect(screen.queryByTestId('before-after')).toBeNull();
  });

  it('says the line no longer exists on the AFTER side of a truncation', async () => {
    answer = filled;
    render(<RewritesTab />);
    const rows = await screen.findAllByTestId('rewrite-row');
    fireEvent.click(rows[0].querySelector('button[aria-expanded]')!);
    const t = screen.getByTestId('before-after').textContent ?? '';
    expect(t).toContain('the line no longer exists');
    expect(t).toContain('leaf ' + 'b'.repeat(12));
  });

  it('notes a body the API capped', async () => {
    answer = { ...filled, rows: [row({ truncated: true, before_len: 9000, after_len: 9100, before_text: '{"a":1', after_text: '{"a":2' })] };
    render(<RewritesTab />);
    const rows = await screen.findAllByTestId('rewrite-row');
    fireEvent.click(rows[0].querySelector('button[aria-expanded]')!);
    const t = screen.getByTestId('before-after').textContent ?? '';
    expect(t).toContain('truncated at 4096 of 9000 chars');
    expect(t).toContain('truncated at 4096 of 9100 chars');
    // A capped body does not parse; it is shown as it came, unlit.
    expect(screen.getByTestId('before-after').querySelector('[data-changed="true"]')).toBeNull();
  });

  it('filters rows by harness chip and asks the API for that harness', async () => {
    answer = filled;
    render(<RewritesTab />);
    await screen.findAllByTestId('rewrite-row');
    const filter = screen.getByTestId('harness-filter');
    expect(filter.textContent).toContain('claude-code');
    expect(filter.textContent).toContain('uncloseai');
    const chip = Array.from(filter.querySelectorAll('button')).find((b) => b.textContent?.includes('uncloseai'))!;
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getAllByTestId('rewrite-row')).toHaveLength(1));
    expect(screen.getAllByTestId('rewrite-row')[0].textContent).toContain('uncloseai:demo');
    await waitFor(() => expect(calls().at(-1)).toBe(rewritesUrl({ harness: 'uncloseai' })));
    // The chips stay, so the other harnesses can still be picked.
    expect(screen.getByTestId('harness-filter').textContent).toContain('claude-code');
    // Same chip again clears it.
    fireEvent.click(Array.from(screen.getByTestId('harness-filter').querySelectorAll('button')).find((b) => b.textContent?.includes('uncloseai'))!);
    await waitFor(() => expect(screen.getAllByTestId('rewrite-row')).toHaveLength(3));
  });

  it('reports the total for the tab badge and polls while visible, not while hidden', async () => {
    vi.useFakeTimers();
    try {
      answer = filled;
      const onTotal = vi.fn();
      render(<RewritesTab onTotal={onTotal} pollMs={1000} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(onTotal).toHaveBeenLastCalledWith(3);
      const before = calls().length;
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
      expect(calls().length).toBe(before + 2);
      // Hidden: the interval is cleared and nothing is fetched.
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      const hiddenAt = calls().length;
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(calls().length).toBe(hiddenAt);
      // Back: one fetch at once, then the interval again.
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0); });
      expect(calls().length).toBe(hiddenAt + 1);
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      vi.useRealTimers();
    }
  });

  it('says so when the route is unavailable', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) as never;
    render(<RewritesTab />);
    await waitFor(() => expect(screen.getByTestId('rewrites-summary').textContent).toContain('rewrites unavailable: HTTP 404'));
  });
});

describe('RewritesTabBadge', () => {
  it('shows the count when there is one', () => {
    render(<RewritesTabBadge count={3} />);
    expect(screen.getByTestId('rewrites-badge').textContent).toBe('3');
  });

  it('shows nothing at zero, so a quiet day is quiet', () => {
    const { container } = render(<RewritesTabBadge count={0} />);
    expect(container.textContent).toBe('');
  });
});

describe('summaryLine', () => {
  it('reads as one sentence, singular when it is one', () => {
    expect(summaryLine({ ...empty.summary, total: 1, sessions: 1, maxTailDistance: 2 })).toBe(
      '1 rewrite in 1 session over 24h · max tail distance 2 · content changed 0 · metadata only 0',
    );
  });
});
