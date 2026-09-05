import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Installing a harness on a node, then proving it is actually there.
 *
 * The shape of this route is the point: install is allowed to fail and
 * verify is not. An install that errors because the thing is already
 * installed is indistinguishable from one that errors because it broke, so
 * the only trustworthy answer is running the version command afterwards.
 * A route that reported the install's exit code would call a working node
 * broken and a broken node fine.
 *
 * ssh and scp are mocked. Credential paths are named but never read, and
 * nothing here contains key material.
 */

let ran: Array<{ cmd: string; args: string[] }>;
let impl: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
vi.mock('@unturf/unfirehose/git-exec', () => ({
  execAsync: (cmd: string, args: string[]) => { ran.push({ cmd, args }); return impl(cmd, args); },
}));

/** Which of the files under ~/.claude exist, by basename. */
let present: Set<string>;
vi.mock('fs/promises', () => ({
  stat: async (p: string) => {
    const name = String(p).split('/').pop()!;
    if (!present.has(name)) throw new Error('ENOENT');
    return { isFile: () => true };
  },
}));

const { POST } = await import('./route');

const post = (body: unknown) => POST({ json: async () => body } as never);
const steps = async (res: Response) => (await res.json()).steps as Array<{ step: string; ok: boolean }>;

beforeEach(() => {
  ran = [];
  present = new Set(['.credentials.json', '.claude.json', 'settings.json']);
  impl = async () => ({ stdout: '1.2.3\n', stderr: '' });
});

describe('POST /api/harness/verify', () => {
  it('refuses without a way to check the result', async () => {
    // An install with nothing to verify it against reports success for a
    // node that has nothing on it.
    const res = await post({ host: 'cammy', install: 'npm i -g thing' });
    expect(res.status).toBe(400);
    expect(ran).toEqual([]);
  });

  it('verifies locally with a login shell, so PATH is what a user would have', async () => {
    // A harness installed into ~/.local/bin is invisible to a non-login
    // shell, and reporting it missing sends someone to reinstall it.
    const body = await (await post({ verify: 'claude --version' })).json();
    expect(body).toMatchObject({ success: true, version: '1.2.3' });
    expect(ran[0].cmd).toBe('bash');
    expect(ran[0].args[0]).toBe('-lc');
    expect(ran[0].args[1]).toContain('nvm.sh');
  });

  it('goes over ssh for any host but localhost', async () => {
    await post({ host: 'cammy', verify: 'claude --version' });
    expect(ran[0].cmd).toBe('ssh');
    expect(ran[0].args).toContain('cammy');
  });

  it('carries on to verify after a failed install', async () => {
    // The most common install failure is "already installed".
    impl = async (_cmd, args) => {
      if (args.join(' ').includes('npm i -g')) throw Object.assign(new Error('EEXIST'), { stderr: 'already exists' });
      return { stdout: '1.2.3\n', stderr: '' };
    };
    const body = await (await post({ verify: 'claude --version', install: 'npm i -g thing' })).json();
    expect(body.success).toBe(true);
    expect(body.steps).toEqual([
      { step: 'install', ok: false, output: 'already exists' },
      { step: 'verify', ok: true, output: '1.2.3' },
    ]);
  });

  it('calls it a failure only when the verify command fails', async () => {
    impl = async () => { throw Object.assign(new Error('exit 127'), { stderr: 'command not found' }); };
    const body = await (await post({ verify: 'claude --version' })).json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/harness not found/);
  });

  it('syncs credentials to a remote node before verifying claude', async () => {
    // claude on a fresh node with no token opens an interactive login
    // nobody is sitting at, and the verify then hangs until it times out.
    const res = await post({ id: 'claude-code', host: 'cammy', verify: 'claude --version' });
    expect((await steps(res as never)).map(s => s.step)).toEqual(['credentials', 'verify']);
    expect(ran.some(r => r.cmd === 'scp')).toBe(true);
  });

  it('creates the remote directory with a tight umask before copying into it', async () => {
    // Every unsandbox container hands its user root. A credentials file
    // that lands world-readable trips the tripwire on these nodes.
    await post({ id: 'claude-code', host: 'cammy', verify: 'claude --version' });
    expect(ran[0].args.at(-1)).toBe('umask 077 && mkdir -p ~/.claude');
    expect(ran.at(-2)!.args.at(-1)).toMatch(/chmod 700 ~\/\.claude && chmod 600/);
  });

  it('says plainly when there is no local credential to copy', async () => {
    present = new Set();
    const res = await post({ id: 'claude-code', host: 'cammy', verify: 'claude --version' });
    expect((await steps(res as never))[0]).toEqual({
      step: 'credentials', ok: false, output: 'no local credentials found',
    });
    expect(ran.some(r => r.cmd === 'scp')).toBe(false);
  });

  it('copies only the optional files that exist', async () => {
    present = new Set(['.credentials.json']);
    await post({ id: 'claude-code', host: 'cammy', verify: 'claude --version' });
    const copied = ran.filter(r => r.cmd === 'scp').map(r => r.args.at(-1));
    expect(copied).toEqual(['cammy:~/.claude/.credentials.json']);
  });

  it('does not sync credentials for a harness that has none', async () => {
    await post({ id: 'aider', host: 'cammy', verify: 'aider --version' });
    expect(ran.some(r => r.cmd === 'scp')).toBe(false);
  });

  it('does not sync credentials to this machine, which already has them', async () => {
    await post({ id: 'claude-code', verify: 'claude --version' });
    expect(ran.some(r => r.cmd === 'scp')).toBe(false);
  });

  it('escapes a quote in a command bound for a remote shell', async () => {
    await post({ host: 'cammy', verify: "sh -c 'claude --version'" });
    expect(ran[0].args.at(-1)).toContain("'\\''claude --version'\\''");
  });
});
