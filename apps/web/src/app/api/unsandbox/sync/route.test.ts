import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Pulling a container's transcripts back before it dies.
 *
 * An unsandbox container is ephemeral. Whatever claude wrote inside it is
 * gone when it stops, so this route runs a script in the container, takes
 * the tarball it produces, and unpacks it into our own projects directory.
 *
 * The failures worth pinning are the quiet ones: a service that answers but
 * whose script failed, a job that never completes, and a sync that found
 * nothing — which must still be recorded, because the marker it writes is
 * what makes the next sync a delta rather than a full transfer.
 *
 * The unsandbox API and tar are mocked. Key material here is fabricated.
 */

const settings: Record<string, string> = {};
const written: Array<[string, string]> = [];
vi.mock('@unturf/unfirehose/db/ingest', () => ({
  getSetting: (k: string) => settings[k] ?? null,
  setSetting: (k: string, v: string) => { settings[k] = v; written.push([k, v]); },
}));

const extracted: string[] = [];
vi.mock('child_process', () => ({ execSync: (cmd: string) => { extracted.push(cmd); return ''; } }));
vi.mock('fs/promises', () => ({
  mkdir: async () => {}, writeFile: async () => {}, unlink: async () => {},
}));

const { POST, GET } = await import('./route');

/** Every request the route made, and canned answers per path. */
let calls: string[];
let answers: Record<string, unknown>;
const stubFetch = () => vi.stubGlobal('fetch', async (url: string) => {
  const path = url.replace('https://api.unsandbox.com', '');
  calls.push(path);
  const key = Object.keys(answers).find(k => path.startsWith(k));
  const body = key ? answers[key] : {};
  return { ok: (body as { __status?: number }).__status !== 500, status: 200, json: async () => body };
});

const post = (body: unknown) => POST({ json: async () => body } as never);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  calls = []; written.length = 0; extracted.length = 0;
  for (const k of Object.keys(settings)) delete settings[k];
  settings.unsandbox_public_key = 'pk_test';
  settings.unsandbox_secret_key = 'sk_test';
  answers = {
    '/services/': { job_id: 'job-1' },
    '/jobs/': { status: 'completed', exit_code: 0, stdout: '{"delta":true,"files":3}\n', artifacts: [] },
    '/services': { services: [
      { id: 'svc-1', name: 'agent-one', status: 'running', created_at: '2026-09-01T00:00:00Z' },
      { id: 'svc-2', name: 'agent-two', status: 'stopped', created_at: '2026-09-01T00:00:00Z' },
    ] },
  };
  stubFetch();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('POST /api/unsandbox/sync', () => {
  it('says which setting is missing rather than failing at the API', async () => {
    delete settings.unsandbox_secret_key;
    expect((await post({ serviceId: 'svc-1' })).status).toBe(400);
  });

  it('refuses when asked to sync nothing in particular', async () => {
    expect((await post({})).status).toBe(400);
  });

  it('syncs the one service it was given', async () => {
    const body = await (await post({ serviceId: 'svc-1' })).json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ serviceId: 'svc-1', ok: true, delta: true, filesOnContainer: 3 });
  });

  it('syncs only the running services when asked for all of them', async () => {
    // A stopped container has nothing to execute in; asking anyway is a
    // guaranteed error per service and a slow one.
    const body = await (await post({ all: true })).json();
    expect(body.results.map((r: { serviceId: string }) => r.serviceId)).toEqual(['svc-1']);
  });

  it('says so when there is nothing running to sync', async () => {
    answers['/services'] = { services: [] };
    const res = await post({ all: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no running services/);
  });

  it('records the sync even when the container had nothing new', async () => {
    // The marker is what makes the next sync a delta. Skipping it on an
    // empty result turns every subsequent sync into a full transfer.
    const body = await (await post({ serviceId: 'svc-1' })).json();
    expect(body.results[0].note).toBe('No new data since last sync');
    expect(written[0][0]).toBe('unsandbox_last_sync_svc-1');
  });

  it('unpacks an artifact into our own projects directory', async () => {
    answers['/jobs/'] = {
      status: 'completed', exit_code: 0, stdout: '{"delta":false,"files":9}\n',
      artifacts: [{ filename: 'claude-sessions.tar.gz', data: Buffer.from('a tarball').toString('base64') }],
    };
    const body = await (await post({ serviceId: 'svc-1' })).json();
    expect(body.results[0]).toMatchObject({ ok: true, artifactBytes: 9, filesOnContainer: 9 });
    expect(extracted[0]).toContain('tar xzf');
    expect(extracted[0]).toContain('--strip-components=1');
  });

  it('reports a script that ran and failed, with its stderr', async () => {
    // exit 0 is the only proof the transcripts were collected. A non-zero
    // exit with an empty artifact list looks exactly like an idle
    // container.
    answers['/jobs/'] = { status: 'completed', exit_code: 2, stderr: 'tar: not found' };
    const body = await (await post({ serviceId: 'svc-1' })).json();
    expect(body.results[0]).toMatchObject({ ok: false, error: 'Script failed', stderr: 'tar: not found' });
    expect(written).toEqual([]);
  });

  it('reports a refusal to start the job rather than waiting on it', async () => {
    answers['/services/'] = { __status: 500, error: 'service not running' };
    const body = await (await post({ serviceId: 'svc-1' })).json();
    expect(body.results[0]).toMatchObject({ ok: false, error: 'service not running' });
    expect(calls.some(c => c.startsWith('/jobs/'))).toBe(false);
  });

  it('gives up on a job that never finishes rather than polling forever', async () => {
    // Thirty polls two seconds apart. Driving the clock rather than
    // waiting on it, since the point is the bound, not the minute.
    vi.useFakeTimers();
    answers['/jobs/'] = { status: 'running' };
    const pending = post({ serviceId: 'svc-1' });
    await vi.advanceTimersByTimeAsync(70_000);
    const body = await (await pending).json();
    expect(body.results[0].error).toMatch(/timed out/);
    expect(calls.filter(c => c.startsWith('/jobs/'))).toHaveLength(30);
  });

  it('carries on to the next service when one fails', async () => {
    answers['/services'] = { services: [
      { id: 'svc-1', status: 'running' }, { id: 'svc-2', status: 'running' },
    ] };
    let n = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      const path = url.replace('https://api.unsandbox.com', '');
      if (path === '/services') return { ok: true, status: 200, json: async () => answers['/services'] };
      if (path.endsWith('/execute')) return path.includes('svc-1') && n++ === 0
        ? { ok: false, status: 500, json: async () => ({ error: 'gone' }) }
        : { ok: true, status: 200, json: async () => ({ job_id: 'j' }) };
      return { ok: true, status: 200, json: async () => answers['/jobs/'] };
    });
    const body = await (await post({ all: true })).json();
    expect(body.results.map((r: { ok: boolean }) => r.ok)).toEqual([false, true]);
  });
});

describe('GET /api/unsandbox/sync', () => {
  it('lists every service with when it was last synced', async () => {
    settings['unsandbox_last_sync_svc-1'] = '2026-09-04T12:00:00Z';
    const body = await (await GET()).json();
    expect(body.services).toEqual([
      { id: 'svc-1', name: 'agent-one', status: 'running', created_at: '2026-09-01T00:00:00Z', lastSync: '2026-09-04T12:00:00Z' },
      { id: 'svc-2', name: 'agent-two', status: 'stopped', created_at: '2026-09-01T00:00:00Z', lastSync: null },
    ]);
  });

  it('reports an unreachable API rather than an empty list', async () => {
    // An empty list reads as "no containers", which is the one answer that
    // makes someone stop looking for their transcripts.
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNREFUSED'); });
    expect((await GET()).status).toBe(500);
  });
});
