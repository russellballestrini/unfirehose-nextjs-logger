import { describe, it, expect, vi, beforeEach } from 'vitest';
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createTestDb } from '../test/db-helper';
import { FIXTURES } from '../test/harness-shape';

let db = createTestDb();
vi.mock('./schema', () => ({ getDb: () => db, UNFIREHOSE_DIR: '/tmp/unfirehose-test' }));

const { ingestForeignSource, foreignSources } = await import('./ingest-foreign');
const { knownProjectRoots } = await import('./project-roots');

const LATER = Date.now() + 10 * 60_000;
const local = (...a: [number, number, number, number, number, number, number?]) =>
  new Date(a[0], a[1] - 1, a[2], a[3], a[4], a[5], a[6] ?? 0).toISOString();

function aiderRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'uf-aider-'));
  const root = path.join(dir, 'demo-api');
  cpSync(path.join(FIXTURES, 'aider', 'demo-api'), root, { recursive: true });
  mkdirSync(path.join(root, '.git'));
  return { dir, root, file: path.join(root, '.aider.chat.history.md') };
}
const source = (roots: string[]) => ({ harness: 'aider', format: 'aider-history' as const, root: '', roots });

interface Row { type: string; subtype: string | null; timestamp: string; model: string | null; input_tokens: number; output_tokens: number; cache_read_tokens: number; tokens_approx: number | null }
const messages = (sessionUuid: string) => db.prepare(
  `SELECT m.type, m.subtype, m.timestamp, m.model, m.input_tokens, m.output_tokens, m.cache_read_tokens, m.tokens_approx
     FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.session_uuid = ? ORDER BY m.id`,
).all(sessionUuid) as Row[];
const blocks = (sessionUuid: string) => db.prepare(
  `SELECT m.type, cb.block_type, cb.text_content, cb.tool_name, cb.tool_input, cb.tool_use_id
     FROM messages m JOIN sessions s ON s.id = m.session_id JOIN content_blocks cb ON cb.message_id = m.id
    WHERE s.session_uuid = ? ORDER BY m.id, cb.position`,
).all(sessionUuid) as Array<{ type: string; block_type: string; text_content: string | null; tool_name: string | null; tool_input: string | null; tool_use_id: string | null }>;
const sessions = () => db.prepare(
  `SELECT s.session_uuid, s.harness, s.created_at, s.first_prompt, s.cli_version, p.name, p.path
     FROM sessions s JOIN projects p ON p.id = s.project_id ORDER BY s.created_at`,
).all() as Array<{ session_uuid: string; harness: string; created_at: string; first_prompt: string | null; cli_version: string; name: string; path: string }>;

beforeEach(() => { db = createTestDb(); });

describe('Aider chat history', () => {
  it('is a foreign source with no root of its own', () => {
    expect(foreignSources().find((s) => s.harness === 'aider')).toEqual({ harness: 'aider', format: 'aider-history', root: '' });
  });

  it('lands one session per run, in the project whose root holds the log', () => {
    const a = aiderRepo();
    try {
      expect(ingestForeignSource(db, source([a.root]), { now: LATER })).toMatchObject({ filesScanned: 1, sessionsAdded: 2, projectsAdded: 1 });
      const [first, second] = sessions();
      expect(first).toMatchObject({
        harness: 'aider', created_at: local(2026, 10, 20, 9, 15, 2), first_prompt: '/add src/routes.ts',
        cli_version: 'aider 0.86.1', path: a.root, name: `aider:${a.root.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
      });
      expect(second).toMatchObject({ created_at: local(2026, 10, 21, 8, 0, 0), first_prompt: 'thanks', path: a.root });

      const rows = messages(first.session_uuid);
      expect(rows.map((r) => [r.type, r.subtype])).toEqual([
        ['system', 'aider-output'], ['user', null], ['system', 'aider-output'], ['user', null], ['assistant', null],
        ['user', null], ['system', 'aider-output'], ['user', null], ['assistant', null], ['system', 'aider-output'],
      ]);
      // Prompts take their time from .aider.input.history; the rest follow, never running backwards.
      expect(rows[1].timestamp).toBe(local(2026, 10, 20, 9, 15, 20, 100));
      expect(rows[3].timestamp).toBe(local(2026, 10, 20, 9, 15, 31, 250));
      expect(rows[4].timestamp).toBe(rows[3].timestamp);
      expect(rows.map((r) => r.timestamp)).toEqual([...rows.map((r) => r.timestamp)].sort());
      // Model from the startup announcement; counts as printed, marked approximate when rounded.
      const replies = rows.filter((r) => r.type === 'assistant');
      expect(replies).toEqual([
        expect.objectContaining({ model: 'anthropic/claude-sonnet-4-5', input_tokens: 4400, cache_read_tokens: 3200, output_tokens: 312, tokens_approx: 1 }),
        expect.objectContaining({ model: 'anthropic/claude-sonnet-4-5', input_tokens: 980, output_tokens: 64, tokens_approx: null }),
      ]);
      expect(messages(second.session_uuid).find((r) => r.type === 'assistant')).toMatchObject({ model: 'openai/gpt-5', input_tokens: 1200, output_tokens: 20, tokens_approx: 1 });
    } finally { rmSync(a.dir, { recursive: true, force: true }); }
  });

  it('reads a SEARCH/REPLACE edit as an Edit call, and its "Applied edit" line as the result', () => {
    const a = aiderRepo();
    try {
      ingestForeignSource(db, source([a.root]), { now: LATER });
      const sid = sessions()[0].session_uuid;
      const b = blocks(sid);
      const reply = b.filter((x) => x.type === 'assistant');
      expect(reply.slice(0, 3).map((x) => x.block_type)).toEqual(['text', 'tool-call', 'text']);
      expect(reply[0].text_content).toBe("I'll read `limit` and `offset` from the query.");
      expect(reply[2].text_content).toBe('The route now pages its results.');
      expect(reply[1].tool_name).toBe('Edit');
      expect(JSON.parse(reply[1].tool_input!)).toEqual({
        file_path: 'src/routes.ts', old_string: "router.get('/orders', listOrders)", new_string: "router.get('/orders', paginate(listOrders))",
      });
      const result = b.find((x) => x.block_type === 'tool-result')!;
      expect(result).toMatchObject({ type: 'user', tool_use_id: reply[1].tool_use_id, text_content: 'Applied edit to src/routes.ts' });
      // What only looks like a marker inside a reply stays in the reply.
      expect(reply[3].text_content).toContain('> a quoted line in a reply, not tool output');
      expect(reply[3].text_content).toContain('#### a heading in a reply stays reply');
      const out = b.filter((x) => x.type === 'system').map((x) => x.text_content);
      expect(out[0]).toContain('Main model: anthropic/claude-sonnet-4-5');
      expect(out[2]).toBe('Tokens: 4.4k sent, 3.2k cache hit, 312 received. Cost: $0.02 message, $0.02 session.\nCommit 3f2c1a9 feat: paginate /orders');
    } finally { rmSync(a.dir, { recursive: true, force: true }); }
  });

  it('reads only what was appended since, and does not read a log twice', () => {
    const a = aiderRepo();
    try {
      const first = ingestForeignSource(db, source([a.root]), { now: LATER });
      expect(ingestForeignSource(db, source([a.root]), { now: LATER })).toMatchObject({ filesScanned: 0, messagesAdded: 0 });
      appendFileSync(a.file, '\n#### and a test?  \n\nAdded one.\n\n> Tokens: 2.0k sent, 15 received.  \n');
      const old = (Date.now() - 3600_000) / 1000;
      utimesSync(a.file, old, old);
      expect(ingestForeignSource(db, source([a.root]), { now: LATER })).toMatchObject({ filesScanned: 1, sessionsAdded: 0, messagesAdded: 3 });
      const sid = sessions()[1].session_uuid;
      // The run carried on across passes: same session, same model.
      expect(messages(sid).filter((r) => r.type === 'assistant').map((r) => r.model)).toEqual(['openai/gpt-5', 'openai/gpt-5']);
      expect(first.messagesAdded).toBe(14);
    } finally { rmSync(a.dir, { recursive: true, force: true }); }
  });

  it('waits on the newest turn of a log written moments ago, so its usage lands with it', () => {
    const a = aiderRepo();
    try {
      const now = Date.now();
      utimesSync(a.file, now / 1000, now / 1000);
      // The last turn ("thanks", its reply, its usage) waits.
      expect(ingestForeignSource(db, source([a.root]), { now }).messagesAdded).toBe(11);
      appendFileSync(a.file, '> Applied edit to nothing  \n');
      const later = statSync(a.file).mtimeMs + 60_000;
      expect(ingestForeignSource(db, source([a.root]), { now: later }).messagesAdded).toBe(3);
      const sid = sessions()[1].session_uuid;
      expect(messages(sid).find((r) => r.type === 'assistant')).toMatchObject({ input_tokens: 1200, output_tokens: 20 });
    } finally { rmSync(a.dir, { recursive: true, force: true }); }
  });

  it('starts over when the log is cleared, without colliding with what it read before', () => {
    const a = aiderRepo();
    try {
      ingestForeignSource(db, source([a.root]), { now: LATER });
      writeFileSync(a.file, '\n# aider chat started at 2026-10-22 10:00:00\n\n#### hello  \n\nHi.\n\n');
      const old = (Date.now() - 3600_000) / 1000;
      utimesSync(a.file, old, old);
      expect(ingestForeignSource(db, source([a.root]), { now: LATER })).toMatchObject({ sessionsAdded: 1, messagesAdded: 2 });
      expect(sessions()).toHaveLength(3);
    } finally { rmSync(a.dir, { recursive: true, force: true }); }
  });

  it('looks only in the roots of projects we already know, and their git roots', () => {
    const a = aiderRepo();
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'uf-aider-other-'));
    try {
      cpSync(path.join(FIXTURES, 'aider', 'demo-api'), elsewhere, { recursive: true });
      // No projects yet: nothing to look in.
      expect(ingestForeignSource(db, source(knownProjectRoots(db)), { now: LATER }).filesScanned).toBe(0);
      // A Claude Code session that ran in a subdirectory of the repo.
      mkdirSync(path.join(a.root, 'src'));
      db.prepare(`INSERT INTO projects (name, display_name, path) VALUES ('-x-demo-api-src', 'demo-api', ?)`).run(path.join(a.root, 'src'));
      expect(knownProjectRoots(db)).toEqual([a.root, path.join(a.root, 'src')].sort());
      const counts = ingestForeignSource(db, { harness: 'aider', format: 'aider-history', root: '' }, { now: LATER });
      expect(counts).toMatchObject({ filesScanned: 1, sessionsAdded: 2 });
      expect(sessions().every((s) => s.path === a.root)).toBe(true);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
