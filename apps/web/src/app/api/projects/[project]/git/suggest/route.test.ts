import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Suggesting a commit message from what is uncommitted.
 *
 * This is the one route that sends our source code to somebody else's
 * server, so what it sends and how much of it are the parts worth pinning:
 * the diff is capped, untracked files are read but only the first few and
 * only their opening lines, and a binary that will not decode becomes a
 * note rather than a wall of bytes.
 *
 * No key material appears in this file. The provider is mocked; what is
 * asserted is which header each provider's shape puts a key into, never a
 * key itself.
 */

const gitExec = vi.fn();
const readFile = vi.fn();
const resolveProvider = vi.fn();
let repoPath: string | null = '/repo';

vi.mock('@unturf/unfirehose/git-exec', () => ({ gitExec: (...a: unknown[]) => gitExec(...a) }));
vi.mock('fs/promises', () => ({ readFile: (...a: unknown[]) => readFile(...a) }));
vi.mock('@unturf/unfirehose/db/repo-path', () => ({ repoPathForProject: () => repoPath }));
vi.mock('@unturf/unfirehose/db/ingest', () => ({ getAllSettings: () => ({}) }));
vi.mock('@/lib/llm-provider', () => ({ resolveProvider: (...a: unknown[]) => resolveProvider(...a) }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { POST } = await import('./route');

const post = (headers: Record<string, string> = {}) =>
  POST(
    { headers: { get: (k: string) => headers[k] ?? null } } as never,
    { params: Promise.resolve({ project: 'demo' }) },
  );

const anthropic = { type: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages', apiKey: 'placeholder', model: 'claude-haiku-4-5-20251001', source: 'settings' };
const openai = { type: 'openai-compatible', endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: 'placeholder', model: 'gpt-4o-mini', source: 'settings' };

const ok = (body: unknown) => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
const answered = (text: string) => ok({ content: [{ text }], choices: [{ message: { content: text } }] });

/** What the model was actually shown. */
const sentPrompt = () => JSON.parse(String(fetchMock.mock.calls[0][1].body)).messages.at(-1).content as string;

beforeEach(() => {
  vi.clearAllMocks();
  repoPath = '/repo';
  resolveProvider.mockResolvedValue(anthropic);
  gitExec.mockImplementation(async (_r: string, args: string[]) =>
    args[0] === 'status' ? ' M src/index.ts\n' : '--- a/src/index.ts\n+++ b/src/index.ts\n+one line\n');
  fetchMock.mockResolvedValue(answered('Fix the thing'));
});

describe('before anything is sent', () => {
  it('will not answer for a project it cannot locate', async () => {
    repoPath = null;
    const res = await post();
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says which setting is missing when no provider is configured', async () => {
    // The error is what the page shows. "Failed" would leave a reader with
    // nowhere to go; naming Settings and Claude Max gives two.
    resolveProvider.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Settings');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not send anything when there is nothing to describe', async () => {
    // A clean tree. Asking a model to name a change that does not exist
    // costs a request and produces fiction.
    gitExec.mockResolvedValue('');
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('No changes to describe');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes a per-request vault key through rather than reading one from disk', async () => {
    await post({ 'x-vault-api-key': 'from-the-browser' });
    expect(resolveProvider).toHaveBeenCalledWith(expect.anything(), 'from-the-browser');
  });

  it('asks for no key at all when the header is absent', async () => {
    await post();
    expect(resolveProvider).toHaveBeenCalledWith(expect.anything(), undefined);
  });
});

describe('what gets sent', () => {
  it('sends the file list and the diff', async () => {
    await post();
    expect(sentPrompt()).toContain('src/index.ts');
    expect(sentPrompt()).toContain('+one line');
  });

  it('caps the diff and says by how much', async () => {
    // Eight thousand characters is the cap. Sending a 400KB refactor costs
    // real money and buys a worse message, and a silent truncation would
    // have the model describe half a change as the whole one.
    gitExec.mockImplementation(async (_r: string, args: string[]) =>
      args[0] === 'status' ? ' M big.ts\n' : 'x'.repeat(20_000));
    await post();
    const prompt = sentPrompt();
    expect(prompt).toContain('diff truncated');
    expect(prompt).toContain('12000 more characters');
  });

  it('still describes a change when git cannot produce a diff', async () => {
    // A repo with no commits yet has no HEAD to diff against. The file list
    // alone is a worse prompt than the diff, and much better than an error.
    gitExec.mockImplementation(async (_r: string, args: string[]) => {
      if (args[0] === 'status') return '?? new.ts\n';
      throw new Error('unknown revision HEAD');
    });
    readFile.mockResolvedValue('export const a = 1;\n');
    const res = await post();
    expect(res.status).toBe(200);
    expect(sentPrompt()).toContain('new.ts');
  });

  it('includes the content of untracked files, which no diff would show', async () => {
    gitExec.mockImplementation(async (_r: string, args: string[]) =>
      args[0] === 'status' ? '?? added.ts\n' : '');
    readFile.mockResolvedValue('export const answer = 42;\n');
    await post();
    expect(sentPrompt()).toContain('+++ b/added.ts');
    expect(sentPrompt()).toContain('+export const answer = 42;');
  });

  it('reads only the first few untracked files', async () => {
    // `git status` after an npm install in an unignored directory lists
    // thousands. Five is the cap.
    gitExec.mockImplementation(async (_r: string, args: string[]) =>
      args[0] === 'status' ? Array.from({ length: 40 }, (_, i) => `?? f${i}.ts`).join('\n') + '\n' : '');
    readFile.mockResolvedValue('x\n');
    await post();
    expect(readFile).toHaveBeenCalledTimes(5);
  });

  it('reads only the opening of each untracked file', async () => {
    gitExec.mockImplementation(async (_r: string, args: string[]) =>
      args[0] === 'status' ? '?? huge.ts\n' : '');
    readFile.mockResolvedValue('y'.repeat(50_000));
    await post();
    expect(sentPrompt().match(/y/g)?.length).toBeLessThanOrEqual(2000);
  });

  it('notes a file it cannot decode instead of sending its bytes', async () => {
    gitExec.mockImplementation(async (_r: string, args: string[]) =>
      args[0] === 'status' ? '?? logo.png\n' : '');
    readFile.mockRejectedValue(new Error('invalid utf-8'));
    await post();
    expect(sentPrompt()).toContain('binary or unreadable');
  });
});

describe('talking to a provider', () => {
  it('puts an Anthropic key in the header Anthropic reads, with its version', async () => {
    await post();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(anthropic.endpoint);
    expect(init.headers).toHaveProperty('x-api-key');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('puts an OpenAI-shaped key in an Authorization header instead', async () => {
    resolveProvider.mockResolvedValue(openai);
    await post();
    expect(fetchMock.mock.calls[0][1].headers).toHaveProperty('Authorization');
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('x-api-key');
  });

  it('sends no Authorization header to a local endpoint that needs none', async () => {
    // Ollama and llama.cpp reject a bearer token they did not ask for.
    resolveProvider.mockResolvedValue({ ...openai, apiKey: '', endpoint: 'http://localhost:11434/v1/chat/completions' });
    await post();
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });

  it('returns the message and says which provider wrote it', async () => {
    const body = await (await post()).json();
    expect(body).toEqual({ message: 'Fix the thing', provider: 'settings' });
  });

  it('carries the provider status code into the error it reports', async () => {
    // A 401 and a 529 need different things done about them, and "Failed to
    // generate" says neither.
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' });
    const res = await post();
    expect(res.status).toBe(500);
    expect((await res.json()).detail).toContain('429');
  });

  it('does not echo a whole error page back', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, text: async () => 'z'.repeat(50_000) });
    const detail = (await (await post()).json()).detail;
    expect(detail.length).toBeLessThan(1000);
  });

  it('reports an empty answer rather than committing with a blank message', async () => {
    fetchMock.mockResolvedValue(ok({ content: [{ text: '   ' }], choices: [{ message: { content: '' } }] }));
    const res = await post();
    expect(res.status).toBe(500);
    expect((await res.json()).detail).toContain('empty');
  });

  it('reports a provider that answers in a shape it does not recognise', async () => {
    fetchMock.mockResolvedValue(ok({ unexpected: true }));
    expect((await post()).status).toBe(500);
  });

  it('reports a provider it could not reach', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await post();
    expect(res.status).toBe(500);
    expect((await res.json()).detail).toContain('ECONNREFUSED');
  });
});
