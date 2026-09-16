import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createTestDb } from '../test/db-helper';

let db = createTestDb();
vi.mock('./schema', () => ({
  getDb: () => db,
  UNFIREHOSE_DIR: '/tmp/unfirehose-test',
}));

const { ingestJsonlSource, ingestJsonlLines } = await import('./ingest');
const { getSessionChain, getChainSummary, SessionChainTracker, auditAnchor, auditAnchors, backfillWitness } = await import('./provenance-ingest');

/**
 * The chain verdict a session lands with, driven through the REAL
 * ingest loop against files on disk — offsets, batches, partial tails
 * and all — using the vectors the Python writer generated. The unit
 * tests in ../provenance.test.ts prove the verifier; these prove the
 * ingester keeps what the verifier found instead of dropping it.
 */
const KAT = path.resolve(__dirname, '../../schema/fixtures/chain-kat.jsonl');
const vectors: any[] = readFileSync(KAT, 'utf8')
  .split('\n')
  .filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => JSON.parse(l))
  .filter((r) => r.kind === 'session');
const vector = (label: string) => vectors.find((v) => v.label === label)!;

let root: string;
const SLUG = '-tmp-provenance-proj';

function writeSession(uuid: string, lines: string[], opts: { trailingNewline?: boolean } = {}) {
  const dir = path.join(root, SLUG);
  mkdirSync(dir, { recursive: true });
  const body = lines.join('\n') + (opts.trailingNewline === false ? '' : '\n');
  writeFileSync(path.join(dir, `${uuid}.jsonl`), body);
}

const source = () => ({
  name: 'uncloseai',
  root,
  projectDir: (slug: string) => path.join(root, slug),
  toMessage: (entry: any) => (entry.type === 'message' ? entry : null),
});

const offsetOf = (uuid: string) =>
  (db.prepare('SELECT byte_offset AS b FROM ingest_offsets WHERE file_path = ?')
    .get(path.join(root, SLUG, `${uuid}.jsonl`)) as { b: number } | undefined)?.b;

beforeEach(() => {
  db = createTestDb();
  root = mkdtempSync(path.join(tmpdir(), 'unfirehose-prov-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('chain verification through the file ingest loop', () => {
  it('every fixture session lands with the verdict the writer expects', async () => {
    for (const v of vectors) writeSession(v.label.replace(/\W/g, '_'), v.lines);
    await ingestJsonlSource(db, source());
    for (const v of vectors) {
      const row = getSessionChain(db, v.label.replace(/\W/g, '_'));
      if (v.expect.state === 'unchained') {
        // Left to the quiescent backfill: a writer we do not own may still be rewriting.
        expect(row, v.label).toBeNull();
        continue;
      }
      expect(row, v.label).not.toBeNull();
      if (!row) continue;
      expect(row.state, v.label).toBe(v.expect.state);
      expect(row.breaks, v.label).toBe(v.expect.breaks);
      expect(row.first_break, v.label).toBe(v.expect.first_break);
      expect(row.first_break_reason, v.label).toBe(v.expect.first_break_reason);
      expect(row.root_computed, v.label).toBe(v.expect.root_computed);
      expect(row.entries, v.label).toBe(v.expect.entries);
    }
    const summary = getChainSummary(db);
    expect(summary.verified + summary.open + summary.corrupted)
      .toBe(vectors.filter((v) => v.expect.state !== 'unchained').length);
    expect(summary.corrupted).toBeGreaterThan(0);
    expect(summary.verified).toBeGreaterThan(0);
  });

  it('an incremental pass continues the chain instead of restarting it', async () => {
    const v = vector('verified/n=8');
    writeSession('inc', v.lines.slice(0, 4));
    await ingestJsonlSource(db, source());
    expect(getSessionChain(db, 'inc')!.state).toBe('open');
    expect(getSessionChain(db, 'inc')!.entries).toBe(4);

    appendFileSync(path.join(root, SLUG, 'inc.jsonl'), v.lines.slice(4).join('\n') + '\n');
    await ingestJsonlSource(db, source());
    const row = getSessionChain(db, 'inc')!;
    expect(row.state).toBe('verified');
    expect(row.entries).toBe(v.lines.length);
    expect(row.root_computed).toBe(v.expect.root_expected);
    expect([row.merkle_version, row.encoding_version, row.root_semantics])
      .toEqual(['merkle-v1', 'jsonl-bytes-v1', 'SEQUENCE']);
    const leaves = db.prepare('SELECT COUNT(*) AS c FROM session_chain_leaves WHERE session_uuid = ?')
      .get('inc') as { c: number };
    expect(leaves.c).toBe(v.lines.length);
  });

  it('a partial tail is held back, the offset stops before it, and the next pass completes it', async () => {
    const v = vector('verified/n=3');
    const last = v.lines[v.lines.length - 1];
    const cut = last.slice(0, 20);
    writeSession('partial', [...v.lines.slice(0, -1), cut], { trailingNewline: false });
    await ingestJsonlSource(db, source());
    const mid = getSessionChain(db, 'partial')!;
    expect(mid.breaks).toBe(0);                                 // an unwritten line is not a break
    expect(mid.entries).toBe(v.lines.length - 1);
    const full = v.lines.slice(0, -1).join('\n') + '\n';
    expect(offsetOf('partial')).toBe(Buffer.byteLength(full));  // stops BEFORE the fragment

    appendFileSync(path.join(root, SLUG, 'partial.jsonl'), last.slice(20) + '\n');
    await ingestJsonlSource(db, source());
    const done = getSessionChain(db, 'partial')!;
    expect(done.state).toBe('verified');
    expect(done.entries).toBe(v.lines.length);
  });

  it('messages carry the row hash their session root commits to', async () => {
    const v = vector('verified/n=3');
    writeSession('rows', v.lines);
    await ingestJsonlSource(db, source());
    const hashes = (db.prepare(
      `SELECT m.row_hash AS h FROM messages m JOIN sessions s ON s.id = m.session_id
        WHERE s.session_uuid = 'rows' ORDER BY m.id`,
    ).all() as { h: string | null }[]).map((r) => r.h);
    expect(hashes.length).toBeGreaterThan(0);
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
    const leaves = (db.prepare('SELECT hash FROM session_chain_leaves WHERE session_uuid = ? ORDER BY seq')
      .all('rows') as { hash: string }[]).map((r) => r.hash);
    for (const h of hashes) expect(leaves).toContain(h);
  });

  it('an unchained legacy journal is unchained, not corrupted, and its messages have no hash', async () => {
    const v = vector('unchained/legacy-writer');
    writeSession('legacy', v.lines);
    await ingestJsonlSource(db, source());
    expect(getSessionChain(db, 'legacy')).toBeNull();           // recorded later, by the backfill
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(path.join(root, SLUG, 'legacy.jsonl'), old, old);
    backfillWitness(db, 10, (_p, id) => path.join(root, SLUG, `${id}.jsonl`));
    expect(getSessionChain(db, 'legacy')!.state).toBe('unchained');
    const nulls = db.prepare(
      `SELECT COUNT(*) AS c FROM messages m JOIN sessions s ON s.id = m.session_id
        WHERE s.session_uuid = 'legacy' AND m.row_hash IS NOT NULL`,
    ).get() as { c: number };
    expect(nulls.c).toBe(0);
  });
});

describe('the witness: anchor audit against the leaves recorded at ingest', () => {
  it('a journal left alone is intact, even after it grows', async () => {
    const v = vector('verified/n=5');
    writeSession('w1', v.lines.slice(0, 4));
    await ingestJsonlSource(db, source());
    expect(auditAnchor(db, 'w1')).toBe('intact');
    appendFileSync(path.join(root, SLUG, 'w1.jsonl'), v.lines.slice(4).join('\n') + '\n');
    expect(auditAnchor(db, 'w1')).toBe('intact');            // grown, prefix unchanged
    const row = getSessionChain(db, 'w1')!;
    expect(row.anchor_state).toBe('intact');
    expect(row.anchor_checked_at).toBeTruthy();
    expect(row.file_path).toBe(path.join(root, SLUG, 'w1.jsonl'));
  });

  it('a re-hashed rewrite verifies internally and is still caught by the witness', async () => {
    const v = vector('verified/n=3');
    writeSession('w2', v.lines);
    await ingestJsonlSource(db, source());
    expect(getSessionChain(db, 'w2')!.state).toBe('verified');
    // The forger rewrites the whole file with a different, internally
    // consistent chain — the other fixture session, fully verified.
    const forged = vector('verified/n=2');
    writeSession('w2', forged.lines);
    expect(auditAnchor(db, 'w2')).toBe('rewritten');
    const row = getSessionChain(db, 'w2')!;
    expect(row.anchor_detail).toMatch(/leaf \d+ differs/);   // the two fixtures share a header, so the split is later
    // A fresh reader of the forged file alone would call it verified.
    const { verifyLines } = await import('../provenance');
    expect(verifyLines(forged.lines).state).toBe('verified');
  });

  it('a truncated journal and a deleted one are named as such', async () => {
    const v = vector('verified/n=5');
    writeSession('w3', v.lines);
    await ingestJsonlSource(db, source());
    writeSession('w3', v.lines.slice(0, 2));
    expect(auditAnchor(db, 'w3')).toBe('rewritten');
    expect(getSessionChain(db, 'w3')!.anchor_detail).toContain('witness recorded');
    rmSync(path.join(root, SLUG, 'w3.jsonl'));
    expect(auditAnchor(db, 'w3')).toBe('missing');
  });

  it('a bounded pass checks the least recently checked first and runs after ingest', async () => {
    for (const n of ['a1', 'a2', 'a3']) writeSession(n, vector('verified/n=2').lines);
    await ingestJsonlSource(db, source());          // ingestJsonlSource alone does not audit
    expect(getSessionChain(db, 'a1')!.anchor_state).toBeNull();
    const first = auditAnchors(db, 2);
    expect(first.intact).toBe(2);
    const second = auditAnchors(db, 2);
    expect(second.intact).toBe(2);
    const checked = ['a1', 'a2', 'a3'].filter((n) => getSessionChain(db, n)!.anchor_state === 'intact');
    expect(checked).toHaveLength(3);                 // the never-checked one came first in pass two
  });

  it('a row recorded before file_path existed resolves its journal through the project', async () => {
    const v = vector('verified/n=2');
    writeSession('old1', v.lines);
    await ingestJsonlSource(db, source());
    db.prepare('UPDATE session_chain SET file_path = NULL WHERE session_uuid = ?').run('old1');
    // The project row this session belongs to names the harness and slug.
    const proj = db.prepare('SELECT p.name FROM projects p JOIN sessions s ON s.project_id = p.id WHERE s.session_uuid = ?')
      .get('old1') as { name: string };
    expect(proj.name).toBe(`uncloseai:${SLUG}`);
    const { resolveSessionFile } = await import('../session-paths');
    const expected = resolveSessionFile(proj.name, 'old1');
    // The generic native adapter resolves to ~/.uncloseai/…; the test root is elsewhere,
    // so only the resolution itself is asserted here, and the audit reads it as missing.
    auditAnchors(db, 50, resolveSessionFile);
    const row = getSessionChain(db, 'old1')!;
    expect(row.file_path).toBe(expected);
    expect(['intact', 'missing']).toContain(row.anchor_state);
  });

  it('an unchained journal is witnessed too: a Claude Code transcript gets tamper-evidence since ingest', async () => {
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'add a test' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
    ];
    writeSession('cc', lines);
    await ingestJsonlSource(db, { ...source(), toMessage: (e: any) => (e.type === 'user' || e.type === 'assistant' ? { type: 'message', role: e.type, content: [] } : null) });
    // Ingest records nothing for an unchained journal still being written;
    // the backfill takes it once the writer has been quiet for a while.
    expect(getSessionChain(db, 'cc')).toBeNull();
    const file = path.join(root, SLUG, 'cc.jsonl');
    const resolve = (_p: string, id: string) => path.join(root, SLUG, `${id}.jsonl`);
    expect(backfillWitness(db, 10, resolve)).toBe(0);            // too fresh
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(file, old, old);
    expect(backfillWitness(db, 10, resolve)).toBe(1);
    expect(getSessionChain(db, 'cc')!.state).toBe('unchained');
    expect(auditAnchor(db, 'cc')).toBe('intact');
    const kinds = db.prepare("SELECT kind, COUNT(*) AS c FROM session_chain_leaves WHERE session_uuid = 'cc' GROUP BY kind").all();
    expect(kinds).toEqual([{ kind: 'line', c: 2 }]);
    // The agent edits its own transcript after the fact. While the file is
    // fresh again the witness withholds judgement; once quiet, it rules.
    writeSession('cc', [lines[0], JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'all tests pass' }] } })]);
    expect(auditAnchor(db, 'cc')).toBeNull();
    utimesSync(file, old, old);
    expect(auditAnchor(db, 'cc')).toBe('rewritten');
    expect(getSessionChain(db, 'cc')!.anchor_detail).toBe('leaf 1 differs from what was recorded at ingest');
  });

  it('a session ingested before the witness existed is read once and brought under it', async () => {
    const v = vector('verified/n=3');
    writeSession('pre', v.lines);
    await ingestJsonlSource(db, source());
    db.prepare('DELETE FROM session_chain WHERE session_uuid = ?').run('pre');
    db.prepare('DELETE FROM session_chain_leaves WHERE session_uuid = ?').run('pre');
    const resolve = (_p: string, id: string) => path.join(root, SLUG, `${id}.jsonl`);
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(path.join(root, SLUG, 'pre.jsonl'), old, old);
    expect(backfillWitness(db, 10, resolve)).toBe(1);
    const row = getSessionChain(db, 'pre')!;
    expect(row.state).toBe('verified');                       // chained: the full verdict comes back
    expect(row.entries).toBe(v.lines.length);
    expect(auditAnchor(db, 'pre')).toBe('intact');
    expect(backfillWitness(db, 10, resolve)).toBe(0);         // nothing left to bring in
    // Messages were not re-inserted: the count is what ingest left (three
    // messages plus the session_end system row), unchanged by the backfill.
    const count = () => (db.prepare('SELECT COUNT(*) AS c FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.session_uuid = ?').get('pre') as { c: number }).c;
    const before = count();
    db.prepare('DELETE FROM session_chain WHERE session_uuid = ?').run('pre');
    backfillWitness(db, 10, resolve);
    expect(count()).toBe(before);
  });

  it('a pre-witness session whose journal is gone gets a row so it is not retried', async () => {
    const proj = db.prepare("SELECT id FROM projects LIMIT 1").get() as { id: number } | undefined;
    const pid = proj?.id ?? (db.prepare("INSERT INTO projects (name, display_name) VALUES ('p', 'p')").run().lastInsertRowid as number);
    db.prepare("INSERT INTO sessions (session_uuid, project_id) VALUES ('gone', ?)").run(pid);
    expect(backfillWitness(db, 10, () => path.join(root, 'nope.jsonl'))).toBe(1);
    expect(getSessionChain(db, 'gone')!.state).toBe('unchained');
    expect(backfillWitness(db, 10, () => path.join(root, 'nope.jsonl'))).toBe(0);
  });

  it('joining a file mid-way with no record of its head records nothing; the backfill takes it from byte 0', async () => {
    const v = vector('verified/n=5');
    writeSession('mid', v.lines);
    // Pretend the first half was ingested before the witness existed: an
    // offset past line 3, no session_chain row.
    const file = path.join(root, SLUG, 'mid.jsonl');
    const half = v.lines.slice(0, 3).join('\n') + '\n';
    db.prepare(`INSERT INTO ingest_offsets (file_path, byte_offset, last_ingested) VALUES (?, ?, datetime('now'))`)
      .run(file, Buffer.byteLength(half));
    await ingestJsonlSource(db, source());
    expect(getSessionChain(db, 'mid')).toBeNull();               // deferred, not misnumbered
    const resolve = (_p: string, id: string) => path.join(root, SLUG, `${id}.jsonl`);
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(file, old, old);
    expect(backfillWitness(db, 10, resolve)).toBeGreaterThanOrEqual(1);
    const row = getSessionChain(db, 'mid')!;
    expect(row.entries).toBe(v.lines.length);
    expect(auditAnchor(db, 'mid')).toBe('intact');
  });

  it('an empty session row has nothing to witness', async () => {
    const t = new SessionChainTracker(db, 'empty', { reset: true, filePath: '/nowhere' });
    t.flush();
    expect(auditAnchor(db, 'empty')).toBeNull();
  });
});

describe('chain verification through the cloud batch path', () => {
  it('batches continue one chain and reach the writer’s verdict', () => {
    const v = vector('verified/n=5');
    ingestJsonlLines(db, v.lines.slice(0, 3), 'proj', 'cloud-sess');
    expect(getSessionChain(db, 'cloud-sess')!.state).toBe('open');
    ingestJsonlLines(db, v.lines.slice(3), 'proj', 'cloud-sess');
    const row = getSessionChain(db, 'cloud-sess')!;
    expect(row.state).toBe('verified');
    expect(row.root_computed).toBe(v.expect.root_expected);
  });

  it('a corrupted batch is named by line index and reason', () => {
    const v = vector('corrupted/edited-body');
    ingestJsonlLines(db, v.lines, 'proj', 'cloud-bad');
    const row = getSessionChain(db, 'cloud-bad')!;
    expect(row.state).toBe('corrupted');
    expect([row.first_break, row.first_break_reason]).toEqual([v.expect.first_break, v.expect.first_break_reason]);
  });
});

describe('SessionChainTracker', () => {
  it('reset discards a prior reading; continue resumes it', () => {
    const v = vector('verified/n=2');
    const a = new SessionChainTracker(db, 't', { reset: true });
    for (const l of v.lines.slice(0, 2)) a.feed(l);
    a.flush();
    expect(getSessionChain(db, 't')!.entries).toBe(2);

    const b = new SessionChainTracker(db, 't');
    for (const l of v.lines.slice(2)) b.feed(l);
    b.flush();
    expect(getSessionChain(db, 't')!.state).toBe('verified');

    const c = new SessionChainTracker(db, 't', { reset: true });
    expect(getSessionChain(db, 't')).toBeNull();
    c.flush();                                  // nothing fed: nothing written
    expect(getSessionChain(db, 't')).toBeNull();
  });
});
