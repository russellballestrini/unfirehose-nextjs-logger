import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createTestDb } from '../test/db-helper';

/**
 * A whole ingest pass, over a home directory we built.
 *
 * ingestAll and the native-harness reader are the largest untested functions
 * in this package, and they were untested for a structural reason: they
 * discover work by reading $HOME. So this gives them a $HOME — a temp
 * directory holding a harness that writes unfirehose/1.0 exactly as a real
 * one does — and lets them find it.
 *
 * That covers the path a new adopter takes: drop files in
 * ~/.{harness}/unfirehose/{slug}/{uuid}.jsonl and appear in the dashboard
 * without anyone adding code. Nothing checked that end to end before.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'unfirehose-home-'));

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home };
});

const db = createTestDb();
vi.mock('./schema', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getDb: () => db,
}));

const message = (uuid: string, role: string, text: string, usage?: object) => JSON.stringify({
  $schema: 'unfirehose/1.0',
  type: 'message',
  role,
  uuid,
  timestamp: '2026-09-04T12:00:00.000Z',
  model: 'qwen3-coder',
  content: [{ type: 'text', text }],
  ...(usage ? { usage } : {}),
});

beforeAll(async () => {
  const sessionDir = path.join(home, '.testharness', 'unfirehose', '-home-fox-git-demo');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl'), [
    message('m1', 'user', 'add a test'),
    message('m2', 'assistant', 'done', {
      inputTokens: 120,
      outputTokens: 30,
      inputTokenDetails: { cacheReadTokens: 9000, cacheWriteTokens: 400 },
    }),
  ].join('\n') + '\n');

  // A directory that looks like a harness but has no unfirehose folder, and
  // one on the exclusion list — neither should be read.
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'unfirehose'), { recursive: true });

  const { ingestAll } = await import('./ingest');
  await ingestAll();
});

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const one = <T,>(sql: string): T => db.prepare(sql).get() as T;

describe('ingestAll over a native harness', () => {
  it('finds a harness nobody registered, by its directory alone', () => {
    // The whole promise of the spec: write unfirehose/1.0 to
    // ~/.{harness}/unfirehose/ and appear, without a code change here.
    const project = one<{ name: string; display_name: string }>(
      "SELECT name, display_name FROM projects WHERE name LIKE 'testharness:%'",
    );
    expect(project).toBeTruthy();
    expect(project.name).toBe('testharness:-home-fox-git-demo');
  });

  it('names the project for a reader rather than for the filesystem', () => {
    const project = one<{ display_name: string }>(
      "SELECT display_name FROM projects WHERE name LIKE 'testharness:%'",
    );
    expect(project.display_name).toContain('demo');
  });

  it('reads the session out of the filename', () => {
    const session = one<{ session_uuid: string; harness: string }>(
      'SELECT session_uuid, harness FROM sessions LIMIT 1',
    );
    expect(session.session_uuid).toBe('aaaaaaaa-1111-2222-3333-444444444444');
    expect(session.harness).toBe('testharness');
  });

  it('stores both messages with their tokens split by kind', () => {
    const totals = one<{ n: number; input: number; cacheRead: number; cacheWrite: number }>(`
      SELECT COUNT(*) AS n, SUM(input_tokens) AS input,
             SUM(cache_read_tokens) AS cacheRead, SUM(cache_creation_tokens) AS cacheWrite
      FROM messages
    `);
    expect(totals.n).toBe(2);
    expect(totals.input).toBe(120);
    expect(totals.cacheRead).toBe(9000);
    expect(totals.cacheWrite).toBe(400);
  });

  it('writes the content blocks alongside', () => {
    const block = one<{ n: number }>("SELECT COUNT(*) AS n FROM content_blocks WHERE block_type = 'text'");
    expect(block.n).toBe(2);
  });

  it('ignores dot-directories that are not harnesses', () => {
    // ~/.ssh has no unfirehose folder; ~/.claude is read by its own reader
    // and must not be picked up twice as a native one.
    const projects = db.prepare('SELECT name FROM projects').all() as { name: string }[];
    expect(projects.map((p) => p.name)).not.toContain('ssh:-home-fox-git-demo');
    expect(projects.some((p) => p.name.startsWith('claude:'))).toBe(false);
  });

  it('adds nothing on a second pass over unchanged files', async () => {
    // Ingest runs on a timer against files that mostly have not moved. If a
    // pass re-inserted, every count in the dashboard would climb on its own.
    const before = one<{ n: number }>('SELECT COUNT(*) AS n FROM messages').n;
    const { ingestAll } = await import('./ingest');
    const result = await ingestAll();
    expect(one<{ n: number }>('SELECT COUNT(*) AS n FROM messages').n).toBe(before);
    expect(result.messagesAdded).toBe(0);
  });

  it('picks up a session appended after the first pass', async () => {
    const dir = path.join(home, '.testharness', 'unfirehose', '-home-fox-git-demo');
    fs.writeFileSync(path.join(dir, 'bbbbbbbb-1111-2222-3333-444444444444.jsonl'),
      message('m3', 'assistant', 'later work') + '\n');

    const { ingestAll } = await import('./ingest');
    await ingestAll();

    expect(one<{ n: number }>('SELECT COUNT(*) AS n FROM sessions').n).toBe(2);
    expect(one<{ n: number }>('SELECT COUNT(*) AS n FROM messages').n).toBe(3);
  });

  it('discovers a harness that appears between passes', async () => {
    // refreshNativeHarnesses exists for this: a harness installed while the
    // worker is running should not need a restart to be seen.
    const dir = path.join(home, '.brandnew', 'unfirehose', '-home-fox-git-other');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cccccccc-1111-2222-3333-444444444444.jsonl'),
      message('m4', 'user', 'hello from a new harness') + '\n');

    const { ingestAll } = await import('./ingest');
    await ingestAll();

    const project = one<{ name: string }>("SELECT name FROM projects WHERE name LIKE 'brandnew:%'");
    expect(project?.name).toBe('brandnew:-home-fox-git-other');
  });
});
