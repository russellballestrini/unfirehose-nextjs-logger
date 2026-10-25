import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedProject, seedSession, seedMessage } from '../test/db-helper';

// Every core reader of block text, asked the same question before and
// after its rows go cold. Cold is a storage detail: the answers must match.
let db: Database.Database;
vi.mock('./schema', () => ({ getDb: () => db }));

const { freezeBatch } = await import('./block-cold');
const { getThinkingBlocksInWindow, getUserPromptsInWindow, getProjectRecentPrompts } = await import('./ingest-queries');
const { scanRateLimits } = await import('./rate-limit-scan');
const { extractProvidenceFromSession } = await import('./ingest-rows');
const { storedSessionMessages } = await import('./session-messages');
const { drainLedger, rebuildLedger } = await import('./action-ledger');
const { exportTrainingSet } = await import('../training-export');

const DAY = 86_400_000;
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

function block(messageId: number, pos: number, type: string, text: string | null, toolInput: string | null = null) {
  db.prepare('INSERT INTO content_blocks (message_id, position, block_type, text_content, tool_name, tool_input) VALUES (?, ?, ?, ?, ?, ?)')
    .run(messageId, pos, type, text, toolInput ? 'Bash' : null, toolInput);
}

/** Freeze everything: a window of 30 days, seen from 60 days ahead. */
function freezeAll() {
  let r;
  do { r = freezeBatch(db, { days: 30, now: now + 60 * DAY, minBytes: 1 }); } while (!r.caughtUp);
  const left = db.prepare("SELECT COUNT(*) AS n FROM content_blocks WHERE cold = 0 AND (text_content != '' OR tool_input != '')").get() as { n: number };
  expect(left.n).toBe(0);
}

let sessionId: number;
beforeEach(() => {
  db = createTestDb();
  const p = seedProject(db, 'proj', 'proj');
  sessionId = seedSession(db, p, 'sess-1');
  for (let i = 0; i < 6; i++) {
    const u = seedMessage(db, sessionId, { type: 'user', uuid: `u${i}`, timestamp: iso((10 - i) * 3600_000) });
    block(u, 0, 'text', `Please refactor module ${i} so the — tests pass ✓ and nothing else moves`);
    const a = seedMessage(db, sessionId, { type: 'assistant', uuid: `a${i}`, timestamp: iso((10 - i) * 3600_000 - 60_000) });
    block(a, 0, 'thinking', `reasoning about module ${i}: 🦊 `.repeat(5));
    block(a, 1, 'text', `Done with module ${i}.`);
    block(a, 2, 'tool_use', null, JSON.stringify({ command: `npm test -- module${i}` }));
  }
  // A credential a tool printed: the ledger must still see it once cold.
  const leak = seedMessage(db, sessionId, { type: 'user', uuid: 'leak', timestamp: iso(2 * 3600_000) });
  block(leak, 0, 'tool_result', 'export KEY=' + 'sk-ant-' + 'api03-' + 'Zq8xW2vB7nM4kL9pR3tY6uE1oA5sD0fG');
  const err = seedMessage(db, sessionId, { type: 'user', uuid: 'err', timestamp: iso(3600_000) });
  block(err, 0, 'tool_result', 'API Error: 529 Overloaded. This is a server-side issue.');
});

describe('readers of cold block text', () => {
  it('reasoning, prompts and recent prompts answer the same', () => {
    const start = iso(DAY), end = iso(-DAY);
    const before = [getThinkingBlocksInWindow(start, end), getUserPromptsInWindow(start, end), getProjectRecentPrompts('proj', 10)];
    expect(before[0]).toHaveLength(6);
    expect(before[1]).toHaveLength(6);
    expect(before[2].length).toBeGreaterThan(0);
    freezeAll();
    expect([getThinkingBlocksInWindow(start, end), getUserPromptsInWindow(start, end), getProjectRecentPrompts('proj', 10)]).toEqual(before);
  });

  it('rate-limit scanning finds an error in a cold block', () => {
    freezeAll();
    const r = scanRateLimits(db, { fromScratch: true });
    expect(r.found).toBe(1);
  });

  it('providence pairs are the same from cold text', () => {
    const count = () => db.prepare('SELECT COUNT(*) AS n FROM providence_cache').get() as { n: number };
    const answers = () => db.prepare('SELECT question_text, answer_text FROM providence_cache ORDER BY question_text').all();
    expect(extractProvidenceFromSession(db, sessionId, '/test/path', 'claude-code')).toBeGreaterThan(0);
    const before = answers();
    db.exec('DELETE FROM providence_cache');
    freezeAll();
    extractProvidenceFromSession(db, sessionId, '/test/path', 'claude-code');
    expect(count().n).toBe(before.length);
    expect(answers()).toEqual(before);
  });

  it('a training export reads the same lines from cold text', () => {
    // Before 2026-10-24 it read cb.text_content directly: any retention
    // window exported older sessions with empty turns, and said nothing.
    const lines = () => [...exportTrainingSet(db, {})].map((e) => JSON.stringify(e));
    const before = lines();
    expect(before.length).toBeGreaterThan(0);
    expect(before.join('')).toContain('refactor module 3');
    freezeAll();
    expect(lines()).toEqual(before);
  });

  it('the session viewer reads a cold session back whole', () => {
    const before = storedSessionMessages(db, 'sess-1');
    expect(JSON.stringify(before)).toContain('Done with module 5.');
    freezeAll();
    expect(storedSessionMessages(db, 'sess-1')).toEqual(before);
  });

  it('the action ledger classifies cold tool calls and finds a credential in a cold result', () => {
    const ledger = () => db.prepare('SELECT block_id, kind, command, flags FROM action_ledger ORDER BY block_id').all();
    const sightings = () => db.prepare('SELECT block_id, kinds FROM secret_sightings ORDER BY block_id').all();
    drainLedger(db);
    const before = { ledger: ledger(), sightings: sightings() };
    expect(before.ledger.length).toBeGreaterThan(0);
    expect(before.sightings).toHaveLength(1);
    freezeAll();
    db.exec('DELETE FROM secret_sightings');
    rebuildLedger(db);
    drainLedger(db);
    expect({ ledger: ledger(), sightings: sightings() }).toEqual(before);
  });
});
