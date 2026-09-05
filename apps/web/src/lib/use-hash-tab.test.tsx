// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHashTab, readHash } from './use-hash-tab';

/**
 * Tabs kept in our URL hash.
 *
 * Four pages hand-rolled this and three had drifted. Two pushed a history
 * entry per tab click, so leaving settings after browsing five tabs took
 * five presses of Back.
 */

const TABS = ['Overview', 'Harnesses', 'Processes'] as const;
type Tab = typeof TABS[number];

beforeEach(() => { window.location.hash = ''; });
afterEach(() => { vi.restoreAllMocks(); });

describe('readHash', () => {
  it('reads a tab our page actually has', () => {
    window.location.hash = '#Harnesses';
    expect(readHash(TABS)).toBe('Harnesses');
  });

  it('ignores an anchor that is not one of our tabs', () => {
    // Deep links from elsewhere, and our own scroll anchors, land here.
    window.location.hash = '#some-heading';
    expect(readHash(TABS)).toBeNull();
  });

  it('decodes a hash the browser escaped', () => {
    window.location.hash = '#' + encodeURIComponent('Overview');
    expect(readHash(TABS)).toBe('Overview');
  });

  it('is null with no hash at all', () => {
    expect(readHash(TABS)).toBeNull();
  });
});

describe('useHashTab', () => {
  it('opens on a deep-linked tab from the very first render', () => {
    // Read in the useState initialiser, not an effect: an effect would
    // paint the default first and visibly flash the wrong tab.
    window.location.hash = '#Processes';
    const { result } = renderHook(() => useHashTab<Tab>(TABS, 'Overview'));
    expect(result.current[0]).toBe('Processes');
  });

  it('falls back when the hash names nothing we have', () => {
    window.location.hash = '#nonsense';
    const { result } = renderHook(() => useHashTab<Tab>(TABS, 'Overview'));
    expect(result.current[0]).toBe('Overview');
  });

  it('writes the chosen tab into the hash, so it can be linked', () => {
    const { result } = renderHook(() => useHashTab<Tab>(TABS, 'Overview'));
    act(() => result.current[1]('Harnesses'));
    expect(result.current[0]).toBe('Harnesses');
    expect(window.location.hash).toBe('#Harnesses');
  });

  it('replaces the history entry rather than pushing one', () => {
    // This is the behaviour three of the four copies got wrong. A tab is a
    // view of one page, not somewhere you navigated to; pushing means Back
    // walks the tabs instead of leaving.
    const replace = vi.spyOn(window.history, 'replaceState');
    const push = vi.spyOn(window.history, 'pushState');
    const { result } = renderHook(() => useHashTab<Tab>(TABS, 'Overview'));
    act(() => result.current[1]('Harnesses'));
    act(() => result.current[1]('Processes'));
    expect(replace).toHaveBeenCalledTimes(2);
    expect(push).not.toHaveBeenCalled();
  });

  it('follows the hash when the browser moves it', () => {
    // Back out of a page and into this one and the hash changes without a
    // remount. Without the listener the tab bar and the URL disagree.
    const { result } = renderHook(() => useHashTab<Tab>(TABS, 'Overview'));
    act(() => {
      window.location.hash = '#Processes';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(result.current[0]).toBe('Processes');
  });

  it('returns to the fallback when the hash is cleared', () => {
    window.location.hash = '#Processes';
    const { result } = renderHook(() => useHashTab<Tab>(TABS, 'Overview'));
    act(() => {
      window.location.hash = '';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(result.current[0]).toBe('Overview');
  });

  it('stops listening once unmounted', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useHashTab<Tab>(TABS, 'Overview'));
    unmount();
    expect(remove).toHaveBeenCalledWith('hashchange', expect.any(Function));
  });
});
