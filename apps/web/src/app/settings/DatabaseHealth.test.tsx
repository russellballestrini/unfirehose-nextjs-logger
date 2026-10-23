// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';

let answer: Record<string, unknown> | undefined;
const mutate = vi.fn();
vi.mock('swr', () => ({ default: () => ({ data: answer, error: undefined, mutate }) }));
const { DatabaseHealth } = await import('./DatabaseHealth');

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const health = (over: Record<string, unknown> = {}) => ({
  path: '/home/fox/.unfirehose/unfirehose.db',
  pageSize: 4096, dbBytes: 7 * GiB, freelistBytes: 300 * MiB, walBytes: 12 * MiB,
  disk: { path: '/home/fox', freeBytes: 200 * GiB, totalBytes: 1000 * GiB }, diskLevel: 'ok', lowDiskBytes: 10 * GiB,
  dbstat: true,
  snapshot: {
    day: '2026-10-23', takenAt: new Date(Date.now() - 3600_000).toISOString(), dbBytes: 7 * GiB, freelistBytes: 300 * MiB, walBytes: 0, method: 'dbstat',
    tables: [
      { name: 'content_blocks', bytes: 4 * GiB, indexBytes: 500 * MiB, rows: 2_350_000 },
      { name: 'messages', bytes: 1 * GiB, indexBytes: 900 * MiB, rows: 2_180_000 },
      { name: 'mesh_snapshots', bytes: 200 * MiB, indexBytes: 20 * MiB, rows: 427_000 },
    ],
  },
  history: [], growthPerWeekBytes: 0.25 * GiB,
  cold: { blocks: 0, rawBytes: 0, storedBytes: 0 },
  retention: { days: null, choices: [30, 90, 180, 365], minDays: 30 },
  ...over,
});

afterEach(() => { cleanup(); answer = undefined; vi.unstubAllGlobals(); mutate.mockReset(); });

describe('DatabaseHealth', () => {
  it('shows size, freelist, WAL, growth with runway, and tables largest first', () => {
    answer = health();
    const { container } = render(<DatabaseHealth />);
    const field = (f: string) => container.querySelector(`[data-field="${f}"]`)!.textContent!;
    expect(field('db')).toContain('7.0 GB');
    expect(field('freelist')).toContain('300.0 MB');
    expect(field('wal')).toContain('12.0 MB');
    expect(field('growth')).toContain('+256.0 MB per week');
    expect(field('growth')).toContain('about 15 years of disk');
    expect(field('disk')).toContain('200.0 GB of 1000.0 GB');
    expect([...container.querySelectorAll('[data-table]')].map((r) => r.getAttribute('data-table'))).toEqual(['content_blocks', 'messages', 'mesh_snapshots']);
    expect(container.querySelector('[data-table="content_blocks"]')!.textContent).toContain('2,350,000');
    expect(container.textContent).toContain('make vacuum');
    expect(field('cold')).toContain('keeping everything hot');
  });

  it('says what is missing before the first snapshot and before two days of history', () => {
    answer = health({ snapshot: null, growthPerWeekBytes: null });
    const { container } = render(<DatabaseHealth />);
    expect(container.textContent).toContain('measures once a day');
    expect(container.textContent).toContain('needs two days of snapshots');
  });

  it('warns about a low disk', () => {
    answer = health({ disk: { path: '/', freeBytes: 4 * GiB, totalBytes: 100 * GiB }, diskLevel: 'low' });
    expect(render(<DatabaseHealth />).container.querySelector('[data-field="disk"]')!.textContent).toContain('under 10.0 GB');
  });

  it('asks for a dry run before a window can be applied, then applies it', async () => {
    answer = health();
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push(body);
      const json = body.action === 'estimate'
        ? { days: 90, blocks: 1_200_000, rawBytes: 4 * GiB, estimatedColdBytes: 1 * GiB, estimatedSavedBytes: 3 * GiB, ratio: 0.25, sampled: 400 }
        : { days: 90 };
      return { ok: true, status: 200, json: async () => json } as Response;
    }));
    const { container, getByText, queryByText } = render(<DatabaseHealth />);
    fireEvent.change(container.querySelector('#retention-window')!, { target: { value: '90' } });
    expect(container.textContent).toContain('Estimate first');
    expect(queryByText('Apply 90 days')).toBeNull();
    fireEvent.click(getByText('Estimate'));
    await waitFor(() => expect(container.querySelector('[data-field="estimate"]')).not.toBeNull());
    expect(container.querySelector('[data-field="estimate"]')!.textContent).toContain('1,200,000 blocks, 4.0 GB of text');
    expect(container.querySelector('[data-field="estimate"]')!.textContent).toContain('3.0 GB back after a VACUUM');
    fireEvent.click(getByText('Apply 90 days'));
    await waitFor(() => expect(calls).toContainEqual({ action: 'set', days: 90 }));
    expect(calls[0]).toEqual({ action: 'estimate', days: 90 });
  });

  it('offers to bring cold text back', async () => {
    answer = health({ cold: { blocks: 5000, rawBytes: 2 * GiB, storedBytes: 512 * MiB }, retention: { days: null, choices: [30, 90, 180, 365], minDays: 30 } });
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200, json: async () => ({ blocks: 5000, done: calls.length >= 2 }) } as Response;
    }));
    const { container, getByText } = render(<DatabaseHealth />);
    expect(container.querySelector('[data-field="cold"]')!.textContent).toContain('5,000 blocks are cold: 2.0 GB of text in 512.0 MB');
    fireEvent.click(getByText('Bring all cold text back hot'));
    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(calls).toEqual([{ action: 'thaw', days: null }, { action: 'thaw', days: null }]);
  });
});
