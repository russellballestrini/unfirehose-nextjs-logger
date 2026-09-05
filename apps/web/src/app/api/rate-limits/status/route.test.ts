import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Which vendor status pages we watch.
 *
 * The list of targets is editable from the dashboard, which means a URL out
 * of a text box reaches this route and, if it is stored, reaches our worker's
 * fetch loop every few minutes. That is the whole reason for the validation
 * here: a feed is only ever an https URL, and anything else is refused before
 * it is written rather than after it has been polled.
 *
 * Overrides are stored as added/removed rather than as a whole list, so the
 * defaults we ship can change without silently reverting somebody's edits.
 */

let setting: string | null = null;
const setSetting = vi.fn((_k: string, v: string) => { setting = v; });
const current = vi.fn(() => [{ id: 'anthropic', status: 'operational' }]);
const history = vi.fn(() => [{ at: '2026-09-05T00:00:00Z', status: 'degraded' }]);
const poll = vi.fn(async () => [{ id: 'anthropic', ok: true }]);

vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => ({}) }));
vi.mock('@unturf/unfirehose/db/ingest', () => ({
  getSetting: () => setting,
  setSetting: (...a: [string, string]) => setSetting(...a),
}));
vi.mock('@unturf/unfirehose/status-pages', () => ({
  STATUS_TARGETS_SETTING: 'status_targets',
  getStatusCurrent: () => current(),
  getStatusHistory: (_db: unknown, id: string, hours: number) => history(id as never, hours as never),
  pollAllStatusTargets: () => poll(),
}));

const { GET, POST } = await import('./route');

const get = (query = '') =>
  GET({ nextUrl: new URL(`http://localhost:3000/api/rate-limits/status${query}`) } as never);
const post = (body: unknown) => POST({ json: async () => body } as never);
const stored = () => JSON.parse(setting ?? '{}');

beforeEach(() => { setting = null; vi.clearAllMocks(); });

describe('GET', () => {
  it('answers with what our worker last saw', async () => {
    expect((await (await get()).json()).current).toEqual([{ id: 'anthropic', status: 'operational' }]);
  });

  it('answers with one target\'s history when asked for it', async () => {
    const body = await (await get('?history=anthropic&hours=6')).json();
    expect(body).toMatchObject({ target: 'anthropic', hours: 6 });
    expect(history).toHaveBeenCalledWith('anthropic', 6);
  });

  it('defaults to a day of history', async () => {
    await get('?history=anthropic');
    expect(history).toHaveBeenCalledWith('anthropic', 24);
  });

  it('falls back to a day rather than asking for zero hours', async () => {
    // `Number('')` is 0 and `Number('soon')` is NaN. Either would return an
    // empty chart that looks like an outage-free day.
    await get('?history=anthropic&hours=soon');
    expect(history).toHaveBeenCalledWith('anthropic', 24);
    await get('?history=anthropic&hours=0');
    expect(history).toHaveBeenLastCalledWith('anthropic', 24);
  });
});

describe('adding a target', () => {
  const target = { id: 'openai', name: 'OpenAI', feed: 'https://status.openai.com/history.rss' };

  it('stores it', async () => {
    const res = await post({ action: 'add', target });
    expect(res.status).toBe(200);
    expect(stored().added).toHaveLength(1);
    expect(stored().added[0]).toMatchObject({ id: 'openai', name: 'OpenAI' });
  });

  it('refuses a feed that is not a URL', async () => {
    // This string ends up in our worker's fetch loop every few minutes.
    const res = await post({ action: 'add', target: { ...target, feed: 'status.openai.com' } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('feed must be a URL');
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('refuses a feed that is not https', async () => {
    for (const feed of ['http://status.openai.com/x', 'file:///etc/passwd', 'ftp://example.com/x']) {
      const res = await post({ action: 'add', target: { ...target, feed } });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('feed must be https');
    }
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('will not add a target with no id or no feed', async () => {
    for (const bad of [{ ...target, id: undefined }, { ...target, feed: undefined }]) {
      expect((await post({ action: 'add', target: bad })).status).toBe(400);
    }
  });

  it('names it after its id when no name was given', async () => {
    await post({ action: 'add', target: { id: 'openai', feed: target.feed } });
    expect(stored().added[0].name).toBe('openai');
  });

  it('treats an unknown kind as a status feed rather than a probe', async () => {
    // A probe fetches an arbitrary URL and checks the code. Defaulting to it
    // would turn a typo into a different kind of request entirely.
    await post({ action: 'add', target: { ...target, kind: 'whatever' } });
    expect(stored().added[0].kind).toBe('statuspage-feed');
    await post({ action: 'add', target: { ...target, kind: 'http-probe' } });
    expect(stored().added[0].kind).toBe('http-probe');
  });

  it('keeps expected status codes as numbers', async () => {
    // They are compared against a response code. Strings never match.
    await post({ action: 'add', target: { ...target, kind: 'http-probe', expect: ['200', 204] } });
    expect(stored().added[0].expect).toEqual([200, 204]);
  });

  it('replaces an existing target rather than storing it twice', async () => {
    await post({ action: 'add', target });
    await post({ action: 'add', target: { ...target, name: 'OpenAI Status' } });
    expect(stored().added).toHaveLength(1);
    expect(stored().added[0].name).toBe('OpenAI Status');
  });

  it('un-removes a target that was previously removed', async () => {
    // Removing a shipped default records it in `removed`. Adding it back has
    // to clear that, or the add is stored and then filtered straight out.
    setting = JSON.stringify({ added: [], removed: ['openai'] });
    await post({ action: 'add', target });
    expect(stored().removed).not.toContain('openai');
    expect(stored().added).toHaveLength(1);
  });
});

describe('removing a target', () => {
  it('records the removal, so a shipped default stays gone', async () => {
    await post({ action: 'remove', id: 'anthropic' });
    expect(stored().removed).toContain('anthropic');
  });

  it('drops one that was added here, rather than only recording it', async () => {
    setting = JSON.stringify({ added: [{ id: 'openai', feed: 'https://x/y' }], removed: [] });
    await post({ action: 'remove', id: 'openai' });
    expect(stored().added).toHaveLength(0);
  });

  it('does not record the same removal twice', async () => {
    setting = JSON.stringify({ added: [], removed: ['anthropic'] });
    await post({ action: 'remove', id: 'anthropic' });
    expect(stored().removed).toEqual(['anthropic']);
  });

  it('will not remove without an id', async () => {
    expect((await post({ action: 'remove' })).status).toBe(400);
  });
});

describe('polling now', () => {
  it('polls every target and answers with what came back', async () => {
    const body = await (await post({ action: 'poll' })).json();
    expect(poll).toHaveBeenCalled();
    expect(body.polls).toEqual([{ id: 'anthropic', ok: true }]);
  });

  it('writes no settings while polling', async () => {
    await post({ action: 'poll' });
    expect(setSetting).not.toHaveBeenCalled();
  });
});

describe('what the route refuses outright', () => {
  it('rejects an action it does not have', async () => {
    const res = await post({ action: 'drop-everything' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Unknown action');
  });

  it('rejects a request with no body at all', async () => {
    expect((await POST({ json: async () => { throw new Error('no body'); } } as never)).status).toBe(400);
  });

  it('starts from empty when the stored overrides will not parse', async () => {
    // A hand-edited settings row, or one written by a past version. Throwing
    // here would make the target list uneditable until somebody fixed the DB.
    setting = 'not json at all';
    const res = await post({ action: 'remove', id: 'anthropic' });
    expect(res.status).toBe(200);
    expect(stored()).toEqual({ added: [], removed: ['anthropic'] });
  });

  it('fills in missing halves of a partial override record', async () => {
    setting = JSON.stringify({ added: [{ id: 'openai', feed: 'https://x/y' }] });
    await post({ action: 'remove', id: 'anthropic' });
    expect(stored().removed).toEqual(['anthropic']);
  });
});
