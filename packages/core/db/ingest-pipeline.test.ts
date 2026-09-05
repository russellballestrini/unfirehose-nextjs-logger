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

/**
 * Todos, which arrive as tool calls inside ordinary messages.
 *
 * These reach the database through the same path as everything else, so they
 * are tested through it rather than by reaching for a private function. The
 * rule that matters most is the last one: a session someone has closed must
 * not have its todos raised from the dead the next time its file is read.
 */
const withBlocks = (uuid: string, blocks: unknown[]) => JSON.stringify({
  type: 'assistant',
  uuid,
  timestamp: '2026-09-04T12:00:00.000Z',
  message: { role: 'assistant', model: 'claude-opus-4-6-20260301', content: blocks },
});

const todoWrite = (uuid: string, todos: unknown[]) =>
  withBlocks(uuid, [{ type: 'tool_use', name: 'TodoWrite', id: 't1', input: { todos } }]);

const todoRows = () =>
  db.prepare('SELECT content, status, external_id FROM todos ORDER BY id')
    .all() as { content: string; status: string; external_id: string | null }[];

describe('extracting todos while ingesting', () => {
  it('stores the list a TodoWrite carried', () => {
    ingestJsonlLines(db, [todoWrite('a1', [
      { content: 'write the test', status: 'in_progress', activeForm: 'Writing the test' },
      { content: 'read the code', status: 'completed' },
    ])], 'proj', 's1');

    expect(todoRows()).toEqual([
      { content: 'write the test', status: 'in_progress', external_id: null },
      { content: 'read the code', status: 'completed', external_id: null },
    ]);
  });

  it('advances a todo rather than storing it twice', () => {
    // A session rewrites its whole list on every change, so the same content
    // arrives again and again. Inserting each time would multiply one task
    // into a dozen.
    ingestJsonlLines(db, [todoWrite('a1', [{ content: 'ship it', status: 'pending' }])], 'proj', 's1');
    ingestJsonlLines(db, [todoWrite('a2', [{ content: 'ship it', status: 'completed' }])], 'proj', 's1');

    expect(todoRows()).toEqual([{ content: 'ship it', status: 'completed', external_id: null }]);
  });

  it('ignores an entry with no content to record', () => {
    ingestJsonlLines(db, [todoWrite('a1', [{ status: 'pending' }])], 'proj', 's1');
    expect(todoRows()).toEqual([]);
  });

  it('takes the id a tool result assigns to the task it just made', () => {
    ingestJsonlLines(db, [
      withBlocks('a1', [{ type: 'tool_use', name: 'TaskCreate', id: 'c1', input: { subject: 'first task' } }]),
      withBlocks('a2', [{ type: 'tool_result', tool_use_id: 'c1', content: 'Task #42 created successfully: first task' }]),
    ], 'proj', 's1');

    expect(todoRows()).toEqual([{ content: 'first task', status: 'pending', external_id: '42' }]);
  });

  it('pairs a batch of tasks with their results in the order they were made', () => {
    // Two TaskCreates in one message are answered by two results. Pairing
    // them by recency numbers them backwards, so a later TaskUpdate #1
    // closes the todo that #2 opened. The result names its subject, and
    // that is what decides.
    ingestJsonlLines(db, [
      withBlocks('a1', [
        { type: 'tool_use', name: 'TaskCreate', id: 'c1', input: { subject: 'first task' } },
        { type: 'tool_use', name: 'TaskCreate', id: 'c2', input: { subject: 'second task' } },
      ]),
      withBlocks('a2', [
        { type: 'tool_result', tool_use_id: 'c1', content: 'Task #1 created successfully: first task' },
        { type: 'tool_result', tool_use_id: 'c2', content: 'Task #2 created successfully: second task' },
      ]),
    ], 'proj', 's1');

    expect(todoRows()).toEqual([
      { content: 'first task', status: 'pending', external_id: '1' },
      { content: 'second task', status: 'pending', external_id: '2' },
    ]);
  });

  it('numbers a batch in call order when the results name no subject', () => {
    // Older results are bare. Results come back in the order their calls
    // were made, so the oldest unnumbered todo is the one this names.
    ingestJsonlLines(db, [
      withBlocks('a1', [
        { type: 'tool_use', name: 'TaskCreate', id: 'c1', input: { subject: 'first task' } },
        { type: 'tool_use', name: 'TaskCreate', id: 'c2', input: { subject: 'second task' } },
      ]),
      withBlocks('a2', [
        { type: 'tool_result', tool_use_id: 'c1', content: 'Task #1 created' },
        { type: 'tool_result', tool_use_id: 'c2', content: 'Task #2 created' },
      ]),
    ], 'proj', 's1');

    expect(todoRows().map(r => [r.content, r.external_id])).toEqual([
      ['first task', '1'], ['second task', '2'],
    ]);
  });

  it('records a status change as an event, not just a new value', () => {
    ingestJsonlLines(db, [
      withBlocks('a1', [{ type: 'tool_use', name: 'TaskCreate', id: 'c1', input: { subject: 'a task' } }]),
      withBlocks('a2', [{ type: 'tool_result', tool_use_id: 'c1', content: 'Task #7 created' }]),
      withBlocks('a3', [{ type: 'tool_use', name: 'TaskUpdate', id: 'u1', input: { taskId: 7, status: 'completed' } }]),
    ], 'proj', 's1');

    expect(todoRows()[0].status).toBe('completed');
    const event = db.prepare(
      'SELECT old_status, new_status FROM todo_events ORDER BY id DESC LIMIT 1',
    ).get() as { old_status: string; new_status: string };
    expect(event).toEqual({ old_status: 'pending', new_status: 'completed' });
  });

  it('leaves the todos of a closed session closed when its file is read again', () => {
    // Claude Code never closes its own todo lists, so thousands sit pending
    // forever and get swept to obsolete by hand. If ingest reopened them on
    // the next pass, that sweep would undo itself and the backlog would
    // return with no one having done anything.
    ingestJsonlLines(db, [todoWrite('a1', [{ content: 'long finished', status: 'pending' }])], 'proj', 's1');

    const now = new Date().toISOString();
    db.prepare("UPDATE todos SET status = 'obsolete'").run();
    db.prepare("UPDATE sessions SET status = 'closed', closed_at = ?").run(now);

    ingestJsonlLines(db, [todoWrite('a2', [{ content: 'long finished', status: 'pending' }])], 'proj', 's1');

    expect(todoRows()).toEqual([{ content: 'long finished', status: 'obsolete', external_id: null }]);
  });
});
