import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createTestDb } from '../test/db-helper';
import { FIXTURES, CLAUDE_FIXTURE_SESSION, blockShape, claudeFixtureLines, sessionTexts, sessionTokens } from '../test/harness-shape';

let db = createTestDb();
vi.mock('./schema', () => ({ getDb: () => db, UNFIREHOSE_DIR: '/tmp/unfirehose-test' }));

const { ingestForeignSource } = await import('./ingest-foreign');
const { ingestJsonlLines } = await import('./ingest');

const SESSION = '5e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b';
const LATER = Date.now() + 10 * 60_000;

function continueHome() {
  const dir = mkdtempSync(path.join(tmpdir(), 'uf-continue-'));
  cpSync(path.join(FIXTURES, 'continue'), dir, { recursive: true });
  const root = path.join(dir, 'sessions');
  return { dir, root, file: path.join(root, `${SESSION}.json`) };
}
const source = (root: string) => ({ harness: 'continue', format: 'continue-session' as const, root });

beforeEach(() => { db = createTestDb(); });

describe('Continue sessions', () => {
  it('land the same rows a Claude Code session of the same turn does', () => {
    ingestJsonlLines(db, claudeFixtureLines(), '-home-demo-git-demo-api', CLAUDE_FIXTURE_SESSION);
    const c = continueHome();
    try {
      // sessions.json is the index, not a session.
      expect(ingestForeignSource(db, source(c.root), { now: LATER })).toMatchObject({ filesScanned: 1, sessionsAdded: 1, messagesAdded: 4 });
      expect(blockShape(db, SESSION)).toEqual(blockShape(db, CLAUDE_FIXTURE_SESSION));
      expect(sessionTexts(db, SESSION)).toEqual(sessionTexts(db, CLAUDE_FIXTURE_SESSION));
      expect(sessionTokens(db, SESSION)).toEqual(sessionTokens(db, CLAUDE_FIXTURE_SESSION));
      // A result recorded both as a tool message and on the call's state lands once.
      expect(db.prepare(`SELECT COUNT(*) AS n FROM content_blocks WHERE block_type = 'tool-result' AND tool_use_id = 'toolu_c1'`).get()).toEqual({ n: 1 });
      const session = db.prepare(`SELECT s.harness, s.created_at, s.first_prompt, p.name, p.path
                                    FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.session_uuid = ?`).get(SESSION);
      // workspaceDirectory is a file:// URI; dateCreated is epoch ms from sessions.json.
      expect(session).toEqual({
        harness: 'continue', created_at: '2026-10-20T09:15:02.000Z', first_prompt: 'Add pagination to the /orders endpoint',
        name: 'continue:-home-demo-git-demo-web', path: '/home/demo/git/demo-web',
      });
      const stamps = db.prepare(`SELECT m.timestamp, m.model FROM messages m JOIN sessions s ON s.id = m.session_id
                                   WHERE s.session_uuid = ? ORDER BY m.id`).all(SESSION) as Array<{ timestamp: string; model: string | null }>;
      // No message carries a time of its own: they never run backwards, and reasoning times are used where present.
      expect(stamps.map((r) => r.timestamp)).toEqual([...stamps.map((r) => r.timestamp)].sort());
      expect(stamps[1].timestamp).toBe('2026-10-20T09:15:05.000Z');
      expect(stamps.filter((r) => r.model).map((r) => r.model)).toEqual(['Claude Sonnet 4.5', 'Claude Sonnet 4.5']);
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  });

  it('re-reads a rewritten session only when its size or mtime moved, and keeps the turns it had', () => {
    const c = continueHome();
    try {
      ingestForeignSource(db, source(c.root), { now: LATER });
      expect(ingestForeignSource(db, source(c.root), { now: LATER }).filesScanned).toBe(0);
      const s = JSON.parse(readFileSync(c.file, 'utf8'));
      s.history.push({ message: { role: 'user', content: 'Now add a test' }, contextItems: [] });
      s.history.push({ message: { role: 'assistant', content: 'Added.' }, contextItems: [] });
      writeFileSync(c.file, JSON.stringify(s));
      const old = (Date.now() - 3600_000) / 1000;
      utimesSync(c.file, old, old);
      expect(ingestForeignSource(db, source(c.root), { now: LATER })).toMatchObject({ filesScanned: 1, messagesAdded: 2, sessionsAdded: 0 });
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  });

  it('waits on the newest turn of a file written moments ago', () => {
    const c = continueHome();
    try {
      const now = Date.now();
      utimesSync(c.file, now / 1000, now / 1000);
      expect(ingestForeignSource(db, source(c.root), { now }).messagesAdded).toBe(3);
      expect(ingestForeignSource(db, source(c.root), { now: now + 60_000 }).messagesAdded).toBe(1);
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  });
});
