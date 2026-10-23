import { describe, it, expect } from 'vitest';
import { demoDirVerdict, DEMO_MARKER } from './demo';

const HOME = '/home/someone';

describe('demoDirVerdict', () => {
  it('seeds a directory that does not exist yet, or is empty', () => {
    expect(demoDirVerdict(`${HOME}/.unfirehose-demo`, HOME, null)).toEqual({ ok: true, dir: `${HOME}/.unfirehose-demo` });
    expect(demoDirVerdict('/tmp/demo-x', HOME, [])).toEqual({ ok: true, dir: '/tmp/demo-x' });
  });

  it('re-seeds one a previous run marked as ours', () => {
    expect(demoDirVerdict('/tmp/demo-x', HOME, [DEMO_MARKER, 'unfirehose.db', 'home']).ok).toBe(true);
  });

  it('refuses our real data directory, however it is spelled', () => {
    for (const t of [`${HOME}/.unfirehose`, `${HOME}/.unfirehose/`, `${HOME}/x/../.unfirehose`, `${HOME}/.unfirehose/sub`]) {
      expect(demoDirVerdict(t, HOME, null).ok).toBe(false);
    }
  });

  it('refuses a directory holding the home directory', () => {
    expect(demoDirVerdict(HOME, HOME, [DEMO_MARKER]).ok).toBe(false);
    expect(demoDirVerdict('/', HOME, [DEMO_MARKER]).ok).toBe(false);
  });

  it('refuses a directory with something in it that we did not put there', () => {
    const v = demoDirVerdict('/tmp/demo-x', HOME, ['notes.txt']);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/marker/);
  });
});
