import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Booting an agent in an unsandbox container, through POST /api/boot.
 * Moved here from app/api/boot/boot-post.test.ts with the code it covers.
 *
 * Booting an agent, as far as it goes without a machine to boot it on.
 *
 * Every path out of this handler ends in someone waiting at a terminal that
 * either has a session in it or does not, so the interesting cases are the
 * refusals: a path that is not a directory, a host that is not in ssh
 * config, a session id that is not a uuid. Those run before anything is
 * spawned, and each one that falls through instead of returning creates a
 * tmux window running nothing on a machine nobody is watching.
 *
 * tmux, ssh and the unsandbox API are mocked. What is under test is which
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

const { POST } = await import('@/app/api/boot/route');

const post = (body: unknown) =>
  POST({ json: async () => body } as never);

beforeEach(() => {
  // Real time here means a 1.5s wait for bash to come up per boot.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  ran.length = 0; deployments.length = 0; mkdirCalls.length = 0;
  for (const k of Object.keys(settings)) delete settings[k];
  projectRow = undefined;
  settings.integration_unsandbox = 'true';
  statResult = { isDirectory: () => true };
  execImpl = async () => ({ stdout: '', stderr: '' });
});
afterEach(() => vi.useRealTimers());

describe('POST /api/boot — unsandbox, off', () => {
  it('is not there while the integration is off', async () => {
    // Off, a container host is neither booted nor mistaken for an ssh host.
    delete settings.integration_unsandbox;
    const res = await post({ projectPath: '/home/fox/git/demo', host: 'unsandbox' });
    expect(res.status).toBe(404);
    expect((await res.json()).integration).toBe('unsandbox');
  });
});

describe('POST /api/boot — unsandbox refusals', () => {
  it('says which setting is missing rather than failing at unsandbox', async () => {
    const res = await post({ projectPath: '/home/fox/git/demo', host: 'unsandbox' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/No unsandbox API keys/);
  });
});

describe('POST /api/boot — unsandbox', () => {
  /** Every request the handler sent to the unsandbox API, in order. */
  let sent: Array<{ url: string; body: string }>;
  let sessionResponse: { ok: boolean; payload: Record<string, unknown> };

  beforeEach(() => {
    // Fake key material. The handler only signs with it; nothing here reads
    // or reaches the real account.
    settings.unsandbox_public_key = 'pk_test';
    settings.unsandbox_secret_key = 'sk_test';
    sent = [];
    sessionResponse = { ok: true, payload: { session_id: 'sess-abc' } };
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      sent.push({ url, body: init.body });
      const first = sent.length === 1;
      return {
        ok: first ? sessionResponse.ok : true,
        json: async () => (first ? sessionResponse.payload : {}),
      };
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const boot = (over: Record<string, unknown> = {}) =>
    post({ projectPath: '/home/fox/git/demo', host: 'unsandbox', ...over });

  it('creates a session, then runs our setup script inside it', async () => {
    const res = await boot();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true, multiplexer: 'unsandbox', host: 'unsandbox', sessionId: 'sess-abc',
    });
    expect(sent.map(s => s.url)).toEqual([
      expect.stringContaining('/sessions'),
      expect.stringContaining('/sessions/sess-abc/execute'),
    ]);
  });

  it('passes an unsandbox refusal through instead of a bare 500', async () => {
    sessionResponse = { ok: false, payload: { error: 'concurrency limit reached' } };
    const res = await boot();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('concurrency limit reached');
  });

  it('reports a network failure as one, rather than booting nothing quietly', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNREFUSED'); });
    const res = await boot();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/session creation failed/);
  });

  it('clones the repo it was given', async () => {
    await boot({ repoUrl: 'https://git.unturf.com/fox/demo.git' });
    const script = JSON.parse(sent[1].body).command as string;
    expect(script).toContain("git clone 'https://git.unturf.com/fox/demo.git' '/workspace/demo'");
  });

  it('makes an empty workspace when there is no repo to clone', async () => {
    await boot();
    const script = JSON.parse(sent[1].body).command as string;
    expect(script).not.toContain('git clone');
    expect(script).toContain("mkdir -p '/workspace/demo'");
  });

  it('syncs sessions out before the container dies', async () => {
    // A container that exits without this takes its transcripts with it —
    // there is no second chance to collect them.
    const script = (await boot(), JSON.parse(sent[1].body).command as string);
    expect(script).toContain('trap "sync_sessions; exit" SIGTERM SIGINT SIGHUP');
    expect(script).toContain('/root/artifacts');
  });

  it('escapes a prompt containing a quote', async () => {
    // The prompt is interpolated into a single-quoted shell argument, so an
    // apostrophe in ordinary English ends the string and runs the rest.
    await boot({ prompt: "don't drop this" });
    const script = JSON.parse(sent[1].body).command as string;
    expect(script).toContain("claude 'don'\\''t drop this'");
  });

  it('only attaches the agent system prompt when the agent is unattended', async () => {
    // It tells the agent to commit, push and retire itself. An interactive
    // session someone is watching should not be told any of that.
    await boot({ yolo: true });
    expect(JSON.parse(sent[1].body).command as string).toContain('--append-system-prompt');
    sent.length = 0;
    await boot({ yolo: false });
    expect(JSON.parse(sent[1].body).command as string).not.toContain('--append-system-prompt');
  });

  it('records the deployment against the named project', async () => {
    projectRow = { id: 42 };
    await boot({ projectName: '-home-fox-git-demo', todoIds: [3] });
    expect(deployments[0]).toEqual(['unsandbox-sess-abc', 'main', 42, '[3]']);
  });
});
