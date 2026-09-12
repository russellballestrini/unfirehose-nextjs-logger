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

const { probeRemote, forgetSpeaker } = await import('./mesh-remote');
// A probe that answered has `uf=1` on the wire; an answer without it is
// what a box with no POSIX shell produces.
// ssh exits 255 when it could not reach a shell at all; a remote that ran
// something and failed exits with that program's code.
const sshFail = (msg: string, code = 255) => Object.assign(new Error(msg), { code });
const answer = (err: Error | null, stdout = 'uf=1\nEND', stderr = '') =>
  execFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: unknown, out: string, se: string) => void) => {
    cb(err, stdout, stderr);
    return { stdin: { end: stdinEnd, on: vi.fn() } };
  });

beforeEach(() => { vi.clearAllMocks(); forgetSpeaker(); });

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

  /** A remote that answers one program and rejects the rest, in its own words. */
  const remote = (speaks: string, wire: string, rejection: string, code = 1) => {
    const calls: string[][] = [];
    execFile.mockImplementation((_c: string, args: string[], _o: unknown, cb: (e: unknown, out: string, se: string) => void) => {
      calls.push(args);
      if (args.includes(speaks)) cb(null, wire, '');
      else cb(sshFail('exit', code), '', rejection);
      return { stdin: { end: stdinEnd, on: vi.fn() } };
    });
    return calls;
  };

  it('walks from sh to PowerShell when the remote is Windows, and remembers', async () => {
    // A Windows sshd hands us cmd.exe, which says so in its own words.
    const calls = remote('powershell', 'uf=1\nuserland=windows-powershell\nEND', "'sh' is not recognized as an internal or external command");
    const node = await probeRemote('winbox');
    expect(calls.map(a => a[a.length - 1] === '-' ? a[a.indexOf('-NoProfile') - 1] : a[a.length - 1])).toEqual(['sh', 'powershell']);
    expect(node.reachable).toBe(true);
    expect(parseRemoteProbe).toHaveBeenCalledWith('winbox', 'uf=1\nuserland=windows-powershell\nEND');
    // The next poll goes straight to what answered.
    calls.length = 0;
    await probeRemote('winbox');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('powershell');
  });

  it('reaches cmd on a Windows with no PowerShell', async () => {
    const calls = remote('cmd', 'uf=1\nuserland=windows-cmd\nEND', "'sh' is not recognized as an internal or external command");
    expect((await probeRemote('xpbox')).reachable).toBe(true);
    expect(calls.map(a => a.at(-1) === '-' ? 'ps' : a.at(-1))).toEqual(['sh', 'ps', 'ps', 'cmd']);
  });

  it('translates a network OS that has no shell at all', async () => {
    const calls = remote('/system', '   uptime: 1w2d3h4m5s\n  cpu-load: 5%\n total-memory: 256.0MiB\n free-memory: 200.0MiB\n  cpu-count: 1\n board-name: hAP ac2\n', 'bad command name sh (line 1 column 1)');
    const node = await probeRemote('router');
    expect(node.reachable).toBe(true);
    const [, wire] = parseRemoteProbe.mock.calls.at(-1) as [string, string];
    expect(wire).toContain('userland=routeros');
    expect(wire).toContain('kind=network');
    expect(calls.some(a => a.includes('/system'))).toBe(true);
  });

  it('stops walking when ssh itself could not connect, and says what it saw', async () => {
    // Exit 255 is ssh, not the box: nothing further would help.
    const calls = remote('nothing', '', 'ssh: connect to host box port 22: Connection refused', 255);
    expect((await probeRemote('box')).error).toBe('Unreachable');
    expect(calls).toHaveLength(1);

    remote('nothing', '', 'sh: not found');
    expect((await probeRemote('plan9')).error).toBe('No shell, PowerShell or cmd answered on remote');
    remote('nothing', '', '% Invalid input detected');
    expect((await probeRemote('ios')).error).toMatch(/network OS/);
  });

  it('reports a node that will not answer as unreachable, not as an exception', async () => {
    // The worker calls this on a timer for every node. A throw would take
    // the whole sampler down for one box being off.
    answer(sshFail('ssh: connect to host cammy port 22: Connection refused'), '');
    const node = await probeRemote('cammy');
    expect(node).toMatchObject({ hostname: 'cammy', reachable: false, error: 'Unreachable' });
  });

  it('names a timeout as one', async () => {
    answer(sshFail('ETIMEDOUT'), '');
    expect((await probeRemote('cammy')).error).toBe('Connection timed out');
  });

  it('reports a probe whose output it cannot parse, with the reason', async () => {
    answer(null, 'uf=1\ngarbage');
    parseRemoteProbe.mockImplementationOnce(() => { throw new Error('bad section'); });
    expect(await probeRemote('cammy')).toMatchObject({ reachable: false, error: 'bad section' });
  });
});
