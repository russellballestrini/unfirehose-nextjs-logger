import { describe, it, expect, vi } from 'vitest';

vi.mock('fs/promises', () => ({
  readdir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn().mockRejectedValue(new Error('no file')),
  stat: vi.fn().mockRejectedValue(new Error('no file')),
}));

vi.mock('fs', () => ({
  watch: vi.fn(),
  createReadStream: vi.fn(),
}));

vi.mock('@sexy-logger/core/claude-paths', () => ({
  claudePaths: { projects: '/mock/projects' },
  decodeProjectName: (name: string) => name,
}));

const { GET } = await import('./route');

describe('GET /api/live', () => {
  it('returns a Response with text/event-stream content type', async () => {
    const res = await GET();
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
  });

  it('returns correct SSE headers', async () => {
    const res = await GET();
    expect(res.headers.get('Cache-Control')).toBe('no-cache, no-transform');
    expect(res.headers.get('X-Accel-Buffering')).toBe('no');
  });

  it('response body is a ReadableStream', async () => {
    const res = await GET();
    expect(res.body).toBeInstanceOf(ReadableStream);
  });
});
