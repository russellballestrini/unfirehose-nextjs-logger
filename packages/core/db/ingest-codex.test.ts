import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import path from 'path';
import { createTestDb } from '../test/db-helper';
import { FIXTURES, CLAUDE_FIXTURE_SESSION, blockShape, claudeFixtureLines, sessionTexts, sessionTokens } from '../test/harness-shape';

let db = createTestDb();
vi.mock('./schema', () => ({ getDb: () => db, UNFIREHOSE_DIR: '/tmp/unfirehose-test' }));

const { ingestForeignSource } = await import('./ingest-foreign');
const { ingestJsonlLines } = await import('./ingest');

const SESSION = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const REL = path.join('2026', '10', '20', `rollout-2026-10-20T09-15-02-${SESSION}.jsonl`);

function codexHome() {
  const dir = mkdtempSync(path.join(tmpdir(), 'uf-codex-'));
  cpSync(path.join(FIXTURES, 'codex'), dir, { recursive: true });
  const root = path.join(dir, 'sessions');
  return { dir, root, file: path.join(root, REL) };
}
const source = (root: string) => ({ harness: 'codex', format: 'codex-rollout' as const, root });

beforeEach(() => { db = createTestDb(); });

describe('Codex rollouts read in place', () => {
  it('land the same rows a Claude Code session of the same turn does', () => {
    ingestJsonlLines(db, claudeFixtureLines(), '-home-demo-git-demo-api', CLAUDE_FIXTURE_SESSION);
    const c = codexHome();
    try {
      const counts = ingestForeignSource(db, source(c.root));
      expect(counts).toMatchObject({ sessionsAdded: 1, projectsAdded: 1, filesScanned: 1 });
      // Codex records the environment it was started in as a user message
      // of its own; the turn after it is block for block Claude Code's.
      const texts = sessionTexts(db, SESSION);
      expect(texts[0].startsWith('<environment_context>')).toBe(true);
      expect(blockShape(db, SESSION).slice(1)).toEqual(blockShape(db, CLAUDE_FIXTURE_SESSION));
      expect(texts.slice(1)).toEqual(sessionTexts(db, CLAUDE_FIXTURE_SESSION));
      // Cumulative counters become per-call deltas, cached input apart; a repeat adds nothing.
      expect(sessionTokens(db, SESSION)).toEqual(sessionTokens(db, CLAUDE_FIXTURE_SESSION));
      const session = db.prepare(`SELECT s.harness, s.git_branch, s.created_at, s.cli_version, p.name, p.path
                                    FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.session_uuid = ?`).get(SESSION);
      expect(session).toEqual({
        harness: 'codex', git_branch: 'main', created_at: '2026-10-20T09:15:02.000Z', cli_version: 'codex 0.154.0',
        name: 'codex:-home-demo-git-demo-api', path: '/home/demo/git/demo-api',
      });
      const models = db.prepare(`SELECT DISTINCT model FROM messages m JOIN sessions s ON s.id = m.session_id
                                  WHERE s.session_uuid = ? AND m.type = 'assistant'`).all(SESSION);
      expect(models).toEqual([{ model: 'gpt-5-codex' }]);
      // Encrypted reasoning never reaches our rows.
      expect(JSON.stringify(db.prepare('SELECT text_content FROM content_blocks').all())).not.toContain('gAAAA');
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  });

  it('keeps the ids the codex bridge gave the same lines, so switching readers adds no duplicates', () => {
    const c = codexHome();
    try {
      ingestForeignSource(db, source(c.root));
      const key = createHash('sha256').update(c.file).digest('hex');
      const ids = db.prepare(`SELECT message_uuid FROM messages ORDER BY id`).all() as Array<{ message_uuid: string }>;
      const text = readFileSync(c.file, 'utf8');
      const lineStarts = new Set([0, ...[...text.matchAll(/\n/g)].map((m) => m.index! + 1)]);
      for (const { message_uuid } of ids) {
        const [prefix, k, offset] = message_uuid.split(':');
        expect(prefix).toBe('codex');
        expect(k).toBe(key);
        expect(lineStarts.has(Number(offset))).toBe(true);
      }
      // Ingesting again — or rows a bridge already landed under those ids — inserts nothing.
      db.prepare('DELETE FROM ingest_offsets').run();
      expect(ingestForeignSource(db, source(c.root)).messagesAdded).toBe(0);
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  });

  it('resumes from its byte offset with its state, and waits out a partial line', () => {
    const c = codexHome();
    try {
      const full = readFileSync(c.file, 'utf8');
      const lines = full.trim().split('\n');
      // Stop mid-way through the tool's output line.
      const cut = lines.slice(0, 9).join('\n').length + 1 + 20;
      writeFileSync(c.file, full.slice(0, cut));
      const first = ingestForeignSource(db, source(c.root));
      expect(first.messagesAdded).toBeGreaterThan(0);
      const offset = (db.prepare('SELECT byte_offset FROM ingest_offsets WHERE file_path = ?').get(c.file) as { byte_offset: number }).byte_offset;
      expect(full[offset - 1]).toBe('\n');
      expect(offset).toBeLessThan(cut);
      expect(ingestForeignSource(db, source(c.root)).messagesAdded).toBe(0);

      appendFileSync(c.file, full.slice(cut));
      const second = ingestForeignSource(db, source(c.root));
      expect(second.sessionsAdded).toBe(0);
      // The model (from turn_context, before the cut) and the token counters carried over.
      expect(sessionTokens(db, SESSION)).toEqual({ input: 2600, output: 140, cacheRead: 6200 });
      const last = db.prepare(`SELECT model FROM messages WHERE type = 'assistant' ORDER BY id DESC LIMIT 1`).get();
      expect(last).toEqual({ model: 'gpt-5-codex' });
      expect(ingestForeignSource(db, source(c.root)).filesScanned).toBe(0);
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  });
});
