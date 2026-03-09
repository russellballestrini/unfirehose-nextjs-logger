/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRun = vi.fn();
const mockGet = vi.fn().mockReturnValue({ max_step: -1 });
const mockTransaction = vi.fn((fn: any) => fn);
const mockDb = {
  prepare: vi.fn().mockReturnValue({ run: mockRun, get: mockGet }),
  transaction: mockTransaction,
};

vi.mock('@unturf/unfirehose/db/schema', () => ({
  getDb: vi.fn().mockReturnValue(mockDb),
}));

vi.mock('@unturf/unfirehose/uuidv7', () => ({
  uuidv7: vi.fn().mockReturnValue('test-uuid'),
}));

// Mock fetch globally for proxy polling
const originalFetch = globalThis.fetch;

const { GET, POST } = await import('./route');

function makeRequest(body?: any): Request {
  return new Request('http://localhost:3000/api/training/adapter-http', {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    ...(body && { body: JSON.stringify(body) }),
  });
}

describe('GET /api/training/adapter-http', () => {
  it('returns adapter status', async () => {
    mockDb.prepare.mockReturnValueOnce({ all: vi.fn().mockReturnValue([]) });
    const res = await GET();
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.adapter).toBe('http');
    expect(Array.isArray(data.runs)).toBe(true);
  });
});

describe('POST /api/training/adapter-http', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Re-setup db mock
    mockDb.prepare.mockReturnValue({ run: mockRun, get: mockGet });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('rejects missing url', async () => {
    const res = await POST(makeRequest({}));
    const data = await res.json();
    expect(res.status).toBe(400);
    expect(data.error).toMatch(/url is required/);
  });

  it('discovers models from /loss index', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ live: { 'chatty-v8': 100 }, saved: {} }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model: 'chatty-v8', points: [[0, 8.0], [100, 5.0]], count: 2 }),
      })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false }) as any;

    const res = await POST(makeRequest({ url: 'http://proxy:8088' }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.models).toContain('chatty-v8');
  });

  it('uses explicit model param', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model: 'chatty-v8', points: [[0, 7.5]], count: 1 }),
      })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false }) as any;

    const res = await POST(makeRequest({ url: 'http://proxy:8088', model: 'chatty-v8' }));
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.models).toEqual(['chatty-v8']);
  });
});
