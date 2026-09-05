import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * What a harness can actually run on a given target.
 *
 * Dispatching work should be a choice of model, not whatever default a
 * harness happens to hold. Enumerating costs a process spawn or an SSH round
 * trip, so most of this route is about answering usefully when that fails —
 * a node that is down must not be re-probed on every keystroke in the
 * dispatch box, and a harness we cannot enumerate must still say whether it
 * takes a model at all, so the page can offer a text field instead of
 * nothing.
 */

const execFile = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...a: unknown[]) => execFile(...a),
}));

vi.mock('@unturf/unfirehose/harness-models', () => ({
  CLAUDE_MODELS: [{ id: 'claude-opus-5', label: 'Opus 5' }],
  supportsModelSelection: (h: string) => h === 'aider',
  HARNESS_MODEL_ADAPTERS: {
    uncloseai: { command: (bin: string) => [bin, 'models', '--json'], parse: (out: string) => JSON.parse(out) },
    ollama: { command: (bin: string) => [bin, 'list'], parse: (out: string) => out.trim().split('\n').map((id) => ({ id })) },
  },
}));

const { GET } = await import('./route');

const req = (query: string) =>
  ({ nextUrl: new URL(`http://localhost:3000/api/harness/models${query}`) }) as never;

/** execFile's callback is (err, stdout, stderr). */
const answers = (fn: (cmd: string, args: string[]) => string | Error) => {
  execFile.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: (e: unknown, o: string) => void) => {
    const r = fn(cmd, args);
    if (r instanceof Error) cb(r, '');
    else cb(null, r);
  });
};

beforeEach(() => { vi.clearAllMocks(); });

/** A fresh harness name each time, since the route caches per harness@host. */
let n = 0;
const fresh = () => `ollama`;
const host = () => `node-${n++}.example`;

describe('what the route refuses', () => {
  it('will not guess which harness you meant', async () => {
    const res = await GET(req(''));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('harness required');
  });
});

describe('harnesses we do not enumerate', () => {
  it('answers claude from a static list, without spawning anything', async () => {
    // Anthropic's model names are not discoverable from the CLI, and
    // spawning claude to ask would cost a login round trip.
    const body = await (await GET(req('?harness=claude'))).json();
    expect(body).toMatchObject({ selectable: true, source: 'static' });
    expect(body.models).toEqual([{ id: 'claude-opus-5', label: 'Opus 5' }]);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('says a harness takes a model even when it cannot list them', async () => {
    // This is what lets the page show a free-text box. Reporting nothing
    // would make an aider dispatch impossible to configure.
    const body = await (await GET(req('?harness=aider'))).json();
    expect(body).toMatchObject({ models: [], selectable: true, source: 'none' });
  });

  it('says a harness takes no model at all', async () => {
    const body = await (await GET(req('?harness=htop'))).json();
    expect(body).toMatchObject({ models: [], selectable: false, source: 'none' });
  });

  it('names localhost explicitly when no host was given', async () => {
    // The answer is cached per harness@host; a blank host in the response
    // would leave a caller unable to tell which target it describes.
    expect((await (await GET(req('?harness=claude'))).json()).host).toBe('localhost');
  });
});

describe('listing locally', () => {
  it('runs the harness and returns what it parsed', async () => {
    answers(() => 'llama3\nqwen2.5-coder\n');
    const body = await (await GET(req(`?harness=${fresh()}&refresh=1`))).json();
    expect(body).toMatchObject({ source: 'local', selectable: true });
    expect(body.models).toEqual([{ id: 'llama3' }, { id: 'qwen2.5-coder' }]);
  });

  it('tries both names uncloseai-cli installs itself under', async () => {
    // PATH differs between fox's box and a freshly bootstrapped node; only
    // one of the two binaries exists on either.
    answers((cmd) => (cmd === 'unclose' ? new Error('ENOENT') : '[{"id":"hermes"}]'));
    const body = await (await GET(req('?harness=uncloseai&refresh=1'))).json();
    expect(body.models).toEqual([{ id: 'hermes' }]);
    expect(execFile.mock.calls.map((c) => c[0])).toEqual(['unclose', 'uncloseai-cli']);
  });

  it('reports the last failure when neither binary is there', async () => {
    answers(() => new Error('command not found: uncloseai-cli'));
    const body = await (await GET(req('?harness=uncloseai&refresh=1'))).json();
    expect(body).toMatchObject({ source: 'error', selectable: true, models: [] });
    expect(body.error).toContain('command not found');
  });
});

describe('listing over ssh', () => {
  it('asks the named host, not this one', async () => {
    answers(() => 'llama3\n');
    const h = host();
    const body = await (await GET(req(`?harness=ollama&host=${h}&refresh=1`))).json();
    expect(body).toMatchObject({ host: h, source: 'ssh' });
    expect(execFile.mock.calls[0][0]).toBe('ssh');
    expect(execFile.mock.calls[0][1]).toContain(h);
  });

  it('gives ssh a deadline and refuses to prompt for anything', async () => {
    // A route that waits on a password prompt holds a Next worker open until
    // the request is abandoned.
    answers(() => 'llama3\n');
    await GET(req(`?harness=ollama&host=${host()}&refresh=1`));
    const args = execFile.mock.calls[0][1] as string[];
    expect(args).toContain('BatchMode=yes');
    expect(args.join(' ')).toContain('ConnectTimeout=5');
  });

  it('puts the login PATH back, since ssh does not', async () => {
    // A harness installed under ~/.local/bin is not on PATH for a
    // non-interactive ssh command, so the probe would report "not installed"
    // for every harness on every node.
    answers(() => 'llama3\n');
    await GET(req(`?harness=ollama&host=${host()}&refresh=1`));
    const script = (execFile.mock.calls[0][1] as string[]).at(-1) as string;
    expect(script).toContain('$HOME/.local/bin');
  });

  it('tries both uncloseai binaries in one round trip, not two', async () => {
    // Two SSH connections to ask one question is most of a second.
    answers(() => '[{"id":"hermes"}]');
    await GET(req(`?harness=uncloseai&host=${host()}&refresh=1`));
    expect(execFile).toHaveBeenCalledTimes(1);
    const script = (execFile.mock.calls[0][1] as string[]).at(-1) as string;
    expect(script).toContain('unclose models --json || uncloseai-cli models --json');
  });

  it('reports an unreachable node instead of failing the request', async () => {
    answers(() => new Error('ssh: connect to host timed out'));
    const res = await GET(req(`?harness=ollama&host=${host()}&refresh=1`));
    expect(res.status).toBe(200);
    expect((await res.json())).toMatchObject({ source: 'error', models: [] });
  });
});

describe('caching', () => {
  it('answers a repeat question from cache rather than spawning again', async () => {
    answers(() => 'llama3\n');
    const h = host();
    await GET(req(`?harness=ollama&host=${h}&refresh=1`));
    expect(execFile).toHaveBeenCalledTimes(1);
    const body = await (await GET(req(`?harness=ollama&host=${h}`))).json();
    expect(body).toMatchObject({ source: 'cache' });
    expect(body.models).toEqual([{ id: 'llama3' }]);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('caches a failure too, so a node that is down is not re-probed per keystroke', async () => {
    answers(() => new Error('ssh: connect timed out'));
    const h = host();
    await GET(req(`?harness=ollama&host=${h}&refresh=1`));
    const body = await (await GET(req(`?harness=ollama&host=${h}`))).json();
    expect(body.source).toBe('cache');
    expect(body.error).toContain('connect timed out');
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('goes back to the node when asked to refresh', async () => {
    answers(() => 'llama3\n');
    const h = host();
    await GET(req(`?harness=ollama&host=${h}&refresh=1`));
    await GET(req(`?harness=ollama&host=${h}&refresh=1`));
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it('keeps two hosts apart', async () => {
    // One cache key per harness, and a node's answer would follow the user
    // to whichever node they looked at next.
    answers((cmd, args) => (args.includes('a.example') ? 'llama3\n' : 'qwen\n'));
    await GET(req('?harness=ollama&host=a.example&refresh=1'));
    const b = await (await GET(req('?harness=ollama&host=b.example&refresh=1'))).json();
    expect(b.models).toEqual([{ id: 'qwen' }]);
  });
});
