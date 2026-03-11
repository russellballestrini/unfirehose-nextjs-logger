/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock settings — no user config by default
const mockSettings: Record<string, string> = {};
vi.mock('@unturf/unfirehose/db/ingest', () => ({
  getAllSettings: () => ({ ...mockSettings }),
}));

// Mock fs — no Claude credentials by default
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
}));

// Mock fetch for mesh endpoints
const mockFetch = vi.fn();
global.fetch = mockFetch;

const { GET, resetProviderCache } = await import('./route');

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
  mockFetch.mockReset();
  resetProviderCache();
});

describe('GET /api/llm/providers', () => {
  it('returns empty providers when nothing configured', async () => {
    mockFetch.mockRejectedValue(new Error('unreachable'));
    const res = await GET();
    const data = await res.json();
    expect(data.providers).toEqual([]);
  });

  it('detects user-configured custom provider', async () => {
    mockSettings.llm_commit_endpoint = 'https://api.openai.com/v1/chat/completions';
    mockSettings.llm_commit_api_key = 'sk-test';
    mockSettings.llm_commit_model = 'gpt-4o';
    mockFetch.mockRejectedValue(new Error('unreachable'));

    const res = await GET();
    const data = await res.json();
    const custom = data.providers.find((p: any) => p.id === 'custom');
    expect(custom).toBeTruthy();
    expect(custom.source).toBe('settings');
    expect(custom.type).toBe('openai-compatible');
    expect(custom.model).toBe('gpt-4o');
    expect(custom.ready).toBe(true);
  });

  it('marks custom provider not ready without key for remote endpoints', async () => {
    mockSettings.llm_commit_endpoint = 'https://api.openai.com/v1/chat/completions';
    // No API key
    mockFetch.mockRejectedValue(new Error('unreachable'));

    const res = await GET();
    const data = await res.json();
    const custom = data.providers.find((p: any) => p.id === 'custom');
    expect(custom.ready).toBe(false);
  });

  it('marks local endpoint as ready without key', async () => {
    mockSettings.llm_commit_endpoint = 'http://localhost:11434/v1/chat/completions';
    mockFetch.mockRejectedValue(new Error('unreachable'));

    const res = await GET();
    const data = await res.json();
    const custom = data.providers.find((p: any) => p.id === 'custom');
    expect(custom.ready).toBe(true);
  });

  it('detects mesh providers when reachable', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('qwen.ai.unturf.com')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [{ id: 'qwen3-coder-30b' }] }),
        });
      }
      if (url.includes('hermes.ai.unturf.com')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [{ id: 'hermes-3-8b' }] }),
        });
      }
      return Promise.reject(new Error('unknown'));
    });

    const res = await GET();
    const data = await res.json();

    const qwen = data.providers.find((p: any) => p.id === 'qwen-mesh');
    expect(qwen).toBeTruthy();
    expect(qwen.model).toBe('qwen3-coder-30b');
    expect(qwen.ready).toBe(true);

    const hermes = data.providers.find((p: any) => p.id === 'hermes-mesh');
    expect(hermes).toBeTruthy();
    expect(hermes.model).toBe('hermes-3-8b');
  });

  it('skips mesh providers when unreachable', async () => {
    mockFetch.mockRejectedValue(new Error('timeout'));

    const res = await GET();
    const data = await res.json();
    expect(data.providers.filter((p: any) => p.id.includes('mesh'))).toHaveLength(0);
  });

  it('detects Claude Max OAuth when credentials exist', async () => {
    const { readFile } = await import('fs/promises');
    (readFile as any).mockResolvedValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'tok-123',
        expiresAt: Date.now() + 86400000,
        subscriptionType: 'max_5x',
      },
    }));
    mockFetch.mockRejectedValue(new Error('unreachable'));

    const res = await GET();
    const data = await res.json();
    const claude = data.providers.find((p: any) => p.id === 'claude-max');
    expect(claude).toBeTruthy();
    expect(claude.ready).toBe(true);
    expect(claude.name).toContain('max_5x');
  });

  it('marks Claude Max as not ready when token expired', async () => {
    const { readFile } = await import('fs/promises');
    (readFile as any).mockResolvedValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'tok-expired',
        expiresAt: Date.now() - 1000, // expired
        subscriptionType: 'max_5x',
      },
    }));
    mockFetch.mockRejectedValue(new Error('unreachable'));

    const res = await GET();
    const data = await res.json();
    const claude = data.providers.find((p: any) => p.id === 'claude-max');
    expect(claude).toBeTruthy();
    expect(claude.ready).toBe(false);
  });
});
