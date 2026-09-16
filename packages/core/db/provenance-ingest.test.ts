import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createTestDb } from '../test/db-helper';

let db = createTestDb();
vi.mock('./schema', () => ({
  getDb: () => db,
  UNFIREHOSE_DIR: '/tmp/unfirehose-test',
}));

const { ingestJsonlSource, ingestJsonlLines } = await import('./ingest');
const { getSessionChain, getChainSummary, SessionChainTracker } = await import('./provenance-ingest');

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
      const row = getSessionChain(db, v.label.replace(/\W/g, '_'))!;
      expect(row, v.label).not.toBeNull();
      expect(row.state, v.label).toBe(v.expect.state);
      expect(row.breaks, v.label).toBe(v.expect.breaks);
      expect(row.first_break, v.label).toBe(v.expect.first_break);
      expect(row.first_break_reason, v.label).toBe(v.expect.first_break_reason);
      expect(row.root_computed, v.label).toBe(v.expect.root_computed);
      expect(row.entries, v.label).toBe(v.expect.entries);
    }
    const summary = getChainSummary(db);
    expect(summary.verified + summary.open + summary.unchained + summary.corrupted).toBe(vectors.length);
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
    expect(getSessionChain(db, 'legacy')!.state).toBe('unchained');
    const nulls = db.prepare(
      `SELECT COUNT(*) AS c FROM messages m JOIN sessions s ON s.id = m.session_id
        WHERE s.session_uuid = 'legacy' AND m.row_hash IS NOT NULL`,
    ).get() as { c: number };
    expect(nulls.c).toBe(0);
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
