import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb, seedProject, seedSession, seedMessage } from '@unturf/unfirehose/test/db-helper';

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));
// The machine running the tests is not the machine being onboarded.
let found: Array<Record<string, unknown>> = [];
vi.mock('@unturf/unfirehose/harness-detect', () => ({ detectHarnesses: () => found }));
// Nor is its disk the one being checked.
const GiB = 1024 ** 3;
let space: { path: string; freeBytes: number; totalBytes: number } | null = { path: '/data', freeBytes: 200 * GiB, totalBytes: 500 * GiB };
vi.mock('@unturf/unfirehose/db/maintenance', async (orig) => ({
  ...(await orig<typeof import('@unturf/unfirehose/db/maintenance')>()),
  dbDiskSpace: () => space,
}));

const { GET } = await import('./route');
const { setSetting } = await import('@unturf/unfirehose/db/ingest');

beforeEach(() => {
  for (const t of ['messages', 'sessions', 'projects', 'settings']) db.prepare(`DELETE FROM ${t}`).run();
  found = [{ id: 'claude-code', found: true, readable: true, files: 3, newestMs: 1, root: '/x', doc: 'd', label: 'Claude Code' }];
});

describe('GET /api/onboarding', () => {
  it('on an empty database: nothing ingested, no worker, and the harnesses on disk', async () => {
    const body = await (await GET()).json();
    expect(body).toMatchObject({ sessions: 0, projects: 0, messages: 0, workerAlive: false, lastIngestAt: null });
    expect(body.harnesses[0]).toMatchObject({ id: 'claude-code', found: true, sessions: 0, lastMessageAt: null });
  });

  it('counts what has landed and joins each harness to its sessions', async () => {
    const p = seedProject(db, '-home-fox-git-a', 'a');
    const s = seedSession(db, p, 'o-1');
    db.prepare("UPDATE sessions SET last_message_at = '2026-10-22T10:00:00Z' WHERE id = ?").run(s);
    seedMessage(db, s); seedMessage(db, s);
    const body = await (await GET()).json();
    expect(body).toMatchObject({ sessions: 1, projects: 1, messages: 2 });
    expect(body.harnesses[0]).toMatchObject({ sessions: 1, lastMessageAt: '2026-10-22T10:00:00Z' });
  });

  it('calls the worker alive on a recent heartbeat only: a payload a page built proves nothing', async () => {
    setSetting('last_ingest_at', new Date(Date.now() - 60 * 60_000).toISOString());
    setSetting('dashboard_7d_at', new Date().toISOString());
    const stale = await (await GET()).json();
    expect(stale.workerAlive).toBe(false);
    expect(stale.payloadAt).not.toBeNull();
    setSetting('last_ingest_at', new Date().toISOString());
    expect((await (await GET()).json()).workerAlive).toBe(true);
  });

  it('reports free disk under our database, low under 10 GB', async () => {
    space = { path: '/data', freeBytes: 200 * GiB, totalBytes: 500 * GiB };
    expect((await (await GET()).json()).disk).toEqual({ path: '/data', freeBytes: 200 * GiB, totalBytes: 500 * GiB, level: 'ok', lowBytes: 10 * GiB });
    space = { path: '/data', freeBytes: 6 * GiB, totalBytes: 500 * GiB };
    expect((await (await GET()).json()).disk.level).toBe('low');
    space = { path: '/data', freeBytes: 0.2 * GiB, totalBytes: 500 * GiB };
    expect((await (await GET()).json()).disk.level).toBe('critical');
    space = null;
    expect((await (await GET()).json()).disk).toMatchObject({ freeBytes: null, level: 'unknown' });
  });
});
