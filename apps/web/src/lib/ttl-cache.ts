/**
 * The in-memory TTL cache our slow routes share (ticket 4001).
 *
 * Each of them used to write the same three lines — a Map, a timestamp, a
 * comparison — and each had its own chance to get the rest wrong: the tree
 * cache called itself LRU and evicted in insertion order, the git status
 * cache was cleared by a commit while the tree cache went on serving the
 * listing from before it, and two requests arriving together on a cold
 * cache both paid for the work.
 *
 * Least recently used goes first when full, a hit counts as a use, and
 * `getOrCompute` hands concurrent callers on one key a single promise.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; ts: number }>();
  private readonly pending = new Map<string, Promise<V>>();

  constructor(private readonly ttlMs: number, private readonly max = Infinity, private readonly now = () => Date.now()) {}

  /** A value younger than the TTL, or undefined. A hit makes the entry the most recent. */
  get(key: string): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (this.now() - e.ts >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    while (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, ts: this.now() });
  }

  /**
   * The cached value, or the one `compute` produces — computed once however
   * many callers ask while it runs. A rejection is not cached.
   */
  async getOrCompute(key: string, compute: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const running = this.pending.get(key);
    if (running) return running;
    const p = compute().then(
      (v) => { this.pending.delete(key); this.set(key, v); return v; },
      (e) => { this.pending.delete(key); throw e; },
    );
    this.pending.set(key, p);
    return p;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Drop every entry whose key starts with `prefix`. */
  deletePrefix(prefix: string): void {
    for (const k of [...this.entries.keys()]) if (k.startsWith(prefix)) this.entries.delete(k);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
