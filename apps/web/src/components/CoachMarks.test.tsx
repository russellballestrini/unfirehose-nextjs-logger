// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import { CoachMarks, COACH_STORAGE_KEY, COACH_HINTS, resetCoachMarks, coachDismissed, placeHints } from './CoachMarks';

/**
 * Three hints on a first visit, gone once dismissed, back from Settings.
 */

function Page({ anchors }: { anchors: string[] }) {
  return (
    <div>
      {anchors.map((a) => <div key={a} data-coach={a}>{a}</div>)}
      <CoachMarks page="dashboard" />
    </div>
  );
}
const all = COACH_HINTS.dashboard.map((h) => h.anchor);

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('CoachMarks', () => {
  it('shows three numbered hints beside their anchors on a first visit', async () => {
    const { container } = render(<Page anchors={all} />);
    await act(async () => {});
    const hints = [...document.querySelectorAll('[data-coach-hint]')];
    expect(hints.map((h) => h.getAttribute('data-coach-hint'))).toEqual(all);
    expect(hints[0].textContent).toContain('1');
    expect(document.querySelectorAll('[data-coach-page] button')).toHaveLength(1);
  });

  it('skips a hint whose anchor is not on the page', async () => {
    const { container } = render(<Page anchors={[all[0], all[2]]} />);
    await act(async () => {});
    expect([...document.querySelectorAll('[data-coach-hint]')].map((h) => h.getAttribute('data-coach-hint'))).toEqual([all[0], all[2]]);
  });

  it('stays dismissed under one key, and comes back after a reset', async () => {
    const first = render(<Page anchors={all} />);
    await act(async () => {});
    fireEvent.click(document.querySelector('[data-coach-page] button')!);
    expect(document.querySelector('[data-coach-hint]')).toBeNull();
    expect(JSON.parse(localStorage.getItem(COACH_STORAGE_KEY)!)).toEqual({ dashboard: true });
    expect(coachDismissed('dashboard')).toBe(true);
    cleanup();

    const again = render(<Page anchors={all} />);
    await act(async () => {});
    expect(document.querySelector('[data-coach-hint]')).toBeNull();
    cleanup();

    resetCoachMarks();
    const back = render(<Page anchors={all} />);
    await act(async () => {});
    expect(document.querySelectorAll('[data-coach-hint]')).toHaveLength(3);
  });

  it('survives a broken stored value', async () => {
    localStorage.setItem(COACH_STORAGE_KEY, '{not json');
    const { container } = render(<Page anchors={all} />);
    await act(async () => {});
    expect(document.querySelectorAll('[data-coach-hint]')).toHaveLength(3);
  });

  it('has three hints for every key page', () => {
    for (const hints of Object.values(COACH_HINTS)) expect(hints).toHaveLength(3);
  });
});

describe('every hint has an anchor in our pages', () => {
  it('finds data-coach="<anchor>" in apps/web/src for each hint', async () => {
    const { readFileSync, readdirSync, statSync } = await import('fs');
    const path = await import('path');
    const root = path.resolve(__dirname, '..');
    const src: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = path.join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx$/.test(e) && !/\.test\./.test(e)) src.push(readFileSync(p, 'utf8'));
      }
    };
    walk(root);
    const all = src.join('\n');
    const missing = Object.values(COACH_HINTS).flat().map((h) => h.anchor).filter((a) => !all.includes(`data-coach="${a}"`));
    expect(missing).toEqual([]);
  });
});

describe('placeHints', () => {
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;
  const hint = (anchor: string) => ({ anchor, title: anchor, body: '' });

  it('puts a hint below a control and inside the corner of a tall region', () => {
    const rects: Record<string, DOMRect> = { btn: rect(100, 50, 80, 30), grid: rect(0, 200, 900, 600) };
    const [a, b] = placeHints([hint('btn'), hint('grid')], (k) => rects[k] ?? null, 1280);
    expect([a.top, a.left]).toEqual([88, 100]);
    expect([b.top, b.left]).toEqual([208, 900 - 288 - 8]);
  });

  it('keeps a hint inside the viewport and pushes an overlapping one down', () => {
    const rects: Record<string, DOMRect> = { a: rect(1200, 10, 40, 20), b: rect(1190, 20, 40, 20) };
    const [a, b] = placeHints([hint('a'), hint('b')], (k) => rects[k] ?? null, 1280);
    expect(a.left).toBe(1280 - 288 - 8);
    expect(b.top).toBe(a.top + 120);
  });

  it('leaves hints that sit side by side where they are', () => {
    const rects: Record<string, DOMRect> = { a: rect(0, 10, 40, 20), b: rect(400, 10, 40, 20) };
    const [a, b] = placeHints([hint('a'), hint('b')], (k) => rects[k] ?? null, 1280);
    expect(a.top).toBe(b.top);
  });
});
