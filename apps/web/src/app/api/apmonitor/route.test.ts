import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Reading APMonitor across our mesh, and receiving its webhooks.
 *
 * Both halves are about not losing information when part of the mesh is
 * unreachable: a node that will not answer must not take the other nodes'
 * numbers down with it, and a webhook must be acknowledged even when our
 * database is not there to record it — APMonitor retries what it cannot
 * deliver, and a retry loop against a dashboard is worse than a lost event.
 */

const local = vi.fn();
const remote = vi.fn();
const nodes = vi.fn(() => ['localhost', 'cammy', 'neoblanka']);
vi.mock('@unturf/unfirehose/apmonitor-adapter', () => ({
  readAPMonitorState: (...a: unknown[]) => local(...a),
  readRemoteAPMonitorState: (...a: unknown[]) => remote(...a),
}));
vi.mock('@unturf/unfirehose/mesh', () => ({ discoverNodes: () => nodes() }));

const prepare = vi.fn();
const exec = vi.fn();
let dbThrows = false;
vi.mock('@unturf/unfirehose/db/schema', () => ({
  getDb: () => {
    if (dbThrows) throw new Error('no database');
    return { prepare, exec };
  },
}));

const { GET, POST } = await import('./route');

const req = (query = '') =>
  ({ nextUrl: new URL(`http://localhost:3000/api/apmonitor${query}`) }) as never;

const resource = (isUp: boolean, name: string) => ({ name, isUp });

beforeEach(() => {
  vi.clearAllMocks();
  dbThrows = false;
  prepare.mockReturnValue({ get: () => undefined, run: vi.fn() });
  local.mockReturnValue({ resources: [resource(true, 'a'), resource(false, 'b')] });
  remote.mockReturnValue({ resources: [resource(true, 'c')] });
});

describe('GET one host', () => {
  it('reads localhost directly rather than over ssh', () => {
    GET(req('?host=localhost'));
    expect(local).toHaveBeenCalled();
    expect(remote).not.toHaveBeenCalled();
  });

  it('reads any other host over ssh', () => {
    GET(req('?host=cammy'));
    expect(remote).toHaveBeenCalledWith('cammy', undefined);
    expect(local).not.toHaveBeenCalled();
  });

  it('passes an explicit statefile path through', async () => {
    await GET(req('?host=cammy&path=/srv/apmonitor/state.json'));
    expect(remote).toHaveBeenCalledWith('cammy', '/srv/apmonitor/state.json');
  });

  it('prefers the query path over the configured one', async () => {
    // A caller asking for a specific file means it; settings are the default.
    prepare.mockReturnValue({ get: () => ({ value: '/etc/configured.json' }) });
    await GET(req('?host=cammy&path=/tmp/override.json'));
    expect(remote).toHaveBeenCalledWith('cammy', '/tmp/override.json');
  });

  it('falls back to the path configured in settings', async () => {
    prepare.mockReturnValue({ get: () => ({ value: '/etc/configured.json' }) });
    await GET(req('?host=cammy'));
    expect(remote).toHaveBeenCalledWith('cammy', '/etc/configured.json');
  });

  it('still answers when there is no settings table to read', async () => {
    // A fresh install, or a database mid-migration.
    dbThrows = true;
    const res = await GET(req('?host=localhost'));
    expect(res.status).toBe(200);
    expect(remote).not.toHaveBeenCalled();
  });
});

describe('GET the whole mesh', () => {
  it('reports every node it discovered, tagged by host', async () => {
    const body = await (await GET(req())).json();
    expect(body.nodes.map((n: { host: string }) => n.host)).toEqual(['localhost', 'cammy', 'neoblanka']);
  });

  it('counts resources up and down across all of them', async () => {
    // localhost: one up, one down. Two remotes: one up each.
    const body = await (await GET(req())).json();
    expect(body.summary).toMatchObject({ totalResources: 4, up: 3, down: 1, nodesPolled: 3 });
  });

  it('separates nodes polled from nodes that answered', async () => {
    // This is the number that says the mesh is degraded rather than idle. A
    // node that will not answer is not the same as a node with nothing to
    // report, and one figure cannot say both.
    remote.mockReturnValueOnce({ error: 'ssh: connect timed out' })
          .mockReturnValueOnce({ resources: [resource(true, 'c')] });
    const body = await (await GET(req())).json();
    expect(body.summary).toMatchObject({ nodesPolled: 3, nodesWithData: 2 });
  });

  it('keeps a failed node in the list, carrying its error', async () => {
    // Dropping it would make a broken node indistinguishable from one that
    // was never in the mesh.
    remote.mockReturnValueOnce({ error: 'ssh: connect timed out' })
          .mockReturnValueOnce({ resources: [] });
    const body = await (await GET(req())).json();
    expect(body.nodes.find((n: { host: string }) => n.host === 'cammy').error)
      .toContain('connect timed out');
  });

  it('counts a node with no resources at all as nothing, not as an error', async () => {
    remote.mockReturnValue({ resources: [] });
    const body = await (await GET(req())).json();
    expect(body.summary).toMatchObject({ totalResources: 2, nodesWithData: 3 });
  });

  it('survives a node that reports no resources key', async () => {
    remote.mockReturnValue({});
    const body = await (await GET(req())).json();
    expect(body.summary.totalResources).toBe(2);
  });

  it('reports an empty mesh rather than failing', async () => {
    nodes.mockReturnValueOnce([]);
    const body = await (await GET(req())).json();
    expect(body.summary).toMatchObject({ totalResources: 0, nodesPolled: 0, nodesWithData: 0 });
  });
});

describe('POST, the webhook receiver', () => {
  const hook = (body: string) => ({ text: async () => body }) as never;

  it('acknowledges an outage notification and says when it arrived', async () => {
    const res = await POST(hook('{"event":"outage","resource":"proxy"}'));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect((await (await POST(hook('{}'))).json()).received_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('stores the payload exactly as sent', async () => {
    // The shape is APMonitor's, not ours, and it changes between versions.
    // Storing the text means an event we cannot parse today is still there
    // to read tomorrow.
    const run = vi.fn();
    prepare.mockReturnValue({ run, get: () => undefined });
    await POST(hook('{"event":"recovery"}'));
    expect(run).toHaveBeenCalledWith('{"event":"recovery"}', expect.any(String));
  });

  it('creates its table on first use rather than needing a migration', async () => {
    await POST(hook('{}'));
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS apmonitor_events'));
  });

  it('trims the log so a chatty monitor cannot grow it without bound', async () => {
    await POST(hook('{}'));
    const statements = prepare.mock.calls.map((c) => String(c[0]));
    expect(statements.some((s) => s.includes('DELETE') && s.includes('LIMIT 1000'))).toBe(true);
  });

  it('still returns 200 when there is no database to write to', async () => {
    // APMonitor retries what it cannot deliver. A retry loop pointed at a
    // dashboard costs more than the event that was lost.
    dbThrows = true;
    const res = await POST(hook('{"event":"outage"}'));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('reports a request whose body cannot be read as a 500', async () => {
    const res = await POST({ text: async () => { throw new Error('stream closed'); } } as never);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('stream closed');
  });
});
