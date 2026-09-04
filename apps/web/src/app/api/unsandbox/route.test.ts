import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';

const settings: Record<string, string | null> = {
  unsandbox_public_key: 'pk_test',
  unsandbox_secret_key: 'sk_secret',
};

vi.mock('@unturf/unfirehose/db/ingest', () => ({
  getSetting: (key: string) => settings[key] ?? null,
}));

const { POST } = await import('./route');

const post = (body: unknown) =>
  POST({ json: async () => body } as never);

const okJson = (data: unknown) => ({
  ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data),
});

beforeEach(() => {
  settings.unsandbox_public_key = 'pk_test';
  settings.unsandbox_secret_key = 'sk_secret';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ tier: 'free' })));
});

/**
 * This proxy holds the only copy of our unsandbox credentials and signs every
 * call with them, so the two things worth pinning are that it refuses to act
 * without keys and that what it signs is what the API expects.
 */
describe('POST /api/unsandbox', () => {
  it('refuses every action when no keys are configured', async () => {
    settings.unsandbox_public_key = null;
    const res = await post({ action: 'test' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('No unsandbox keys');
    // And it did not reach for the network to find that out.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an action it does not know rather than falling through', async () => {
    const res = await post({ action: 'rm -rf' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Unknown action');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('signs a request the way the API verifies it', async () => {
    await post({ action: 'test' });

    const [url, init] = (fetch as never as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.unsandbox.com/keys/self');

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer pk_test');

    // The signed message is `${timestamp}:${method}:${path}:${body}` — the
    // whole point of this route, and the one thing a rename or a reordering
    // would break silently, since the server just answers 401.
    const expected = createHmac('sha256', 'sk_secret')
      .update(`${headers['X-Timestamp']}:GET:/keys/self:`)
      .digest('hex');
    expect(headers['X-Signature']).toBe(expected);
  });

  it('stamps the signature with a current timestamp', async () => {
    await post({ action: 'test' });
    const [, init] = (fetch as never as ReturnType<typeof vi.fn>).mock.calls[0];
    const stamped = Number((init.headers as Record<string, string>)['X-Timestamp']);
    // Seconds, not milliseconds — the server reads it as seconds and rejects
    // anything skewed, so a unit slip fails every call.
    expect(Math.abs(stamped - Math.floor(Date.now() / 1000))).toBeLessThan(5);
  });

  it('checks its own arguments before spending a call', async () => {
    const res = await post({ action: 'kill-session' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Missing sessionId');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('turns a rejected signature into something a reader can act on', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => '' }));
    const body = await (await post({ action: 'test' })).json();
    expect(body.ok).toBe(false);
    // "HTTP 401" alone sends someone hunting for a code defect; it is almost
    // always a rotated secret.
    expect(body.error).toContain('stale secret key');
  });

  it('names clock skew when the server blames the timestamp', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('invalid_timestamp')));
    const body = await (await post({ action: 'test' })).json();
    expect(body.error).toContain('clock skew');
  });

  it('carries a signed body into the signature for a write', async () => {
    await post({ action: 'execute', language: 'bash', code: 'echo hi' });

    const [url, init] = (fetch as never as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.unsandbox.com/execute');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    const expected = createHmac('sha256', 'sk_secret')
      .update(`${headers['X-Timestamp']}:POST:/execute:${init.body}`)
      .digest('hex');
    expect(headers['X-Signature']).toBe(expected);

    // Defaults the caller did not state, so a bare request is still valid.
    expect(JSON.parse(init.body)).toEqual({
      language: 'bash', code: 'echo hi', network_mode: 'semitrusted',
    });
  });
});
