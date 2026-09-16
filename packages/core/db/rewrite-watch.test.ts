import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createTestDb } from '../test/db-helper';

let db = createTestDb();
vi.mock('./schema', () => ({
  getDb: () => db,
  UNFIREHOSE_DIR: '/tmp/unfirehose-test',
}));

const { witnessHash } = await import('../provenance');
const { watchRewrites, getRewrites, getRewriteSummary, pruneShadows, classify, digestLine, SHADOW_TEXT_CAP } =
  await import('./rewrite-watch');

/**
 * The rewrite watch, driven against real files in a temp dir and the
 * real schema: the shadow it keeps, the rows it writes when a line it
 * already saw comes back different, and the gates that keep it off the
 * witness's files (quiescent, chained) and off stale shadows.
 */
let root: string;
const SLUG = '-tmp-rewrite-proj';

const fileOf = (uuid: string) => path.join(root, SLUG, `${uuid}.jsonl`);

function writeLines(uuid: string, lines: string[], opts: { trailingNewline?: boolean } = {}) {
  mkdirSync(path.join(root, SLUG), { recursive: true });
  writeFileSync(fileOf(uuid), lines.join('\n') + (opts.trailingNewline === false ? '' : '\n'));
}

/** A session ingest has read: a project, a session row with its harness, and an offset naming the file. */
function seed(uuid: string, lines: string[], harness = 'claude-code') {
  writeLines(uuid, lines);
  let proj = db.prepare('SELECT id FROM projects WHERE name = ?').get(`claude:${SLUG}`) as { id: number } | undefined;
  if (!proj) {
    proj = { id: db.prepare('INSERT INTO projects (name, display_name, path) VALUES (?, ?, ?)')
      .run(`claude:${SLUG}`, SLUG, '/tmp').lastInsertRowid as number };
  }
  db.prepare("INSERT OR IGNORE INTO sessions (session_uuid, project_id, harness, created_at) VALUES (?, ?, ?, datetime('now'))")
    .run(uuid, proj.id, harness);
  db.prepare(`INSERT INTO ingest_offsets (file_path, byte_offset, last_ingested) VALUES (?, ?, datetime('now'))
    ON CONFLICT(file_path) DO UPDATE SET last_ingested = excluded.last_ingested`)
    .run(fileOf(uuid), 0);
}

const age = (uuid: string, minutes: number) => {
  const t = new Date(Date.now() - minutes * 60_000);
  utimesSync(fileOf(uuid), t, t);
};

const shadowOf = (uuid: string) =>
  db.prepare('SELECT seq, hash, len, truncated FROM session_shadow_leaves WHERE session_uuid = ? ORDER BY seq').all(uuid) as
    { seq: number; hash: string; len: number; truncated: number }[];

// Claude-Code-shaped lines: the writer refreshes `usage` on an assistant
// line after the fact, and sometimes the content itself.
const user = (text: string) =>
  JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: text } });
const assistant = (text: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text }], usage }, ...extra });

beforeEach(() => {
  db = createTestDb();
  root = mkdtempSync(path.join(tmpdir(), 'unfirehose-rewrite-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('watchRewrites: the live shadow', () => {
  it('a live unchained file is recorded to the shadow on the first pass, with nothing to report', () => {
    const lines = [user('add a test'), assistant('done', { input_tokens: 10, output_tokens: 2 })];
    seed('live1', lines);
    const r = watchRewrites(db, { limit: 10 });
    expect(r).toEqual({ files: 1, rewrites: 0, truncations: 0, pruned: 0 });
    const shadow = shadowOf('live1');
    expect(shadow.map((s) => s.seq)).toEqual([0, 1]);
    expect(shadow.map((s) => s.hash)).toEqual(lines.map(witnessHash));
    expect(shadow.map((s) => s.len)).toEqual(lines.map((l) => l.length));
    expect(getRewrites(db)).toEqual([]);
    // A second pass over an unchanged file is silent too.
    expect(watchRewrites(db, { limit: 10 }).rewrites).toBe(0);
  });

  it('a rewritten tail line yields one row with before/after, tail distance and the keys that moved', () => {
    const before = assistant('done', { input_tokens: 10, output_tokens: 2 });
    seed('rw1', [user('add a test'), before, user('thanks')]);
    watchRewrites(db, { limit: 10 });
    // Claude Code comes back and edits line 1: content AND usage differ.
    const after = assistant('all tests pass', { input_tokens: 10, output_tokens: 9 });
    writeLines('rw1', [user('add a test'), after, user('thanks'), user('one more')]);
    const r = watchRewrites(db, { limit: 10 });
    expect(r.rewrites).toBe(1);
    expect(r.truncations).toBe(0);
    const rows = getRewrites(db);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.session_uuid).toBe('rw1');
    expect(row.project).toBe(`claude:${SLUG}`);
    expect(row.harness).toBe('claude-code');
    expect(row.kind).toBe('rewritten');
    expect(row.seq).toBe(1);
    expect(row.file_lines).toBe(4);
    expect(row.tail_distance).toBe(2);                       // 4 - 1 - 1
    expect(row.before_text).toBe(before);
    expect(row.after_text).toBe(after);
    expect(row.before_hash).toBe(witnessHash(before));
    expect(row.after_hash).toBe(witnessHash(after));
    expect(row.before_len).toBe(before.length);
    expect(row.after_len).toBe(after.length);
    expect(row.truncated).toBe(false);
    expect(row.changed_keys).toEqual(['message.content', 'message.usage']);
    expect(row.content_changed).toBe(true);
    expect([row.before_type, row.after_type]).toEqual(['assistant', 'assistant']);
    expect(row.observed_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // The shadow now holds the file as it is: the new line 1 and the appended line 3.
    const shadow = shadowOf('rw1');
    expect(shadow).toHaveLength(4);
    expect(shadow[1].hash).toBe(witnessHash(after));
    // And the same file, unchanged, reports nothing more.
    expect(watchRewrites(db, { limit: 10 }).rewrites).toBe(0);
    expect(getRewrites(db)).toHaveLength(1);
  });

  it('a usage-only refresh is metadata, not a content change', () => {
    seed('rw2', [user('hi'), assistant('ok', { input_tokens: 5, output_tokens: 1 })]);
    watchRewrites(db, { limit: 10 });
    writeLines('rw2', [user('hi'), assistant('ok', { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 4000 })]);
    watchRewrites(db, { limit: 10 });
    const [row] = getRewrites(db);
    expect(row.changed_keys).toEqual(['message.usage']);
    expect(row.content_changed).toBe(false);
    expect(row.tail_distance).toBe(0);
    const s = getRewriteSummary(db, { sinceHours: 1 });
    expect(s.total).toBe(1);
    expect(s.contentChanged).toBe(0);
    expect(s.metadataOnly).toBe(1);
    expect(s.byChangedKey).toEqual({ 'message.usage': 1 });
    expect(s.byHarness).toEqual({ 'claude-code': 1 });
    expect(s.sessions).toBe(1);
  });

  it('a file that shrank below its shadow yields truncated rows for the lines it lost', () => {
    const lines = [user('a'), assistant('b', { input_tokens: 1 }), user('c'), user('d')];
    seed('tr1', lines);
    watchRewrites(db, { limit: 10 });
    writeLines('tr1', lines.slice(0, 2));
    const r = watchRewrites(db, { limit: 10 });
    expect(r).toMatchObject({ rewrites: 0, truncations: 2 });
    const rows = getRewrites(db).sort((a, b) => a.seq - b.seq);
    expect(rows.map((x) => x.kind)).toEqual(['truncated', 'truncated']);
    expect(rows.map((x) => x.seq)).toEqual([2, 3]);
    expect(rows[0].file_lines).toBe(2);
    expect(rows[0].tail_distance).toBe(-1);                  // 2 - 1 - 2: past the end
    expect(rows[0].before_text).toBe(lines[2]);
    expect(rows[0].after_text).toBeNull();
    expect(rows[0].after_hash).toBeNull();
    expect(rows[0].after_len).toBeNull();
    expect(rows[0].before_type).toBe('user');
    expect(rows[0].after_type).toBeNull();
    expect(rows[0].changed_keys).toEqual([]);
    expect(shadowOf('tr1')).toHaveLength(2);
    expect(getRewriteSummary(db, { sinceHours: 1 }).truncations).toBe(2);
  });

  it('a trailing partial line is not shadowed; when it completes it is simply new', () => {
    seed('pt1', [user('a')]);
    writeFileSync(fileOf('pt1'), user('a') + '\n' + '{"type":"user","mess');
    watchRewrites(db, { limit: 10 });
    expect(shadowOf('pt1')).toHaveLength(1);
    writeLines('pt1', [user('a'), user('b')]);
    expect(watchRewrites(db, { limit: 10 }).rewrites).toBe(0);
    expect(shadowOf('pt1')).toHaveLength(2);
  });

  it('a quiescent file is the witness’s, and is skipped', () => {
    seed('quiet1', [user('a')]);
    age('quiet1', 11);
    expect(watchRewrites(db, { limit: 10 }).files).toBe(0);
    expect(shadowOf('quiet1')).toEqual([]);
  });

  it('a chained session is skipped: an append-only writer needs no shadow', () => {
    seed('chained1', [user('a')]);
    db.prepare("INSERT INTO session_chain (session_uuid, state, entries, hashed) VALUES ('chained1', 'open', 1, 1)").run();
    expect(watchRewrites(db, { limit: 10 }).files).toBe(0);
    // An unchained session_chain row (hashed = 0) is still ours.
    seed('unchained1', [user('a')]);
    db.prepare("INSERT INTO session_chain (session_uuid, state, entries, hashed) VALUES ('unchained1', 'unchained', 1, 0)").run();
    expect(watchRewrites(db, { limit: 10 }).files).toBe(1);
    expect(shadowOf('unchained1')).toHaveLength(1);
  });

  it('a long line is stored capped with truncated=1 and its full length, and still classifies', () => {
    const big = assistant('x'.repeat(SHADOW_TEXT_CAP + 500), { input_tokens: 1 });
    expect(big.length).toBeGreaterThan(SHADOW_TEXT_CAP);
    seed('big1', [user('a'), big]);
    watchRewrites(db, { limit: 10 });
    const [, s] = shadowOf('big1');
    expect(s.truncated).toBe(1);
    expect(s.len).toBe(big.length);
    const text = (db.prepare('SELECT text FROM session_shadow_leaves WHERE session_uuid = ? AND seq = 1').get('big1') as { text: string }).text;
    expect(text).toHaveLength(SHADOW_TEXT_CAP);
    expect(text).toBe(big.slice(0, SHADOW_TEXT_CAP));
    // A usage refresh on the long line: the digest, not the capped text, tells which key moved.
    const big2 = assistant('x'.repeat(SHADOW_TEXT_CAP + 500), { input_tokens: 1, output_tokens: 7 });
    writeLines('big1', [user('a'), big2]);
    watchRewrites(db, { limit: 10 });
    const [row] = getRewrites(db);
    expect(row.truncated).toBe(true);
    expect(row.before_text).toHaveLength(SHADOW_TEXT_CAP);
    expect(row.after_text).toHaveLength(SHADOW_TEXT_CAP);
    expect(row.before_len).toBe(big.length);
    expect(row.after_len).toBe(big2.length);
    expect(row.changed_keys).toEqual(['message.usage']);
    expect(row.content_changed).toBe(false);
  });

  it('pruning drops the shadow of a file quiet for over an hour, and of a file that is gone', () => {
    seed('old1', [user('a')]);
    seed('gone1', [user('a')]);
    seed('warm1', [user('a')]);
    watchRewrites(db, { limit: 10 });
    expect(shadowOf('old1')).toHaveLength(1);
    age('old1', 61);
    age('warm1', 30);                                        // quiescent for the witness, too young to prune
    rmSync(fileOf('gone1'));
    expect(pruneShadows(db)).toBe(2);
    expect(shadowOf('old1')).toEqual([]);
    expect(shadowOf('gone1')).toEqual([]);
    expect(shadowOf('warm1')).toHaveLength(1);
    // The pass prunes as it goes.
    age('warm1', 61);
    expect(watchRewrites(db, { limit: 10 }).pruned).toBe(1);
    expect(shadowOf('warm1')).toEqual([]);
  });

  it('a file that is not a journal at all is skipped, never fatal', () => {
    seed('bad1', [user('a')]);
    rmSync(fileOf('bad1'));
    mkdirSync(fileOf('bad1'));                                // a directory where the file was
    seed('ok1', [user('b')]);
    expect(() => watchRewrites(db, { limit: 10 })).not.toThrow();
    expect(shadowOf('ok1')).toHaveLength(1);
  });

  it('the limit takes the most recently modified files', () => {
    for (const n of ['l1', 'l2', 'l3']) seed(n, [user(n)]);
    age('l1', 5);
    age('l2', 1);
    expect(watchRewrites(db, { limit: 2 }).files).toBe(2);
    expect(shadowOf('l1')).toEqual([]);
    expect(shadowOf('l2')).toHaveLength(1);
    expect(shadowOf('l3')).toHaveLength(1);
  });
});

describe('getRewrites filters', () => {
  it('filters by session, harness and since', () => {
    seed('f1', [user('a')], 'claude-code');
    seed('f2', [user('a')], 'hermes');
    watchRewrites(db, { limit: 10 });
    writeLines('f1', [user('b')]);
    writeLines('f2', [user('c')]);
    watchRewrites(db, { limit: 10 });
    expect(getRewrites(db)).toHaveLength(2);
    expect(getRewrites(db, { session: 'f1' }).map((r) => r.session_uuid)).toEqual(['f1']);
    expect(getRewrites(db, { harness: 'hermes' }).map((r) => r.session_uuid)).toEqual(['f2']);
    expect(getRewrites(db, { since: new Date(Date.now() - 60_000) })).toHaveLength(2);
    expect(getRewrites(db, { since: new Date(Date.now() + 60_000) })).toHaveLength(0);
    expect(getRewrites(db, { limit: 1 })).toHaveLength(1);
    const s = getRewriteSummary(db);
    expect(s.byHarness).toEqual({ 'claude-code': 1, hermes: 1 });
    expect(s.byChangedKey).toEqual({ 'message.content': 2 });
    expect(s.maxTailDistance).toBe(0);
  });
});

describe('classify', () => {
  it('names top-level keys, opens message one level, and calls a non-JSON side raw', () => {
    const a = digestLine(JSON.stringify({ type: 'assistant', uuid: '1', message: { role: 'assistant', content: 'x', usage: { a: 1 } }, cwd: '/a' }));
    const b = digestLine(JSON.stringify({ uuid: '1', type: 'assistant', message: { usage: { a: 1 }, content: 'y', role: 'assistant' }, cwd: '/b', extra: 1 }));
    expect(classify(a, b)).toEqual({
      changed_keys: ['cwd', 'extra', 'message.content'], content_changed: 1, before_type: 'assistant', after_type: 'assistant',
    });
    expect(classify(a, a)).toMatchObject({ changed_keys: [], content_changed: 0 });
    expect(classify(a, digestLine('not json'))).toEqual({ changed_keys: ['raw'], content_changed: 0, before_type: 'assistant', after_type: null });
    expect(classify(digestLine('{"content":"a"}'), digestLine('{"content":"b"}'))).toMatchObject({ changed_keys: ['content'], content_changed: 1, before_type: null });
  });
});
