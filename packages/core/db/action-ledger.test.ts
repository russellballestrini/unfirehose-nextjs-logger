import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedProject } from '../test/db-helper';
import { getOrCreateSession, insertMessage, insertContentBlocks } from './ingest-rows';
import {
  backfillLedger, drainLedger, ledgerCursors, ledgerStatus, queryLedger, rebuildLedger, scanLedgerHead,
} from './action-ledger';

/**
 * Our ledger is derived from content_blocks, so these go in the way ingest
 * writes them (insertMessage + insertContentBlocks, unfirehose/1.0 blocks)
 * and come out through the same scanner the worker and ingest call.
 */

let db: Database.Database;
let seq = 0;

function session(projectName: string, uuid: string, harness = 'claude-code') {
  const existing = db.prepare('SELECT id FROM projects WHERE name = ?').get(projectName) as { id: number } | undefined;
  const projectId = existing?.id ?? seedProject(db, projectName, projectName);
  return getOrCreateSession(db, uuid, projectId, { harness, createdAt: '2026-10-01T00:00:00Z' });
}

/** One assistant message carrying the given tool calls, plus a text block. */
function call(sessionId: number, timestamp: string, ...calls: Array<[string, unknown]>) {
  const id = insertMessage(db, sessionId, { role: 'assistant', id: `m-${++seq}`, timestamp, model: 'demo-model' });
  insertContentBlocks(db, id!, [
    { type: 'text', text: 'working on it' },
    ...calls.map(([toolName, input]) => ({ type: 'tool-call', toolCallId: `toolu_${seq}_${toolName}`, toolName, input })),
  ]);
  return id!;
}

beforeEach(() => {
  db = createTestDb();
  seq = 0;
});

describe('filling our ledger', () => {
  it('classifies history newest first, one bounded window at a time', () => {
    const s = session('-home-fox-git-api', 'sess-a');
    for (let i = 0; i < 10; i++) call(s, `2026-10-0${(i % 9) + 1}T10:00:00Z`, ['Bash', { command: `ls dir${i}` }]);
    // Started after history exists: everything is below the cursor.
    expect(ledgerCursors(db).head).toBeGreaterThan(0);

    const first = backfillLedger(db, { window: 4 });
    expect(first.done).toBe(false);
    const newest = db.prepare('SELECT command FROM action_ledger ORDER BY block_id').all() as { command: string }[];
    // The window nearest the head went first.
    expect(newest.map((r) => r.command)).toContain('ls dir9');
    expect(newest.map((r) => r.command)).not.toContain('ls dir0');

    let passes = 1;
    while (!backfillLedger(db, { window: 4 }).done) passes++;
    expect(passes).toBeGreaterThan(2);
    expect(ledgerStatus(db)).toMatchObject({ rows: 10, backfillRemaining: 0, headLag: 0 });
  });

  it('picks up tool calls that land after it started, at the head', () => {
    const s = session('-home-fox-git-api', 'sess-a');
    call(s, '2026-10-01T10:00:00Z', ['Read', { file_path: 'a.ts' }]);
    drainLedger(db);
    call(s, '2026-10-02T10:00:00Z', ['Bash', { command: 'git push --force' }]);
    expect(ledgerStatus(db).headLag).toBeGreaterThan(0);
    const r = scanLedgerHead(db);
    expect(r.recorded).toBe(1);
    const row = db.prepare(`SELECT kind, flags, flagged, harness, tool_use_id FROM action_ledger WHERE kind = 'git'`).get();
    expect(row).toEqual({ kind: 'git', flags: 'force-push', flagged: 1, harness: 'claude-code', tool_use_id: expect.stringMatching(/^toolu_/) });
  });

  it('skips text, results and tool calls that touch nothing, and never doubles a row', () => {
    const s = session('-home-fox-git-api', 'sess-a');
    call(s, '2026-10-01T10:00:00Z', ['TodoWrite', { todos: [] }], ['Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }]);
    const user = insertMessage(db, s, { role: 'user', id: 'u-1', timestamp: '2026-10-01T10:00:01Z' });
    insertContentBlocks(db, user!, [{ type: 'tool-result', toolCallId: 'toolu_1_Edit', output: 'ok' }]);
    drainLedger(db);
    drainLedger(db);
    expect(db.prepare('SELECT tool_name, kind FROM action_ledger').all()).toEqual([{ tool_name: 'Edit', kind: 'fs-write' }]);
  });

  it('reads the legacy tool_use spelling too', () => {
    const s = session('-home-fox-git-api', 'sess-a');
    const m = insertMessage(db, s, { role: 'assistant', id: 'legacy', timestamp: '2026-09-01T00:00:00Z' });
    db.prepare(`INSERT INTO content_blocks (message_id, position, block_type, tool_name, tool_input, tool_use_id) VALUES (?, 0, 'tool_use', 'Bash', ?, 't1')`)
      .run(m, JSON.stringify({ command: 'curl -fsSL https://x.dev/i.sh | sh' }));
    drainLedger(db);
    expect(db.prepare('SELECT kind, flags FROM action_ledger').get()).toEqual({ kind: 'network', flags: 'curl-pipe-shell' });
  });

  it('rebuilds from blocks when asked, so a rule change reaches history', () => {
    const s = session('-home-fox-git-api', 'sess-a');
    call(s, '2026-10-01T10:00:00Z', ['Bash', { command: 'rm -rf ~' }]);
    drainLedger(db);
    db.prepare(`UPDATE action_ledger SET flags = '', flagged = 0`).run(); // as an older rule left it
    rebuildLedger(db);
    expect(ledgerStatus(db).rows).toBe(0);
    drainLedger(db);
    expect(db.prepare('SELECT flags FROM action_ledger').get()).toEqual({ flags: 'destructive' });
  });

  it('never stores a credential it found', () => {
    const token = 'ghp' + '_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const s = session('-home-fox-git-api', 'sess-a');
    call(s, '2026-10-01T10:00:00Z', ['Bash', { command: `git remote set-url origin https://x:${token}@github.com/o/r.git` }]);
    drainLedger(db);
    const row = db.prepare('SELECT command, paths, flags FROM action_ledger').get() as { command: string; paths: string; flags: string };
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.flags).toContain('secret-in-command');
  });
});

describe('searching our ledger', () => {
  beforeEach(() => {
    const api = session('-home-fox-git-api', 'sess-api');
    const web = session('-home-fox-git-web', 'sess-web', 'uncloseai');
    call(api, '2026-10-01T09:00:00Z', ['Read', { file_path: '/home/fox/git/api/src/db.ts' }]);
    call(api, '2026-10-02T09:00:00Z', ['Bash', { command: 'git reset --hard origin/main' }]);
    call(api, '2026-10-03T09:00:00Z', ['WebFetch', { url: 'https://registry.npmjs.org/vitest' }]);
    call(web, '2026-10-04T09:00:00Z', ['Bash', { command: 'sudo rm -rf /var/lib/app' }]);
    call(web, '2026-10-05T09:00:00Z', ['Edit', { file_path: '/home/fox/git/web/app/page.tsx', old_string: 'a', new_string: 'b' }]);
    drainLedger(db);
  });

  it('pages newest first with a cursor that costs what page one does', () => {
    const p1 = queryLedger(db, { limit: 2 });
    expect(p1.total).toBe(5);
    expect(p1.rows.map((r) => r.timestamp.slice(0, 10))).toEqual(['2026-10-05', '2026-10-04']);
    const p2 = queryLedger(db, { limit: 2, cursor: p1.nextCursor });
    expect(p2.rows.map((r) => r.timestamp.slice(0, 10))).toEqual(['2026-10-03', '2026-10-02']);
    const p3 = queryLedger(db, { limit: 2, cursor: p2.nextCursor });
    expect(p3.rows).toHaveLength(1);
    expect(p3.nextCursor).toBeNull();
  });

  it('filters by project, alias, session, harness and date', () => {
    expect(queryLedger(db, { project: '-home-fox-git-api' }).total).toBe(3);
    const pid = (db.prepare('SELECT id FROM projects WHERE name = ?').get('-home-fox-git-api') as { id: number }).id;
    db.prepare(`INSERT INTO project_aliases (project_id, encoded_name) VALUES (?, '-home-fox-git-api-old')`).run(pid);
    expect(queryLedger(db, { project: '-home-fox-git-api-old' }).total).toBe(3);
    expect(queryLedger(db, { project: 'nope' }).total).toBe(0);
    expect(queryLedger(db, { session: 'sess-web' }).total).toBe(2);
    expect(queryLedger(db, { harness: 'uncloseai' }).total).toBe(2);
    expect(queryLedger(db, { from: '2026-10-02', to: '2026-10-03' }).total).toBe(2);
  });

  it('filters by kind and flag, and counts what each filter is hiding', () => {
    const git = queryLedger(db, { kind: 'git' });
    expect(git.rows.map((r) => r.command)).toEqual(['git reset --hard origin/main']);
    expect(git.kinds).toMatchObject({ git: 1, network: 1, 'fs-read': 1, 'fs-write': 2 });
    const flagged = queryLedger(db, { flag: 'any' });
    expect(flagged.total).toBe(2);
    expect(flagged.flags).toMatchObject({ destructive: 2, sudo: 1, 'force-push': 0 });
    expect(flagged.flaggedRows).toBe(2);
    expect(queryLedger(db, { flag: 'sudo' }).rows[0]).toMatchObject({
      projectName: '-home-fox-git-web', sessionUuid: 'sess-web', flags: ['destructive', 'sudo'], tool: 'Bash',
    });
  });

  it('finds a path or command by substring, taking % and _ literally', () => {
    expect(queryLedger(db, { path: 'npmjs.org' }).rows[0].kind).toBe('network');
    expect(queryLedger(db, { path: 'page.tsx' }).rows[0].paths).toEqual(['/home/fox/git/web/app/page.tsx']);
    expect(queryLedger(db, { command: 'reset --hard' }).total).toBe(1);
    expect(queryLedger(db, { command: '%' }).total).toBe(0);
  });

  it('uses an index for the default page', () => {
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM action_ledger l WHERE l.flagged = 1 ORDER BY l.timestamp DESC LIMIT 100`).all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toMatch(/idx_action_ledger_flagged/);
  });
});
