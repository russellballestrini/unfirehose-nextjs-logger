import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cpSync, mkdtempSync, rmSync, appendFileSync, utimesSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import path from 'path';
import { createTestDb } from '../test/db-helper';
import { FIXTURES, CLAUDE_FIXTURE_SESSION, blockShape, claudeFixtureLines, sessionTexts, sessionTokens } from '../test/harness-shape';

let db = createTestDb();
vi.mock('./schema', () => ({ getDb: () => db, UNFIREHOSE_DIR: '/tmp/unfirehose-test' }));

const { ingestForeignSource, SETTLE_MS } = await import('./ingest-foreign');
const { ingestJsonlLines } = await import('./ingest');

const SESSION = '3f6c2a1e-8b7d-4e5f-9a0b-1c2d3e4f5a6b';
const LATER = Date.now() + 10 * 60_000;

/** A copy of the fixture's ~/.gemini, so a test can append to it. */
function geminiHome() {
  const dir = mkdtempSync(path.join(tmpdir(), 'uf-gemini-'));
  cpSync(path.join(FIXTURES, 'gemini-cli'), dir, { recursive: true });
  return { dir, root: path.join(dir, 'tmp'), file: path.join(dir, 'tmp', 'demo-api', 'chats', 'session-2026-10-20T09-15-3f6c2a1e.jsonl') };
}
const source = (root: string) => ({ harness: 'gemini-cli', format: 'gemini-chat' as const, root });

beforeEach(() => { db = createTestDb(); });

describe('Gemini CLI chat recordings', () => {
  it('land the same rows a Claude Code session of the same turn does', () => {
    ingestJsonlLines(db, claudeFixtureLines(), '-home-demo-git-demo-api', CLAUDE_FIXTURE_SESSION);
    const g = geminiHome();
    try {
      const counts = ingestForeignSource(db, source(g.root), { now: LATER });
      expect(counts).toMatchObject({ sessionsAdded: 1, projectsAdded: 1, filesScanned: 1, messagesAdded: 4, blocksAdded: 6 });
      expect(blockShape(db, SESSION)).toEqual(blockShape(db, CLAUDE_FIXTURE_SESSION));
      expect(sessionTexts(db, SESSION)).toEqual(sessionTexts(db, CLAUDE_FIXTURE_SESSION).map((t) =>
        t === 'Find the orders route first.' ? 'Locating the route: Find the orders route first.' : t));

      const session = db.prepare(`SELECT s.harness, s.created_at, s.first_prompt, s.is_sidechain, p.name, p.path
                                    FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.session_uuid = ?`).get(SESSION);
      // cwd from the project dir's .project_root marker.
      expect(session).toEqual({
        harness: 'gemini-cli', created_at: '2026-10-20T09:15:02.000Z', first_prompt: 'Add pagination to orders',
        is_sidechain: 0, name: 'gemini-cli:-home-demo-git-demo-api', path: '/home/demo/git/demo-api',
      });
      // The last copy of a re-recorded message wins: its tokens, tool call and patched result.
      const call = db.prepare(`SELECT tool_name, tool_input, tool_use_id FROM content_blocks WHERE block_type = 'tool-call'
                                 AND message_id IN (SELECT id FROM messages WHERE message_uuid = 'b7e0c1d2-0000-4000-8000-000000000002')`).get();
      expect(call).toEqual({ tool_name: 'run_shell_command', tool_input: JSON.stringify({ command: 'grep -rn orders src/routes.ts', description: 'Find the orders route' }), tool_use_id: 'run_shell_command-1792487709000-a1b2c3' });
      const result = db.prepare(`SELECT cb.text_content, cb.is_error FROM content_blocks cb JOIN messages m ON m.id = cb.message_id
                                   JOIN sessions s ON s.id = m.session_id WHERE cb.block_type = 'tool-result' AND s.session_uuid = ?`).all(SESSION);
      expect(result).toEqual([{ text_content: "src/routes.ts:12: router.get('/orders', listOrders)", is_error: 0 }]);
      // Prompt counts include the cached tokens; thoughts bill as output.
      expect(sessionTokens(db, SESSION)).toEqual(sessionTokens(db, CLAUDE_FIXTURE_SESSION));
      expect(db.prepare(`SELECT DISTINCT model FROM messages m JOIN sessions s ON s.id = m.session_id
                          WHERE s.session_uuid = ? AND m.type = 'assistant'`).all(SESSION)).toEqual([{ model: 'gemini-2.5-pro' }]);
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  });

  it('skips an unchanged recording, and takes only what was appended since', () => {
    const g = geminiHome();
    try {
      ingestForeignSource(db, source(g.root), { now: LATER });
      expect(ingestForeignSource(db, source(g.root), { now: LATER }).filesScanned).toBe(0);
      appendFileSync(g.file, JSON.stringify({ id: 'b7e0c1d2-0000-4000-8000-000000000004', timestamp: '2026-10-20T09:16:00.000Z', type: 'user', content: [{ text: 'Now add a test' }] }) + '\n');
      const again = ingestForeignSource(db, source(g.root), { now: LATER });
      expect(again).toMatchObject({ filesScanned: 1, messagesAdded: 1, sessionsAdded: 0 });
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  });

  it('holds back the newest message while the file is still being written', () => {
    const g = geminiHome();
    try {
      const mtime = statSync(g.file).mtimeMs;
      const early = ingestForeignSource(db, source(g.root), { now: mtime + 1000 });
      // Everything but the final reply, which may still gain tokens.
      expect(early.messagesAdded).toBe(3);
      const settled = ingestForeignSource(db, source(g.root), { now: mtime + SETTLE_MS + 1000 });
      expect(settled.messagesAdded).toBe(1);
      expect(ingestForeignSource(db, source(g.root), { now: mtime + SETTLE_MS + 2000 }).filesScanned).toBe(0);
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  });

  it('reads a legacy whole-file recording, a hashed project dir and a subagent', () => {
    const g = geminiHome();
    try {
      // A legacy dir named sha256(projectRoot) resolves through a project we already know.
      db.prepare(`INSERT INTO projects (name, display_name, path) VALUES ('-home-demo-git-old', 'old', '/home/demo/git/old')`).run();
      const real = createHash('sha256').update('/home/demo/git/old').digest('hex');
      const chats = path.join(g.root, real, 'chats');
      mkdirSync(path.join(chats, SESSION), { recursive: true });
      writeFileSync(path.join(chats, 'session-2025-08-01T10-00-aaaabbbb.json'), JSON.stringify({
        sessionId: 'aaaabbbb-0000-4000-8000-000000000000', projectHash: real, startTime: '2025-08-01T10:00:00.000Z',
        lastUpdated: '2025-08-01T10:01:00.000Z', messages: [
          { id: 'legacy-1', timestamp: '2025-08-01T10:00:00.000Z', type: 'user', content: 'hello' },
          { id: 'legacy-2', timestamp: '2025-08-01T10:00:05.000Z', type: 'gemini', content: 'hi', model: 'gemini-2.5-flash', tokens: { input: 10, output: 2, cached: 0, total: 12 } },
        ],
      }));
      writeFileSync(path.join(chats, SESSION, 'cccc0000-0000-4000-8000-000000000000.jsonl'),
        JSON.stringify({ sessionId: 'cccc0000-0000-4000-8000-000000000000', projectHash: real, startTime: '2026-10-20T09:15:30.000Z', kind: 'subagent' }) + '\n'
        + JSON.stringify({ id: 'sub-1', timestamp: '2026-10-20T09:15:30.000Z', type: 'user', content: [{ text: 'Investigate the route' }] }) + '\n');
      const old = (Date.now() - 3600_000) / 1000;
      utimesSync(path.join(chats, 'session-2025-08-01T10-00-aaaabbbb.json'), old, old);
      ingestForeignSource(db, source(g.root), { now: LATER });
      const legacy = db.prepare(`SELECT p.name, p.path, COUNT(m.id) AS n FROM sessions s JOIN projects p ON p.id = s.project_id
                                   JOIN messages m ON m.session_id = s.id WHERE s.session_uuid = ?`).get('aaaabbbb-0000-4000-8000-000000000000');
      expect(legacy).toEqual({ name: 'gemini-cli:-home-demo-git-old', path: '/home/demo/git/old', n: 2 });
      const sub = db.prepare(`SELECT is_sidechain, delegated_from FROM sessions WHERE session_uuid = ?`).get('cccc0000-0000-4000-8000-000000000000');
      expect(sub).toEqual({ is_sidechain: 1, delegated_from: SESSION });
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  });
});
