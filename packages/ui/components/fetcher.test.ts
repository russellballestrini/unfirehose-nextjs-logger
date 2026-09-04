import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetcher } from './fetcher';

const mock = (init: { status?: number; body?: unknown }) => {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    statusText: 'Test',
    json: async () => init.body,
  }) as unknown as typeof fetch;
};

afterEach(() => vi.restoreAllMocks());

describe('fetcher', () => {
  it('returns the parsed body on success', async () => {
    mock({ body: { ok: true } });
    await expect(fetcher('/api/x')).resolves.toEqual({ ok: true });
  });

  it('throws on a non-2xx instead of resolving, so SWR reports the error', async () => {
    // The copies this replaces resolved with the error body, so a 500
    // rendered as a page of undefined rather than a message.
    mock({ status: 500, body: { error: 'boom' } });
    await expect(fetcher('/api/x')).rejects.toThrow(/500/);
  });

  it('carries the status and body on the thrown error', async () => {
    mock({ status: 404, body: { error: 'nope' } });
    await fetcher('/api/x').catch((e) => {
      expect(e.status).toBe(404);
      expect(e.body).toEqual({ error: 'nope' });
    });
  });
});
