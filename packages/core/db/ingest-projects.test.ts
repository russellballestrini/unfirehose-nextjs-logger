import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createTestDb, seedProject, seedSession, seedUsageMinute, seedAlert, seedTodo } from '../test/db-helper';
import { getOrCreateProject, mergeProjects, autoMergeIdenticalProjects, harnessPrefixOf } from './ingest-projects';

/**
 * Project identity, against real git repositories in a temp directory.
 *
 * A harness names a project by its encoded path, so renaming a checkout on
 * disk makes it look like a new project. getOrCreateProject resolves a name
 * by, in order: the name itself, an alias it was merged under, then the
 * repository's root commit and remotes; only then does it make a new row.
 * Each test below drives exactly one of those paths.
 */

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

let tmp: string;
/** One repository, with an origin. */
let repoA: string;
/** The same repository cloned elsewhere (the rename case): same root commit, same origin. */
let repoB: string;
/** A clone whose origin points somewhere else entirely: a fork. */
let fork: string;
/** A repository with a different history. */
let other: string;
let rootA: string;

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'ingest-projects-'));
  repoA = path.join(tmp, 'repo-a');
  execFileSync('git', ['init', '-q', repoA]);
  git(repoA, 'commit', '-q', '--allow-empty', '-m', 'root');
  git(repoA, 'remote', 'add', 'origin', 'https://git.example.test/team/repo.git');
  rootA = git(repoA, 'rev-list', '--max-parents=0', 'HEAD');

  repoB = path.join(tmp, 'repo-b');
  execFileSync('git', ['clone', '-q', repoA, repoB], { stdio: 'ignore' });
  git(repoB, 'remote', 'set-url', 'origin', 'https://git.example.test/team/repo.git');

  fork = path.join(tmp, 'fork');
  execFileSync('git', ['clone', '-q', repoA, fork], { stdio: 'ignore' });
  git(fork, 'remote', 'set-url', 'origin', 'https://git.example.test/someone-else/repo.git');

  other = path.join(tmp, 'other');
  execFileSync('git', ['init', '-q', other]);
  git(other, 'commit', '-q', '--allow-empty', '-m', 'a different root');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let db: Database.Database;
beforeEach(() => { db = createTestDb(); });
afterEach(() => db.close());

const project = (id: number) => db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
const aliasesOf = (id: number) => (db.prepare('SELECT encoded_name FROM project_aliases WHERE project_id = ? ORDER BY encoded_name').all(id) as { encoded_name: string }[]).map((r) => r.encoded_name);

describe('harnessPrefixOf', () => {
  it('is the part before the first colon, or nothing', () => {
    expect(harnessPrefixOf('arborist:-home-x')).toBe('arborist');
    expect(harnessPrefixOf('-home-x')).toBe('');
  });
});

describe('getOrCreateProject', () => {
  it('creates a row and a self-alias for a name it has never seen, then finds it by name', () => {
    const id = getOrCreateProject(db, '-tmp-nowhere', 'nowhere');
    expect(project(id)).toMatchObject({ name: '-tmp-nowhere', display_name: 'nowhere', path: '', root_commit_hash: null });
    expect(aliasesOf(id)).toEqual(['-tmp-nowhere']);
    expect(getOrCreateProject(db, '-tmp-nowhere', 'ignored')).toBe(id);
    expect(db.prepare('SELECT COUNT(*) c FROM projects').get()).toEqual({ c: 1 });
  });

  it('records the git identity of a new project inside a repository', () => {
    const id = getOrCreateProject(db, '-repo-a', 'repo-a', repoA);
    expect(project(id)).toMatchObject({
      path: repoA,
      root_commit_hash: rootA,
      origin_url: 'https://git.example.test/team/repo.git',
      last_cwd_seen: repoA,
    });
    expect(JSON.parse(project(id)!.remotes_json as string)).toEqual(['https://git.example.test/team/repo.git']);
  });

  it('backfills a path onto a known project outside any repository', () => {
    const id = getOrCreateProject(db, '-plain', 'plain');
    const dir = path.join(tmp, 'not-a-repo');
    expect(getOrCreateProject(db, '-plain', 'plain', dir)).toBe(id);
    expect(project(id)).toMatchObject({ path: dir, last_cwd_seen: dir });
  });

  it('backfills identity onto a known project once it is seen inside its repository, keeping a path it had', () => {
    const id = seedProject(db, '-known', 'known');  // seeded with path /test/path, no identity
    expect(getOrCreateProject(db, '-known', 'known', repoA)).toBe(id);
    expect(project(id)).toMatchObject({ root_commit_hash: rootA, origin_url: 'https://git.example.test/team/repo.git', path: '/test/path', last_cwd_seen: repoA });
  });

  it('routes a name merged away earlier to the project that absorbed it', () => {
    const id = seedProject(db, '-winner', 'winner');
    db.prepare("INSERT INTO project_aliases (project_id, encoded_name, harness_prefix, last_seen) VALUES (?, '-old-name', '', '2000-01-01')").run(id);
    expect(getOrCreateProject(db, '-old-name', 'old')).toBe(id);
    const seen = db.prepare("SELECT last_seen FROM project_aliases WHERE encoded_name = '-old-name'").get() as { last_seen: string };
    expect(seen.last_seen > '2000-01-01').toBe(true);
    expect(db.prepare("SELECT COUNT(*) c FROM projects WHERE name = '-old-name'").get()).toEqual({ c: 0 });
  });

  it('absorbs a renamed checkout of the same repository as an alias instead of a new project', () => {
    const a = getOrCreateProject(db, '-repo-a', 'repo-a', repoA);
    expect(getOrCreateProject(db, '-repo-b', 'repo-b', repoB)).toBe(a);
    expect(aliasesOf(a)).toEqual(['-repo-a', '-repo-b']);
    expect(project(a)!.last_cwd_seen).toBe(repoB);
  });

  it('keeps a fork, same history but another origin, as its own project', () => {
    const a = getOrCreateProject(db, '-repo-a', 'repo-a', repoA);
    expect(getOrCreateProject(db, '-fork', 'fork', fork)).not.toBe(a);
  });

  it('keeps a different repository apart', () => {
    const a = getOrCreateProject(db, '-repo-a', 'repo-a', repoA);
    expect(getOrCreateProject(db, '-other', 'other', other)).not.toBe(a);
  });

  it('matches identity only within one harness slot', () => {
    const base = getOrCreateProject(db, '-repo-a', 'repo-a', repoA);
    const sub = getOrCreateProject(db, 'arborist:-repo-b', 'repo-b', repoB);
    expect(sub).not.toBe(base);
    // ...and within that slot, the rename case still folds.
    expect(getOrCreateProject(db, 'arborist:-repo-a', 'repo-a', repoA)).toBe(sub);
  });

  it('matches on origin alone when a stored remotes list is unreadable', () => {
    const a = getOrCreateProject(db, '-repo-a', 'repo-a', repoA);
    db.prepare("UPDATE projects SET remotes_json = '{not json' WHERE id = ?").run(a);
    expect(getOrCreateProject(db, '-repo-b', 'repo-b', repoB)).toBe(a);
  });
});

describe('mergeProjects', () => {
  it('refuses to merge a project into itself or into one that does not exist', () => {
    const a = seedProject(db, '-a', 'a');
    expect(mergeProjects(db, a, a)).toBe(false);
    expect(mergeProjects(db, a, 9999)).toBe(false);
    expect(mergeProjects(db, 9999, a)).toBe(false);
    expect(project(a)).toBeDefined();
  });

  it('moves everything the loser owned onto the winner and drops the loser', () => {
    const winner = seedProject(db, '-winner', 'winner');
    const loser = seedProject(db, 'arborist:-loser', 'loser');
    const sid = seedSession(db, loser, 'loser-session');
    seedTodo(db, loser, 'a todo');
    seedUsageMinute(db, winner, '2026-09-01T10:00', { input: 10, output: 1, count: 1 });
    seedUsageMinute(db, loser, '2026-09-01T10:00', { input: 5, output: 2, count: 2 });
    seedUsageMinute(db, loser, '2026-09-01T10:01', { input: 7, count: 1 });
    seedAlert(db, { projectName: 'arborist:-loser' });
    db.prepare("INSERT INTO project_aliases (project_id, encoded_name, harness_prefix) VALUES (?, '-older-loser-name', '')").run(loser);

    expect(mergeProjects(db, loser, winner)).toBe(true);

    expect(project(loser)).toBeUndefined();
    expect(db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sid)).toEqual({ project_id: winner });
    expect(db.prepare('SELECT COUNT(*) c FROM todos WHERE project_id = ?').get(winner)).toEqual({ c: 1 });
    // Overlapping minute summed; the other re-pointed; nothing left on the loser.
    expect(db.prepare('SELECT minute, input_tokens, output_tokens, message_count FROM usage_minutes WHERE project_id = ? ORDER BY minute').all(winner)).toEqual([
      { minute: '2026-09-01T10:00', input_tokens: 15, output_tokens: 3, message_count: 3 },
      { minute: '2026-09-01T10:01', input_tokens: 7, output_tokens: 0, message_count: 1 },
    ]);
    expect(db.prepare('SELECT COUNT(*) c FROM usage_minutes WHERE project_id = ?').get(loser)).toEqual({ c: 0 });
    expect(db.prepare('SELECT project_name FROM alerts').get()).toEqual({ project_name: '-winner' });
    // The loser's own name, and every alias it carried, now route to the winner.
    expect(aliasesOf(winner)).toEqual(['-older-loser-name', 'arborist:-loser']);
    expect(db.prepare("SELECT harness_prefix FROM project_aliases WHERE encoded_name = 'arborist:-loser'").get()).toEqual({ harness_prefix: 'arborist' });
  });
});

describe('autoMergeIdenticalProjects', () => {
  const setIdentity = (id: number, root: string | null, origin: string | null) =>
    db.prepare('UPDATE projects SET root_commit_hash = ?, origin_url = ? WHERE id = ?').run(root, origin, id);

  it('collapses rows sharing root and origin within a slot into the most recently active one', () => {
    const stale = seedProject(db, '-stale', 'stale');
    const live = seedProject(db, '-live', 'live');
    const otherSlot = seedProject(db, 'arborist:-live', 'live');
    const noIdentity = seedProject(db, '-loose', 'loose');
    for (const id of [stale, live, otherSlot]) setIdentity(id, 'abc123', 'https://o.test/r.git');
    setIdentity(noIdentity, null, null);
    seedSession(db, stale, 's-old');
    seedSession(db, live, 's-new');
    db.prepare("UPDATE sessions SET updated_at = '2026-01-01' WHERE session_uuid = 's-old'").run();
    db.prepare("UPDATE sessions SET updated_at = '2026-09-01' WHERE session_uuid = 's-new'").run();

    expect(autoMergeIdenticalProjects(db)).toBe(1);
    expect(project(stale)).toBeUndefined();
    expect(project(live)).toBeDefined();
    expect(project(otherSlot)).toBeDefined();
    expect(project(noIdentity)).toBeDefined();
    expect(aliasesOf(live)).toContain('-stale');
    // Nothing left to do: a second sweep merges nothing.
    expect(autoMergeIdenticalProjects(db)).toBe(0);
  });

  it('treats two local-only rows with the same root as the same repository', () => {
    const a = seedProject(db, '-a', 'a');
    const b = seedProject(db, '-b', 'b');
    setIdentity(a, 'local-root', null);
    setIdentity(b, 'local-root', null);
    expect(autoMergeIdenticalProjects(db)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM projects').get()).toEqual({ c: 1 });
  });
});
