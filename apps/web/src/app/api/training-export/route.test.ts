import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createTestDb } from '@unturf/unfirehose/test/db-helper';

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));

const { GET } = await import('./route');
const { seedDemo, DEMO_PROJECTS } = await import('@unturf/unfirehose/demo-seed');

const get = (query: string) =>
  GET({ nextUrl: new URL(`http://localhost:3000/api/training-export?${query}`) } as never);

let sessions = 0;
beforeAll(() => { sessions = seedDemo(db, { now: Date.parse('2026-10-23T12:00:00.000Z') }).sessions; });

describe('GET /api/training-export', () => {
  it('streams one NDJSON line per session as a download', async () => {
    const res = await get('');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/application\/x-ndjson/);
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="unfirehose-training-all-\d{4}-\d{2}-\d{2}\.jsonl"$/);
    const text = await res.text();
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(sessions);
    for (const l of lines) expect(JSON.parse(l).messages[0].role).toBe('user');
    expect(text).not.toContain('/home/demo/');
  });

  it('names the file by display name and filters by project', async () => {
    const res = await get(`project=${encodeURIComponent(DEMO_PROJECTS[1].name)}`);
    expect(res.headers.get('Content-Disposition')).toContain('unfirehose-training-demo-web-');
    const lines = (await res.text()).trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(sessions);
  });

  it('dry-runs to counts, redactions and a sample', async () => {
    const res = await get('dryRun=1&reasoning=1&limit=2');
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.stats).toMatchObject({ examples: 2, redactions: { home_path: expect.any(Number) } });
    expect(r.sample.messages[1].reasoning_content).toBeTruthy();
    expect(r.bytes).toBeGreaterThan(0);
    expect(r.filters).toEqual({ reasoning: true, limit: 2 });
  });

  it('offers the harnesses and models a form can filter on', async () => {
    const r = await (await get(`facets=1&project=${encodeURIComponent(DEMO_PROJECTS[0].name)}`)).json();
    expect(r.harnesses).toEqual(['agnt', 'claude-code', 'uncloseai']);
    expect(r.models.length).toBeGreaterThan(0);
  });

  it('refuses a bad filter and an unknown project', async () => {
    expect((await get('toolErrors=sometimes')).status).toBe(400);
    expect((await get('project=-home-nobody-git-x')).status).toBe(404);
  });
});
