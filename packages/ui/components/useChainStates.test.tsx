import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const calls: string[] = [];
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key) calls.push(key);
    return { data: key ? { chains: { a: { state: 'verified', anchor: 'intact', breaks: 0, firstBreak: null } } } : undefined };
  },
}));

const { useChainStates } = await import('./useChainStates');

describe('useChainStates', () => {
  it('asks once for a sorted, deduplicated id set and returns the map', () => {
    const { result } = renderHook(() => useChainStates(['b', 'a', '', 'a']));
    expect(calls.at(-1)).toBe('/api/sessions/chains?ids=a%2Cb');
    expect(result.current.a.state).toBe('verified');
  });

  it('asks nothing for no ids', () => {
    calls.length = 0;
    const { result } = renderHook(() => useChainStates([]));
    expect(calls).toEqual([]);
    expect(result.current).toEqual({});
  });
});
