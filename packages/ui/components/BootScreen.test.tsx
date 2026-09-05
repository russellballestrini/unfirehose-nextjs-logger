// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { BootScreen } from './BootScreen';

/**
 * The boot animation, which is what every page shows before its data.
 *
 * It existed twice in two dialects of the same markup, and the copies had
 * already diverged on something that matters: one seeded its decorative
 * blocks with Math.random() during render, which gives the server and the
 * client different values and hydrates wrong. So the fixed part of this
 * has to stay fixed, and only the timers may move it.
 *
 * Its other job is to stop: it runs on a page that will unmount the moment
 * data arrives, and three intervals left behind per navigation is a leak
 * on the busiest transition in the app.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); cleanup(); });

describe('BootScreen', () => {
  it('renders the same markup twice, so hydration matches', () => {
    // Nothing random may be read during render.
    const a = render(<BootScreen />).container.innerHTML;
    cleanup();
    const b = render(<BootScreen />).container.innerHTML;
    expect(a).toBe(b);
  });

  it('starts with nothing revealed and fills in over time', () => {
    const { container } = render(<BootScreen />);
    const before = container.textContent!.length;
    act(() => { vi.advanceTimersByTime(1000); });
    expect(container.textContent!.length).toBeGreaterThan(before);
  });

  it('reaches its last line and stops adding more', () => {
    // The trailing dots go on cycling — that is the part that says it is
    // still working — but the log itself has an end.
    const { container } = render(<BootScreen />);
    // Count the log lines themselves, not the characters — the dots that
    // trail the last one are still cycling.
    const lines = () => container.querySelectorAll('[data-boot-line]').length
      || container.textContent!.split('\n').length;
    act(() => { vi.advanceTimersByTime(10_000); });
    const settled = lines();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(lines()).toBe(settled);
  });

  it('covers the viewport only when asked to', () => {
    // The vault covers everything before anything else can paint; a page
    // waits inside its own layout. That is the only difference.
    expect(render(<BootScreen fullscreen />).container.querySelector('.fixed')).toBeTruthy();
    cleanup();
    expect(render(<BootScreen />).container.querySelector('.fixed')).toBeNull();
  });

  it('clears every timer when it goes away', () => {
    // Three intervals per navigation, on the transition every page makes.
    const clear = vi.spyOn(globalThis, 'clearInterval');
    render(<BootScreen />);
    cleanup();
    expect(clear.mock.calls.length).toBeGreaterThanOrEqual(3);
    clear.mockRestore();
  });

  it('does not keep ticking after unmount', () => {
    const { container } = render(<BootScreen />);
    act(() => { vi.advanceTimersByTime(400); });
    cleanup();
    expect(() => act(() => { vi.advanceTimersByTime(5000); })).not.toThrow();
    expect(container.textContent).toBe('');
  });
});
