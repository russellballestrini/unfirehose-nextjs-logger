import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Probing one node over ssh.
 *
 * This lived in the /api/mesh route; the worker fetched it through the web
 * server every fifteen seconds per node. Now it is a function. What these
 * pin is the contract the worker relies on: a node that does not answer is
 * a MeshNode with reachable:false and a reason, never a thrown error, and a
 * node that answers is parsed by the same parser the page uses.
 */

const execFile = vi.fn();
const stdinEnd = vi.fn();
vi.mock('child_process', () => ({ execFile: (...a: unknown[]) => execFile(...a) }));
const parseRemoteProbe = vi.fn((host: string, _stdout?: string) => ({ hostname: host, reachable: true, cpuCores: 4 }));
vi.mock('./mesh-probe', () => ({ parseRemoteProbe: (...a: unknown[]) => parseRemoteProbe(...(a as [string, string])) }));

const { probeRemote } = await import('./mesh-remote');
// A probe that answered has `uf=1` on the wire; an answer without it is
// what a box with no POSIX shell produces.
const answer = (err: Error | null, stdout = 'uf=1\nEND', stderr = '') =>
  execFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: unknown, out: string, se: string) => void) => {
    cb(err, stdout, stderr);
    return { stdin: { end: stdinEnd, on: vi.fn() } };
  });

beforeEach(() => vi.clearAllMocks());

describe('probeRemote', () => {
  it('asks the node over ssh with a connect timeout and no host-key prompt', async () => {
    answer(null);
    await probeRemote('cammy');
    const [cmd, args] = execFile.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('ssh');
    expect(args).toContain('cammy');
    expect(args.join(' ')).toContain('ConnectTimeout=5');
    expect(args.join(' ')).toContain('StrictHostKeyChecking=no');
  });

  it('runs sh on the remote and hands it the script on stdin', async () => {
    // As a command argument the remote login shell would parse the script
    // first; csh on an old BSD chokes on the first redirect.
    answer(null);
    await probeRemote('cammy');
    const [, args] = execFile.mock.calls[0] as [string, string[]];
    expect(args[args.length - 1]).toBe('sh');
    expect(args.join(' ')).not.toContain('uname');
    expect(stdinEnd).toHaveBeenCalledTimes(1);
    expect(stdinEnd.mock.calls[0]![0]).toContain('echo uf=1');
  });

  it('parses an answer with the same parser the page uses', async () => {
    answer(null, 'uf=1\nnproc=4\nEND');
    const node = await probeRemote('cammy');
    expect(parseRemoteProbe).toHaveBeenCalledWith('cammy', 'uf=1\nnproc=4\nEND');
    expect(node).toMatchObject({ hostname: 'cammy', reachable: true });
  });

  it('tries PowerShell when the remote has no sh, and names it when neither answers', async () => {
    // A Windows sshd hands us cmd.exe, which says so in its own words.
    let calls = 0;
    execFile.mockImplementation((_c: string, args: string[], _o: unknown, cb: (e: unknown, out: string, se: string) => void) => {
      calls++;
      if (args.includes('powershell')) cb(null, 'uf=1\nuserland=windows-powershell\nEND', '');
      else cb(new Error('exit 1'), '', "'sh' is not recognized as an internal or external command");
      return { stdin: { end: stdinEnd, on: vi.fn() } };
    });
    const node = await probeRemote('winbox');
    expect(calls).toBe(2);
    expect(node.reachable).toBe(true);
    expect(parseRemoteProbe).toHaveBeenCalledWith('winbox', 'uf=1\nuserland=windows-powershell\nEND');

    execFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: unknown, out: string, se: string) => void) => {
      cb(new Error('exit 1'), '', 'sh: not found');
      return { stdin: { end: stdinEnd, on: vi.fn() } };
    });
    expect((await probeRemote('plan9')).error).toBe('No POSIX shell or PowerShell on remote');
  });

  it('reports a node that will not answer as unreachable, not as an exception', async () => {
    // The worker calls this on a timer for every node. A throw would take
    // the whole sampler down for one box being off.
    answer(new Error('ssh: connect to host cammy port 22: Connection refused'), '');
    const node = await probeRemote('cammy');
    expect(node).toMatchObject({ hostname: 'cammy', reachable: false, error: 'Unreachable' });
  });

  it('names a timeout as one', async () => {
    answer(new Error('ETIMEDOUT'), '');
    expect((await probeRemote('cammy')).error).toBe('Connection timed out');
  });

  it('reports a probe whose output it cannot parse, with the reason', async () => {
    answer(null, 'uf=1\ngarbage');
    parseRemoteProbe.mockImplementationOnce(() => { throw new Error('bad section'); });
    expect(await probeRemote('cammy')).toMatchObject({ reachable: false, error: 'bad section' });
  });
});
