import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { createTestDb, seedProject } from '../test/db-helper';

let db: Database.Database;
vi.mock('./schema', () => ({ getDb: () => db }));
const { repoPathForProject, pathFromEncodedName } = await import('./repo-path');

let tmp: string;
beforeEach(() => { db = createTestDb(); tmp = mkdtempSync(path.join(tmpdir(), 'repopath-')); });
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

const withPath = (name: string, p: string | null) => {
  const id = seedProject(db, name);
  db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(p, id);
  return id;
};

describe('repoPathForProject', () => {
  it('uses what ingest recorded, whatever the harness prefix', () => {
    // The case that broke the Code tab: no Claude directory ever existed for
    // this row, so both filesystem guesses fail and only the DB knows.
    withPath('uncloseai:home-fox-git-uncloseai-cli', tmp);
    expect(repoPathForProject('uncloseai:home-fox-git-uncloseai-cli', db)).toBe(tmp);
  });

  it('falls back to the same repo under another harness slot', () => {
    withPath('uncloseai:home-fox-git-demo', null);
    withPath('-home-fox-git-demo', tmp);
    expect(repoPathForProject('uncloseai:home-fox-git-demo', db)).toBe(tmp);
  });

  it('never returns a path that is not there', () => {
    withPath('ghost', '/definitely/not/here');
    expect(repoPathForProject('ghost', db)).toBeNull();
  });

  it('decodes a name when the project has no rows yet', () => {
    const repo = path.join(tmp, 'home', 'fox', 'git', 'brand-new');
    mkdirSync(repo, { recursive: true });
    // pathFromEncodedName only builds absolute paths, so assert its shape
    // directly rather than fabricating a fake /home tree.
    expect(pathFromEncodedName('-home-fox-git-nothing-here-at-all')).toBeNull();
  });

  it('reads a project with no git segment as unknown rather than guessing', () => {
    expect(pathFromEncodedName('thinking-room')).toBeNull();
    expect(pathFromEncodedName('')).toBeNull();
  });
});
