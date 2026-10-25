import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Booting an agent, as far as it goes without a machine to boot it on.
 *
 * Every path out of this handler ends in someone waiting at a terminal that
 * either has a session in it or does not, so the interesting cases are the
 * refusals: a path that is not a directory, a host that is not in ssh
 * config, a session id that is not a uuid. Those run before anything is
 * spawned, and each one that falls through instead of returning creates a
 * tmux window running nothing on a machine nobody is watching.
 *
 * tmux and ssh are mocked. What is under test is which
 * command we decided to run and what we told our caller, not whether tmux
 * works.
 */

const settings: Record<string, string | null> = {};
const deployments: unknown[][] = [];
let projectRow: { id: number } | undefined;

vi.mock('@unturf/unfirehose/db/ingest', () => ({
  getSetting: (k: string) => settings[k] ?? null,
  setSetting: vi.fn(),
}));
vi.mock('@unturf/unfirehose/db/schema', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: () => (sql.includes('FROM projects') ? projectRow : undefined),
      all: () => [],
      run: (...args: unknown[]) => { if (sql.includes('agent_deployments')) deployments.push(args); return {}; },
    }),
  }),
}));

const nodes = ['cammy', 'neoblanka'];
vi.mock('@unturf/unfirehose/mesh', () => ({ discoverNodes: () => nodes }));

/** Every command the handler decided to run, in order. */
const ran: Array<{ cmd: string; args: string[] }> = [];
let execImpl: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }> =
  async () => ({ stdout: '', stderr: '' });
vi.mock('@unturf/unfirehose/git-exec', () => ({
  execAsync: (cmd: string, args: string[]) => { ran.push({ cmd, args }); return execImpl(cmd, args); },
}));

let statResult: { isDirectory: () => boolean } | Error = { isDirectory: () => true };
const mkdirCalls: string[] = [];
vi.mock('fs/promises', () => ({
  stat: async () => { if (statResult instanceof Error) throw statResult; return statResult; },
  mkdir: async (p: string) => { mkdirCalls.push(p); },
  writeFile: async () => {},
  readFile: async () => { throw new Error('no credentials in a test'); },
  unlink: async () => {},
}));

const { POST } = await import('./route');

const post = (body: unknown) =>
  POST({ json: async () => body } as never);

beforeEach(() => {
  // Real time here means a 1.5s wait for bash to come up per boot.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  ran.length = 0; deployments.length = 0; mkdirCalls.length = 0;
  for (const k of Object.keys(settings)) delete settings[k];
  projectRow = undefined;
  statResult = { isDirectory: () => true };
  execImpl = async () => ({ stdout: '', stderr: '' });
});
afterEach(() => vi.useRealTimers());

describe('POST /api/boot — refusals', () => {
  it('will not boot without a project path', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Missing projectPath/);
  });

  it('rejects a session id that is not a uuid', async () => {
    // --resume takes it verbatim. A shell fragment here reaches a command
    // line, so this is the boundary, not a formatting preference.
    const res = await post({ projectPath: '/home/fox/git/demo', sessionId: 'x; rm -rf /' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid session ID/);
  });

  it('refuses a local path that is not a directory', async () => {
    statResult = { isDirectory: () => false };
    const res = await post({ projectPath: '/etc/hosts' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid project path/);
  });

  it('refuses a host that is not in ssh config', async () => {
    // Otherwise the ssh failure surfaces as a generic 500 and reads as the
    // node being down rather than never having been configured.
    const res = await post({ projectPath: '/home/fox/git/demo', host: 'typo-node' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Unknown host: typo-node/);
    expect(body.detail).toMatch(/cammy, neoblanka/);
  });

  it('reports the stderr of the command that failed, not just that it failed', async () => {
    execImpl = async () => { throw Object.assign(new Error('exit 1'), { stderr: 'no server running' }); };
    const res = await post({ projectPath: '/home/fox/git/demo' });
    expect(res.status).toBe(500);
    expect((await res.json()).detail).toBe('no server running');
  });

});

describe('POST /api/boot — local tmux', () => {
  it('creates a session when the project has none', async () => {
    // has-session exits non-zero when there is nothing to attach to, which
    // is the only way to ask.
    execImpl = async (cmd, args) =>
      args[0] === 'has-session' ? Promise.reject(new Error('no session')) : { stdout: '', stderr: '' };
    const res = await post({ projectPath: '/home/fox/git/demo', yolo: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true, tmuxSession: 'demo', multiplexer: 'tmux', host: 'localhost',
    });
    expect(ran.map(r => r.args[0])).toEqual(['has-session', 'new-session', 'send-keys']);
    expect(ran.at(-1)!.args.join(' ')).toContain('claude --dangerously-skip-permissions');
  });

  it('adds a window to a session that is already up', async () => {
    // One session per project, one window per agent — a second new-session
    // would fail and take a working session's boot down with it.
    const res = await post({ projectPath: '/home/fox/git/demo' });
    expect(res.status).toBe(200);
    expect(ran.map(r => r.args[0])).toEqual(['has-session', 'new-window', 'send-keys']);
  });

  it('names the window after the prompt so a session list reads as work', async () => {
    const res = await post({ projectPath: '/home/fox/git/demo', prompt: 'fix the CRAP report!' });
    expect((await res.json()).tmuxWindow).toBe('fix-the-CRAP-report');
  });

  it('falls back to a timestamp when there is no prompt to name it after', async () => {
    const res = await post({ projectPath: '/home/fox/git/demo' });
    expect((await res.json()).tmuxWindow).toMatch(/^\d{6}$/);
  });

  it('unsets CLAUDECODE and passes the parent session down', async () => {
    // A nested harness that inherits CLAUDECODE reports its turns against
    // the parent, which merges two agents into one session in our logs.
    await post({ projectPath: '/home/fox/git/demo', parentSessionUuid: 'abcd-1234' });
    const sent = ran.at(-1)!.args.join(' ');
    expect(sent).toContain('unset CLAUDECODE');
    expect(sent).toContain('export UNFIREHOSE_PARENT_SESSION=abcd-1234');
  });

  it('expands ~ before anything looks at the path', async () => {
    // tmux -c takes it literally and would create a directory called "~".
    await post({ projectPath: '~/git/demo' });
    const cd = ran.find(r => r.args.includes('-c'))!;
    expect(cd.args[cd.args.indexOf('-c') + 1]).toMatch(/^\/.*\/git\/demo$/);
  });

  it('creates the directory when booting into a repo that is not cloned yet', async () => {
    statResult = new Error('ENOENT');
    const res = await post({ projectPath: '/home/fox/git/fresh', bootstrap: true });
    expect(res.status).toBe(200);
    expect(mkdirCalls).toEqual(['/home/fox/git/fresh']);
  });

  it('records the deployment so a finished agent can be culled', async () => {
    // UNEOF cull looks agents up by (session, window). An unrecorded boot is
    // a window that stays open forever.
    projectRow = { id: 7 };
    await post({ projectPath: '/home/fox/git/demo', todoIds: [11, 12] });
    expect(deployments).toHaveLength(1);
    expect(deployments[0]).toEqual(['demo', expect.any(String), 7, '[11,12]']);
  });

  it('boots anyway when the project is not one we have ingested', async () => {
    // Registration is bookkeeping. Losing it must not cost someone a boot.
    projectRow = undefined;
    const res = await post({ projectPath: '/home/fox/git/demo' });
    expect(res.status).toBe(200);
    expect(deployments).toHaveLength(0);
  });
});

describe('POST /api/boot — remote', () => {
  it('boots over ssh on a known node', async () => {
    const res = await post({ projectPath: '/home/fox/git/demo', host: 'cammy' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ host: 'cammy' });
    expect(ran.every(r => r.cmd === 'ssh' || r.cmd === 'scp')).toBe(true);
  });

  it('does not stat a remote path against our own filesystem', async () => {
    // The directory lives on the other machine. Checking it here would
    // refuse every remote boot on a path we do not happen to share.
    statResult = new Error('ENOENT');
    const res = await post({ projectPath: '/srv/work/demo', host: 'cammy' });
    expect(res.status).toBe(200);
  });
});
