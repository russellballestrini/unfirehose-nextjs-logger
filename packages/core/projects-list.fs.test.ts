import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createTestDb, seedProject, seedSession, seedMessage } from './test/db-helper';

/**
 * buildProjectList against a real Claude projects tree and a seeded
 * database, so the filesystem half of the list — the index-or-readdir
 * counting in loadOneFsProject, the "only probe when the database does
 * not know" rule, the fold onto one name per repo — runs instead of
 * being mocked to nothing.
 */
const root = mkdtempSync(path.join(tmpdir(), 'projects-list-'));
const projects = path.join(root, 'projects');

vi.mock('./claude-paths', async (importOriginal) => {
  const real = await importOriginal<typeof import('./claude-paths')>();
  return {
    ...real,
    claudePaths: {
      ...real.claudePaths,
      projects,
      projectDir: (p: string) => path.join(projects, p),
      sessionsIndex: (p: string) => path.join(projects, p, 'sessions-index.json'),
      sessionFile: (p: string, id: string) => path.join(projects, p, `${id}.jsonl`),
    },
  };
});

const probed: string[] = [];
vi.mock('./project-name', async (importOriginal) => {
  const real = await importOriginal<typeof import('./project-name')>();
  return {
    ...real,
    resolveProjectPath: async (encoded: string) => { probed.push(encoded); return `/resolved/${encoded}`; },
  };
});

let db = createTestDb();
vi.mock('./db/schema', () => ({ getDb: () => db }));

const { buildProjectList } = await import('./projects-list');

beforeAll(() => {
  // Indexed: counts come from sessions-index.json, path from originalPath.
  mkdirSync(path.join(projects, '-home-fox-git-indexed'), { recursive: true });
  writeFileSync(path.join(projects, '-home-fox-git-indexed', 'sessions-index.json'), JSON.stringify({
    originalPath: '/home/fox/git/indexed',
    entries: [{ sessionId: 'a', messageCount: 4 }, { sessionId: 'b', messageCount: 6 }, { sessionId: 'c' }],
  }));
  // Unindexed: counted by listing .jsonl files; the database knows its path.
  mkdirSync(path.join(projects, '-home-fox-git-known'), { recursive: true });
  writeFileSync(path.join(projects, '-home-fox-git-known', 'x.jsonl'), '{}\n');
  writeFileSync(path.join(projects, '-home-fox-git-known', 'y.jsonl'), '{}\n');
  writeFileSync(path.join(projects, '-home-fox-git-known', 'notes.txt'), '');
  // Unindexed and unknown: the only case that pays for a path probe.
  mkdirSync(path.join(projects, '-home-fox-git-unknown'), { recursive: true });
  writeFileSync(path.join(projects, '-home-fox-git-unknown', 'z.jsonl'), '{}\n');
  // A stray file where a project dir would be is not a project.
  writeFileSync(path.join(projects, 'stray.json'), '{}');

  db = createTestDb();
  const known = seedProject(db, '-home-fox-git-known', 'known');
  db.prepare('UPDATE projects SET path = ?, root_commit_hash = ? WHERE id = ?').run('/home/fox/git/known', 'abc123', known);
  const s = seedSession(db, known, 'known-1');
  db.prepare("UPDATE sessions SET harness = 'claude-code' WHERE id = ?").run(s);
  seedMessage(db, s, { type: 'user', timestamp: '2026-09-01T00:00:00Z' });
  seedMessage(db, s, { type: 'assistant', timestamp: '2026-09-02T00:00:00Z', inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheCreationTokens: 30 });
  // A second harness slot of the same repo folds onto the name on disk.
  const twin = seedProject(db, 'uncloseai:home-fox-git-known', 'known (uncloseai)');
  db.prepare('UPDATE projects SET path = ?, root_commit_hash = ? WHERE id = ?').run('/home/fox/git/known', 'abc123', twin);
  const t = seedSession(db, twin, 'twin-1');
  db.prepare("UPDATE sessions SET harness = 'uncloseai' WHERE id = ?").run(t);
  seedMessage(db, t, { type: 'assistant', timestamp: '2026-09-03T00:00:00Z', inputTokens: 10, outputTokens: 5 });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('buildProjectList over a real projects tree', () => {
  it('counts from the index when there is one, and from the files when there is not', async () => {
    const rows = await buildProjectList();
    const indexed = rows.find((p) => p.name === '-home-fox-git-indexed')!;
    expect(indexed).toBeTruthy();
    expect(indexed.sessionCount).toBe(3);
    expect(indexed.totalMessages).toBe(10);
    expect(indexed.path).toBe('/home/fox/git/indexed');
    expect(indexed.displayName).toBe('indexed');          // decodeProjectName keeps the leaf
    expect(rows.find((p) => p.name === 'stray.json')).toBeUndefined();
  });

  it('probes a path only when neither the index nor the database knows it', async () => {
    probed.length = 0;
    const rows = await buildProjectList();
    expect(probed).toEqual(['-home-fox-git-unknown']);
    const unknown = rows.find((p) => p.name === '-home-fox-git-unknown')!;
    expect(unknown.path).toBe('/resolved/-home-fox-git-unknown');
    expect(unknown.sessionCount).toBe(1);
  });

  it('folds a repo’s harness slots onto its on-disk name and sums their work', async () => {
    const rows = await buildProjectList();
    const known = rows.find((p) => p.name === '-home-fox-git-known')!;
    expect(rows.find((p) => p.name === 'uncloseai:home-fox-git-known')).toBeUndefined();
    expect(known.path).toBe('/home/fox/git/known');
    expect(known.sessionCount).toBe(2);
    expect(known.totalMessages).toBe(3);
    expect(known.tokens).toEqual({ input: 110, output: 25, cacheRead: 900, cacheWrite: 30 });
    expect([...(known.harnesses ?? [])].sort()).toEqual(['claude-code', 'uncloseai']);
    // latest is the newer of the newest message and the session row's own
    // clock (seedSession stamps updated_at now), so only the floor is fixed.
    expect(known.latestActivity >= '2026-09-03T00:00:00Z').toBe(true);
  });

  it('is empty, not broken, when the projects tree is gone', async () => {
    rmSync(projects, { recursive: true, force: true });
    const rows = await buildProjectList();
    expect(rows.find((p) => p.name === '-home-fox-git-indexed')).toBeUndefined();
    expect(rows.find((p) => p.name === '-home-fox-git-known')).toBeTruthy();   // still in the database
  });
});
