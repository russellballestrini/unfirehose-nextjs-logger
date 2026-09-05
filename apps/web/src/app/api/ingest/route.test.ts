import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

/**
 * On-demand ingest, out of process.
 *
 * ingestAll() is synchronous all the way down, and this route used to call
 * it in the web server: a pass measured at over two minutes froze every
 * other request for its duration. The route now spawns the pass and answers
 * at once. What these pin is that nothing heavy runs here, that the spawn
 * is the worker's own runtime and cannot outlive the request's interest in
 * it, and that two clicks do not start two passes.
 */

const ingestAll = vi.fn();
vi.mock('@unturf/unfirehose/db/ingest', () => ({
  ingestAll: (...a: unknown[]) => ingestAll(...a),
  getDbStats: () => ({ projects: 5, sessions: 10, messages: 100 }),
}));

let children: Array<EventEmitter & { pid: number; unref: () => void; args: unknown[] }> = [];
const spawn = vi.fn((...args: unknown[]) => {
  const child = Object.assign(new EventEmitter(), { pid: 4242 + children.length, unref: vi.fn(), args });
  children.push(child);
  return child;
});
vi.mock('child_process', () => ({ spawn: (...a: unknown[]) => spawn(...a) }));

beforeEach(() => { children = []; vi.clearAllMocks(); vi.resetModules(); });

describe('GET', () => {
  it('reports what the database holds', async () => {
    const { GET } = await import('./route');
    expect(await (await GET()).json()).toMatchObject({ projects: 5, messages: 100 });
  });
});

describe('POST', () => {
  it('starts a pass in another process and answers at once', async () => {
    const { POST } = await import('./route');
    const res = await POST();
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ started: true, pid: 4242 });
    // Nothing heavy in this process.
    expect(ingestAll).not.toHaveBeenCalled();
  });

  it('runs the pass on the worker\'s own runtime, detached from the request', async () => {
    const { POST } = await import('./route');
    await POST();
    const [cmd, argv, opts] = children[0].args as [string, string[], { cwd: string; detached: boolean; stdio: string }];
    expect(cmd).toBe('npx');
    expect(argv).toEqual(['tsx', 'src/ingest-once.ts']);
    expect(opts.cwd.endsWith('/worker')).toBe(true);
    // Detached and unref'd, or the pass dies with the request and the
    // server waits on it — both of which are the old behaviour.
    expect(opts.detached).toBe(true);
    expect(children[0].unref).toHaveBeenCalled();
  });

  it('will not start a second pass while one is running', async () => {
    // Two passes contend over the same database; the second gains nothing.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const { POST } = await import('./route');
    await POST();
    const second = await POST();
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ started: false, alreadyRunning: true, pid: 4242 });
    expect(spawn).toHaveBeenCalledTimes(1);
    kill.mockRestore();
  });

  it('starts again once the previous pass has exited', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const { POST } = await import('./route');
    await POST();
    children[0].emit('exit', 0);
    const again = await POST();
    expect(await again.json()).toMatchObject({ started: true, pid: 4243 });
    kill.mockRestore();
  });

  it('starts again if the previous pass died without saying so', async () => {
    // A killed process never emits exit here. process.kill(pid, 0) is how
    // we find out it is gone, so a crash cannot wedge the button forever.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH'); });
    const { POST } = await import('./route');
    await POST();
    const again = await POST();
    expect(await again.json()).toMatchObject({ started: true });
    kill.mockRestore();
  });

  it('reports a spawn that failed rather than pretending it started', async () => {
    spawn.mockImplementationOnce(() => { throw new Error('ENOENT: npx'); });
    const { POST } = await import('./route');
    const res = await POST();
    expect(res.status).toBe(500);
    expect((await res.json()).detail).toContain('ENOENT');
  });
});
