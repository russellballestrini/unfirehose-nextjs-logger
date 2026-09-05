import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Which model writes our commit message, and on whose credential.
 *
 * The order is the decision, and getting it wrong is expensive in a way
 * nothing reports: falling through a configured endpoint to a metered API
 * key spends money the user did not intend, and falling through both to a
 * free mesh model quietly downgrades the output. Each rule is checked in
 * isolation, with every later one still available, so a test passing by
 * accident because nothing else could answer is not possible.
 *
 * All credential material here is fabricated. Nothing reads a real one.
 */

let credentials: string | Error = new Error('ENOENT');
vi.mock('fs/promises', () => ({
  readFile: async () => { if (credentials instanceof Error) throw credentials; return credentials; },
}));

const { resolveProvider, getClaudeMaxToken } = await import('./llm-provider');

const FUTURE = Date.now() + 3_600_000;
const oauth = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ claudeAiOauth: { accessToken: 'fake-token-for-tests', expiresAt: FUTURE, ...over } });

/** Both mesh models answer, so every earlier rule has something to skip. */
const meshUp = () => vi.stubGlobal('fetch', async (url: string) => ({
  ok: true,
  json: async () => ({ data: [{ id: url.includes('qwen') ? 'qwen3-coder' : 'hermes-3-8b' }] }),
}));

beforeEach(() => {
  credentials = new Error('ENOENT');
  meshUp();
});
afterEach(() => vi.unstubAllGlobals());

describe('getClaudeMaxToken', () => {
  it('reads a live token', async () => {
    credentials = oauth();
    expect(await getClaudeMaxToken()).toMatchObject({ accessToken: 'fake-token-for-tests' });
  });

  it('refuses an expired one rather than sending it', async () => {
    // An expired token is a 401 on every request, which reads as the model
    // being down instead of as needing a login.
    credentials = oauth({ expiresAt: Date.now() - 1000 });
    expect(await getClaudeMaxToken()).toBeNull();
  });

  it('is null when there is no credentials file at all', async () => {
    expect(await getClaudeMaxToken()).toBeNull();
  });

  it('is null rather than throwing on a truncated file', async () => {
    // A half-written credentials file must not take out the whole route.
    credentials = '{"claudeAiOauth": {';
    expect(await getClaudeMaxToken()).toBeNull();
  });
});

describe('resolveProvider', () => {
  it('prefers the endpoint the user configured over anything found on disk', async () => {
    credentials = oauth();
    const p = await resolveProvider({ llm_commit_endpoint: 'https://llm.example/v1/chat' }, 'fake-vault-key');
    expect(p).toMatchObject({ source: 'vault', endpoint: 'https://llm.example/v1/chat', apiKey: 'fake-vault-key' });
  });

  it('refuses a remote configured endpoint with no key, rather than calling it unauthenticated', async () => {
    expect(await resolveProvider({ llm_commit_endpoint: 'https://llm.example/v1/chat' })).toBeNull();
  });

  it('allows a local endpoint with no key, because local models take none', async () => {
    const p = await resolveProvider({ llm_commit_endpoint: 'http://localhost:11434/v1/chat' });
    expect(p).toMatchObject({ source: 'vault', apiKey: '' });
  });

  it('takes the vault key over one stored in settings', async () => {
    // The settings copy is the legacy plaintext one. Preferring it would
    // undo the point of the vault.
    const p = await resolveProvider(
      { llm_commit_endpoint: 'https://llm.example/v1/chat', llm_commit_api_key: 'plaintext-key' },
      'fake-vault-key',
    );
    expect(p?.apiKey).toBe('fake-vault-key');
  });

  it('uses a Claude Max token already on this machine before a metered key', async () => {
    // Max is already paid for. Reaching past it to an OpenAI key bills a
    // second time for the same sentence.
    credentials = oauth();
    const p = await resolveProvider({ llm_commit_api_key: 'sk-fake-openai-key' });
    expect(p).toMatchObject({ source: 'claude-max', type: 'anthropic' });
  });

  it('assumes OpenAI when there is a key but no endpoint', async () => {
    const p = await resolveProvider({ llm_commit_api_key: 'sk-fake-openai-key' });
    expect(p).toMatchObject({ source: 'settings', endpoint: 'https://api.openai.com/v1/chat/completions' });
  });

  it('honours a chosen model even when the provider was auto-detected', async () => {
    credentials = oauth();
    const p = await resolveProvider({ llm_commit_model: 'claude-opus-5' });
    expect(p?.model).toBe('claude-opus-5');
  });

  it('falls back to the code model on our mesh, which needs no key at all', async () => {
    // This is what makes a fresh install work. Without it, nobody gets a
    // suggested commit message until they configure something.
    const p = await resolveProvider({});
    expect(p).toMatchObject({ source: 'qwen-mesh', model: 'qwen3-coder', apiKey: '' });
  });

  it('falls through to the general model when the code one is down', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      url.includes('qwen') ? { ok: false, json: async () => ({}) }
        : { ok: true, json: async () => ({ data: [{ id: 'hermes-3-8b' }] }) });
    expect(await resolveProvider({})).toMatchObject({ source: 'hermes-mesh' });
  });

  it('skips a mesh model that answers without naming one', async () => {
    // An empty model list is a reachable endpoint with nothing to call.
    vi.stubGlobal('fetch', async (url: string) =>
      url.includes('qwen') ? { ok: true, json: async () => ({ data: [] }) }
        : { ok: true, json: async () => ({ data: [{ id: 'hermes-3-8b' }] }) });
    expect(await resolveProvider({})).toMatchObject({ source: 'hermes-mesh' });
  });

  it('gives up rather than hanging when nothing can answer', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNREFUSED'); });
    expect(await resolveProvider({})).toBeNull();
  });
});
