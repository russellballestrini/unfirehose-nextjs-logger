import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from '../test/db-helper';

let db = createTestDb();
vi.mock('./schema', () => ({
  getDb: () => db,
  UNFIREHOSE_DIR: '/tmp/unfirehose-test',
}));

const { ingestJsonlLines } = await import('./ingest');

/**
 * The path a line of JSONL actually takes into our database.
 *
 * Everything else in this package reads rows that this wrote. Until now the
 * suite tested the readers and left the writer — project identity, session
 * creation, entry normalisation, message insert, content blocks, dedupe —
 * running only in production. A schema change that broke ingestion would
 * have shown up as an empty dashboard days later, with the transcripts it
 * failed to read already past Claude Code's 30-day reaper.
 *
 * Both formats are here because both arrive: unfirehose/1.0 from native
 * harnesses, and Claude Code's own shape, which is normalised on the way in.
 */

const claudeAssistant = (uuid: string, text = 'done') => JSON.stringify({
  type: 'assistant',
  uuid,
  timestamp: '2026-09-04T12:00:00.000Z',
  message: {
    role: 'assistant',
    model: 'claude-opus-4-6-20260301',
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      cache_read_input_tokens: 9_000,
      cache_creation_input_tokens: 400,
    },
  },
});

const claudeUser = (uuid: string, text: string) => JSON.stringify({
  type: 'user',
  uuid,
  timestamp: '2026-09-04T11:59:00.000Z',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

beforeEach(() => {
  db = createTestDb();
});

describe('ingesting JSONL', () => {
  it('lands a project, a session and its messages from Claude Code shape', () => {
    const result = ingestJsonlLines(
      db,
      [claudeUser('u1', 'add a test'), claudeAssistant('a1')],
      '-home-fox-git-demo',
      'session-abc',
    );

    expect(result.accepted).toBe(2);
    expect(result.errors).toBe(0);
    expect(count('projects')).toBe(1);
    expect(count('sessions')).toBe(1);
    expect(count('messages')).toBe(2);
  });

  it('keeps each kind of token in its own column', () => {
    // A blended total cannot be priced: cache read bills at a tenth of
    // input and cache write above it.
    ingestJsonlLines(db, [claudeAssistant('a1')], 'proj', 'session-abc');
    const row = db.prepare(
      `SELECT input_tokens AS input, output_tokens AS output,
              cache_read_tokens AS cacheRead, cache_creation_tokens AS cacheWrite, model
       FROM messages WHERE type = 'assistant'`,
    ).get() as Record<string, number | string>;

    expect(row).toEqual({
      input: 120, output: 30, cacheRead: 9_000, cacheWrite: 400,
      model: 'claude-opus-4-6-20260301',
    });
  });

  it('accepts a native unfirehose/1.0 message unchanged', () => {
    const native = JSON.stringify({
      type: 'message',
      role: 'assistant',
      uuid: 'n1',
      timestamp: '2026-09-04T12:00:00.000Z',
      model: 'qwen3-coder',
      content: [{ type: 'text', text: 'hello' }],
      // unfirehose/1.0 spells usage in camelCase and nests the cache
      // figures; Claude Code's snake_case shape is what the adapter
      // translates from.
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        inputTokenDetails: { cacheReadTokens: 800, cacheWriteTokens: 0 },
      },
    });

    expect(ingestJsonlLines(db, [native], 'proj', 's1').accepted).toBe(1);
    const row = db.prepare(
      'SELECT model, input_tokens AS input, cache_read_tokens AS cacheRead FROM messages',
    ).get() as Record<string, unknown>;
    expect(row.model).toBe('qwen3-coder');
    expect(row.input).toBe(10);
    expect(row.cacheRead).toBe(800);
  });

  it('writes content blocks alongside the message', () => {
    ingestJsonlLines(db, [claudeAssistant('a1', 'the answer')], 'proj', 's1');
    const block = db.prepare(
      'SELECT block_type, text_content FROM content_blocks',
    ).get() as Record<string, string>;
    expect(block.block_type).toBe('text');
    expect(block.text_content).toContain('the answer');
  });

  it('ignores a line it has already stored', () => {
    // Re-reading a file from the top is normal — a session appends, and the
    // reader starts where it can. Ingest must be idempotent or every restart
    // doubles the token counts.
    ingestJsonlLines(db, [claudeAssistant('a1')], 'proj', 's1');
    ingestJsonlLines(db, [claudeAssistant('a1')], 'proj', 's1');
    expect(count('messages')).toBe(1);
  });

  it('counts a broken line and keeps going', () => {
    // A half-written last line is what a live tail looks like.
    const result = ingestJsonlLines(
      db,
      ['{ not json', '', claudeAssistant('a1')],
      'proj',
      's1',
    );
    expect(result.accepted).toBe(1);
    expect(result.errors).toBe(1);
    expect(count('messages')).toBe(1);
  });

  it('files a second session under the same project', () => {
    ingestJsonlLines(db, [claudeAssistant('a1')], 'shared-project', 'session-one');
    ingestJsonlLines(db, [claudeAssistant('a2')], 'shared-project', 'session-two');

    expect(count('projects')).toBe(1);
    expect(count('sessions')).toBe(2);
    expect(count('messages')).toBe(2);
  });
});
