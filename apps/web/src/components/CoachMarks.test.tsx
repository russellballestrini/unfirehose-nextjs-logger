// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import { CoachMarks, COACH_STORAGE_KEY, COACH_HINTS, resetCoachMarks, coachDismissed } from './CoachMarks';

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
    const hints = [...container.querySelectorAll('[data-coach-hint]')];
    expect(hints.map((h) => h.getAttribute('data-coach-hint'))).toEqual(all);
    expect(hints[0].textContent).toContain('1');
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });

  it('skips a hint whose anchor is not on the page', async () => {
    const { container } = render(<Page anchors={[all[0], all[2]]} />);
    await act(async () => {});
    expect([...container.querySelectorAll('[data-coach-hint]')].map((h) => h.getAttribute('data-coach-hint'))).toEqual([all[0], all[2]]);
  });

  it('stays dismissed under one key, and comes back after a reset', async () => {
    const first = render(<Page anchors={all} />);
    await act(async () => {});
    fireEvent.click(first.container.querySelector('button')!);
    expect(first.container.querySelector('[data-coach-hint]')).toBeNull();
    expect(JSON.parse(localStorage.getItem(COACH_STORAGE_KEY)!)).toEqual({ dashboard: true });
    expect(coachDismissed('dashboard')).toBe(true);
    cleanup();

    const again = render(<Page anchors={all} />);
    await act(async () => {});
    expect(again.container.querySelector('[data-coach-hint]')).toBeNull();
    cleanup();

    resetCoachMarks();
    const back = render(<Page anchors={all} />);
    await act(async () => {});
    expect(back.container.querySelectorAll('[data-coach-hint]')).toHaveLength(3);
  });

  it('survives a broken stored value', async () => {
    localStorage.setItem(COACH_STORAGE_KEY, '{not json');
    const { container } = render(<Page anchors={all} />);
    await act(async () => {});
    expect(container.querySelectorAll('[data-coach-hint]')).toHaveLength(3);
  });

  it('has three hints for every key page', () => {
    for (const hints of Object.values(COACH_HINTS)) expect(hints).toHaveLength(3);
  });
});
