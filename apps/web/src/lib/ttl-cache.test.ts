import { describe, it, expect } from 'vitest';
import { TtlCache } from './ttl-cache';
import { invalidateProject, treeCache, gitStatusCache, treeKey } from './project-caches';

const clock = () => {
  let t = 0;
  return { now: () => t, tick: (ms: number) => { t += ms; } };
};

describe('TtlCache', () => {
  it('serves a value until its TTL, then forgets it', () => {
    const c = clock();
    const cache = new TtlCache<number>(1000, Infinity, c.now);
    cache.set('a', 1);
    c.tick(999);
    expect(cache.get('a')).toBe(1);
    c.tick(1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('evicts the least recently used, and a hit counts as a use', () => {
    const cache = new TtlCache<number>(1000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('computes once for callers who arrive together, and does not cache a failure', async () => {
    const cache = new TtlCache<number>(1000);
    let runs = 0;
    let release!: (v: number) => void;
    const slow = () => { runs++; return new Promise<number>((r) => { release = r; }); };
    const both = Promise.all([cache.getOrCompute('k', slow), cache.getOrCompute('k', slow)]);
    release(7);
    expect(await both).toEqual([7, 7]);
    expect(runs).toBe(1);
    expect(await cache.getOrCompute('k', slow)).toBe(7);

    await expect(cache.getOrCompute('bad', () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(await cache.getOrCompute('bad', async () => 1)).toBe(1);
  });

  it('drops keys by prefix', () => {
    const cache = new TtlCache<number>(1000);
    cache.set('p:a', 1); cache.set('p:b', 2); cache.set('pq:a', 3);
    cache.deletePrefix('p:');
    expect(cache.size).toBe(1);
    expect(cache.get('pq:a')).toBe(3);
  });
});

describe('invalidateProject', () => {
  it('forgets a project\'s status and every listing, and leaves its neighbours', () => {
    gitStatusCache.set('alpha', { clean: true });
    treeCache.set(treeKey('alpha', '', 'HEAD'), { entries: [] });
    treeCache.set(treeKey('alpha', 'src', 'HEAD'), { entries: [] });
    treeCache.set(treeKey('alphabet', '', 'HEAD'), { entries: [] });
    invalidateProject('alpha');
    expect(gitStatusCache.get('alpha')).toBeUndefined();
    expect(treeCache.get(treeKey('alpha', '', 'HEAD'))).toBeUndefined();
    expect(treeCache.get(treeKey('alpha', 'src', 'HEAD'))).toBeUndefined();
    expect(treeCache.get(treeKey('alphabet', '', 'HEAD'))).toBeDefined();
  });
});
