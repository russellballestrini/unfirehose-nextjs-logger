import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Opening a tmux session, here or on a mesh node over ssh. The command is
 * never run: execFile is replaced, and the tests read the argv it was
 * handed, which is the whole of what this route decides.
 */
type Cb = (err: Error | null, out?: { stdout: string; stderr: string }) => void;
const calls: { file: string; args: string[]; opts: { timeout?: number } }[] = [];
let fail: Error | null = null;

vi.mock('child_process', () => ({
  execFile: (file: string, args: string[], opts: { timeout?: number }, cb: Cb) => {
    calls.push({ file, args, opts });
    if (fail) cb(fail);
    else cb(null, { stdout: '', stderr: '' });
  },
}));

const { POST } = await import('./route');

const open = (body: unknown) => POST(new NextRequest('http://localhost/api/tmux/new', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => { calls.length = 0; fail = null; });

describe('POST /api/tmux/new', () => {
  it('starts a detached local session with our default shell', async () => {
    const res = await open({ name: 'work' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: 'work', host: 'localhost' });
    expect(calls).toEqual([{
      file: 'tmux',
      args: ['new-session', '-d', '-s', 'work', '-x', '220', '-y', '50', 'zsh || bash'],
      opts: { timeout: 5000 },
    }]);
  });

  it('passes a safe working directory and a given command through', async () => {
    await open({ name: 'w2', host: 'localhost', cwd: '/home/fox/git/x', command: '  htop ' });
    expect(calls[0].args).toEqual(['new-session', '-d', '-s', 'w2', '-c', '/home/fox/git/x', '-x', '220', '-y', '50', 'htop']);
  });

  it('drops a working directory that is relative or carries shell metacharacters', async () => {
    for (const cwd of ['relative/dir', '/tmp; rm -rf ~', '/tmp/$(id)', '/tmp/`id`', '/a|b']) {
      calls.length = 0;
      await open({ name: 'w', cwd });
      expect(calls[0].args).not.toContain('-c');
    }
  });

  it('opens a remote session over ssh, quoting the command for the far shell', async () => {
    const res = await open({ name: 'remote', host: 'node-1.lan', cwd: '/srv', command: "echo 'hi'" });
    expect(await res.json()).toEqual({ ok: true, name: 'remote', host: 'node-1.lan' });
    expect(calls[0].file).toBe('ssh');
    expect(calls[0].opts.timeout).toBe(15000);
    expect(calls[0].args.slice(0, 5)).toEqual(['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10', 'node-1.lan']);
    expect(calls[0].args[5]).toBe(`tmux new-session -d -s remote -c '/srv' -x 220 -y 50 'echo '\\''hi'\\'''`);
  });

  it('refuses a missing name, a name tmux or a shell would misread, and a bad host', async () => {
    const missing = await open({});
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBe('name required');
    const badName = await open({ name: 'a b;c' });
    expect(badName.status).toBe(500);
    expect((await badName.json()).error).toMatch(/Invalid session name/);
    const badHost = await open({ name: 'ok', host: 'evil;host' });
    expect((await badHost.json()).error).toMatch(/Invalid hostname/);
    expect(calls).toEqual([]);
  });

  it('answers 409 when tmux already has a session by that name, 500 for anything else', async () => {
    fail = new Error('duplicate session: work');
    const dup = await open({ name: 'work' });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toBe('session name already exists');
    fail = new Error('no server running');
    const other = await open({ name: 'work' });
    expect(other.status).toBe(500);
    expect((await other.json()).error).toMatch(/no server running/);
  });
});
