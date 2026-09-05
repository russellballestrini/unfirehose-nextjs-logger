import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Watching for new transcript lines.
 *
 * This is what makes the dashboard live: a harness appends a line and an
 * ingest follows two seconds later. Everything about it is a guard against
 * doing that too often — a burst of writes must collapse into one ingest,
 * and an ingest already running must not have another started on top of
 * it, because two passes over the same files race on the same rows.
 *
 * fs.watch and ingestAll are both mocked; what is under test is when we
 * decide to ingest.
 */

/** Every watch() call, and a way to fire the callback it registered. */
let watches: Array<{ path: string; opts: unknown; cb: (ev: string, file: string) => void; closed: boolean }>;
let watchThrowsFor: string | null;

vi.mock('fs', () => ({
  watch: (p: string, opts: unknown, cb: (ev: string, file: string) => void) => {
    if (watchThrowsFor && String(p).includes(watchThrowsFor)) throw new Error('ENOSPC');
    const w = { path: String(p), opts, cb, closed: false, close() { w.closed = true; } };
    watches.push(w);
    return w;
  },
}));

let dirs: Set<string>;
vi.mock('fs/promises', () => ({
  stat: async (p: string) => {
    if (!dirs.has(String(p))) throw new Error('ENOENT');
    return { isDirectory: () => true };
  },
}));

const ingest = vi.fn(async () => {});
let harnesses: Array<{ name: string; root: string }>;
vi.mock('./ingest', () => ({
  ingestAll: () => ingest(),
  get nativeHarnesses() { return harnesses; },
}));
vi.mock('../claude-paths', () => ({ claudePaths: { projects: '/home/fox/.claude/projects' } }));
vi.mock('../fetch-paths', () => ({ fetchPaths: { root: '/home/fox/.fetch/sessions' } }));

const { startWatcher, stopWatcher } = await import('./watcher');

const fire = (file: string, path?: string) => {
  for (const w of watches) if (!path || w.path === path) w.cb('change', file);
};

beforeEach(() => {
  vi.useFakeTimers();
  watches = []; watchThrowsFor = null; ingest.mockClear();
  harnesses = [{ name: 'testharness', root: '/home/fox/.testharness/unfirehose' }];
  dirs = new Set(['/home/fox/.testharness/unfirehose']);
});
afterEach(() => { stopWatcher(); vi.useRealTimers(); });

describe('startWatcher', () => {
  it('watches every place a transcript can appear', async () => {
    await startWatcher();
    expect(watches.map(w => w.path).sort()).toEqual([
      '/home/fox/.claude/projects',
      '/home/fox/.fetch/sessions',
      '/home/fox/.testharness/unfirehose',
    ]);
  });

  it('watches recursively, since sessions live in per-project directories', async () => {
    await startWatcher();
    expect(watches.every(w => (w.opts as { recursive?: boolean }).recursive)).toBe(true);
  });

  it('skips a harness directory that is not there', async () => {
    // Harnesses are discovered from a list, not from disk. Most people
    // have two of the sixteen.
    dirs = new Set();
    await startWatcher();
    expect(watches.map(w => w.path)).not.toContain('/home/fox/.testharness/unfirehose');
  });

  it('keeps watching the rest when one watch cannot start', async () => {
    // inotify limits are per-user and are reached on a busy machine.
    watchThrowsFor = '.claude';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await startWatcher();
    expect(watches.map(w => w.path)).toContain('/home/fox/.fetch/sessions');
  });

  it('does nothing on a second call', async () => {
    await startWatcher();
    const n = watches.length;
    await startWatcher();
    expect(watches).toHaveLength(n);
  });
});

describe('when a file changes', () => {
  it('ingests after the writing settles', async () => {
    await startWatcher();
    fire('project/session.jsonl');
    expect(ingest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('collapses a burst of writes into one ingest', async () => {
    // A harness appends every few hundred milliseconds during a turn. One
    // ingest per line would be one full pass per line.
    await startWatcher();
    for (let i = 0; i < 20; i++) {
      fire('project/session.jsonl');
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('ignores a file that is not a transcript', async () => {
    await startWatcher();
    fire('project/notes.txt', '/home/fox/.claude/projects');
    await vi.advanceTimersByTimeAsync(2000);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('watches the sessions index too, which carries the project path', async () => {
    await startWatcher();
    fire('project/sessions-index.json', '/home/fox/.claude/projects');
    await vi.advanceTimersByTimeAsync(2000);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('does not start a second ingest on top of one already running', async () => {
    // Two passes over the same files race on the same rows.
    let release: () => void = () => {};
    ingest.mockImplementationOnce(() => new Promise<void>(r => { release = r; }));
    await startWatcher();
    fire('a.jsonl');
    await vi.advanceTimersByTimeAsync(2000);
    fire('b.jsonl');
    await vi.advanceTimersByTimeAsync(2000);
    expect(ingest).toHaveBeenCalledTimes(1);
    release();
  });

  it('ingests again once the previous pass is done', async () => {
    // The guard resets in a finally, because a flag stuck true silently
    // drops every later file event.
    await startWatcher();
    fire('a.jsonl');
    await vi.advanceTimersByTimeAsync(2000);
    fire('b.jsonl');
    await vi.advanceTimersByTimeAsync(2000);
    expect(ingest).toHaveBeenCalledTimes(2);
  });

  it('carries on watching after an ingest throws', async () => {
    // An ingest failure is one bad file, not a reason to stop watching.
    ingest.mockRejectedValueOnce(new Error('bad jsonl'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await startWatcher();
    fire('a.jsonl');
    await vi.advanceTimersByTimeAsync(2000);
    fire('b.jsonl');
    await vi.advanceTimersByTimeAsync(2000);
    expect(ingest).toHaveBeenCalledTimes(2);
  });
});

describe('stopWatcher', () => {
  it('closes every watch and cancels a pending ingest', async () => {
    await startWatcher();
    fire('a.jsonl');
    stopWatcher();
    await vi.advanceTimersByTimeAsync(5000);
    expect(watches.every(w => w.closed)).toBe(true);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('can be called when nothing is watching', () => {
    expect(() => stopWatcher()).not.toThrow();
  });

  it('lets watching start again afterwards', async () => {
    await startWatcher();
    stopWatcher();
    watches = [];
    await startWatcher();
    expect(watches.length).toBeGreaterThan(0);
  });
});
