import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
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

/**
 * A real repository for the sessions to have happened in.
 *
 * Project identity is the root commit plus the remotes, read by running
 * git against the cwd a transcript recorded. Without a repo there, every
 * project is identified by its encoded path alone — which is the thing
 * renaming a directory breaks, and the case this fixture is here to prove
 * we survive.
 */
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'unfirehose-repo-'));
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

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
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'first');
  git('remote', 'add', 'origin', 'ssh://git@git.unturf.com:2222/demo.git');
  git('remote', 'add', 'github', 'git@github.com:demo/demo.git');

  const sessionDir = path.join(home, '.testharness', 'unfirehose', '-home-fox-git-demo');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl'), [
    // Line 1 of every native file: a header carrying what the session row
    // could not have at creation time, when all we had was the filename.
    JSON.stringify({
      $schema: 'unfirehose/1.0', type: 'session',
      harness: 'testharness', firstPrompt: 'add a test for russell@unturf.com',
      gitBranch: 'main', sidechain: false, createdAt: '2026-09-04T11:59:00.000Z',
    }),
    // A refusal, which is not a message and lands in its own table.
    JSON.stringify({
      $schema: 'unfirehose/1.0', type: 'throttle',
      timestamp: '2026-09-04T12:00:30.000Z', kind: 'rate_limit',
      harness: 'testharness', upstream: 'anthropic', operation: 'messages',
      model: 'claude-opus-4-6-20260301', httpStatus: 429, retryAfterSeconds: 30,
      message: 'rate_limit_error: please slow down',
    }),
    message('m1', 'user', 'add a test'),
    message('m2', 'assistant', 'done', {
      inputTokens: 120,
      outputTokens: 30,
      inputTokenDetails: { cacheReadTokens: 9000, cacheWriteTokens: 400 },
    }),
  ].join('\n') + '\n');

  // Claude Code's own layout: ~/.claude/projects/{encoded-cwd}/{uuid}.jsonl,
  // read by a different path than the native harnesses and the larger half
  // of ingestAll.
  const claudeDir = path.join(home, '.claude', 'projects', '-home-fox-git-demo');
  fs.mkdirSync(claudeDir, { recursive: true });
  // Claude Code's own index names the directory the session ran in. That
  // path is what identity is read from, and it is the only reason a rename
  // does not create a second project.
  fs.writeFileSync(path.join(claudeDir, 'sessions-index.json'), JSON.stringify({
    originalPath: repo,
    entries: [{
      sessionId: 'cc111111-1111-2222-3333-444444444444',
      firstPrompt: 'add a test', gitBranch: 'main',
      created: '2026-09-04T11:00:00.000Z', isSidechain: false,
    }],
  }));
  fs.writeFileSync(path.join(claudeDir, 'cc111111-1111-2222-3333-444444444444.jsonl'), [
    JSON.stringify({
      type: 'user', uuid: 'cc-u1', timestamp: '2026-09-04T11:00:00.000Z',
      cwd: repo,
      message: { role: 'user', content: [{ type: 'text', text: 'add a test' }] },
    }),
    JSON.stringify({
      type: 'assistant', uuid: 'cc-a1', parentUuid: 'cc-u1',
      timestamp: '2026-09-04T11:00:05.000Z', durationMs: 5000,
      message: {
        role: 'assistant', model: 'claude-opus-4-6-20260301',
        content: [
          { type: 'thinking', thinking: 'weighing it up' },
          { type: 'text', text: 'done' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        ],
        usage: {
          input_tokens: 200, output_tokens: 40,
          cache_read_input_tokens: 5000, cache_creation_input_tokens: 100,
        },
      },
    }),
    JSON.stringify({
      type: 'user', uuid: 'cc-u2', parentUuid: 'cc-a1', timestamp: '2026-09-04T11:00:06.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.ts b.ts' }] },
    }),
    // Todos reach us as tool calls, not as their own record. TaskCreate
    // opens one, TaskUpdate closes it, and TodoWrite rewrites a whole list
    // at once — three shapes for one table.
    JSON.stringify({
      type: 'assistant', uuid: 'cc-a2', parentUuid: 'cc-u2',
      timestamp: '2026-09-04T11:01:00.000Z',
      message: {
        role: 'assistant', model: 'claude-opus-4-6-20260301',
        content: [
          { type: 'tool_use', id: 't2', name: 'TaskCreate', input: { subject: 'cover the ingest path', activeForm: 'covering the ingest path' } },
          { type: 'tool_use', id: 't3', name: 'TaskCreate', input: { subject: 'delete the dead report' } },
        ],
      },
    }),
    // The id a TaskUpdate will later name does not come from the call. It
    // comes back in the result text, and is matched to the most recent todo
    // in the session that has none.
    JSON.stringify({
      type: 'user', uuid: 'cc-u3', parentUuid: 'cc-a2', timestamp: '2026-09-04T11:01:01.000Z',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't2', content: 'Task #1 created successfully: cover the ingest path' },
      ] },
    }),
    JSON.stringify({
      type: 'user', uuid: 'cc-u4', parentUuid: 'cc-u3', timestamp: '2026-09-04T11:01:02.000Z',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't3', content: 'Task #2 created successfully: delete the dead report' },
      ] },
    }),
    JSON.stringify({
      type: 'assistant', uuid: 'cc-a3', parentUuid: 'cc-a2',
      timestamp: '2026-09-04T11:02:00.000Z',
      message: {
        role: 'assistant', model: 'claude-opus-4-6-20260301',
        content: [
          { type: 'tool_use', id: 't4', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
          { type: 'tool_use', id: 't5', name: 'TodoWrite', input: { todos: [
            { content: 'run the suite', status: 'in_progress', activeForm: 'running the suite' },
            { content: 'push', status: 'pending' },
          ] } },
        ],
      },
    }),
  ].join('\n') + '\n');

  // Fetch's layout: ~/.fetch/sessions/{slug}/{id}.jsonl. A third reader
  // again, and the one that carries a research question rather than a
  // coding turn.
  const fetchDir = path.join(home, '.fetch', 'sessions', '-home-fox-git-demo');
  fs.mkdirSync(fetchDir, { recursive: true });
  fs.writeFileSync(path.join(fetchDir, 'ff111111-1111-2222-3333-444444444444.jsonl'), [
    message('f1', 'user', 'what does gaugeColor do?'),
    message('f2', 'assistant', 'it maps a percentage to a colour', {
      inputTokens: 50, outputTokens: 20,
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    }),
  ].join('\n') + '\n');

  // A directory that looks like a harness but has no unfirehose folder, and
  // one on the exclusion list — neither should be read as a native harness.
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'unfirehose'), { recursive: true });

  const { ingestAll } = await import('./ingest');
  await ingestAll();
});

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const one = <T,>(sql: string): T => db.prepare(sql).get() as T;
const all = <T,>(sql: string): T[] => db.prepare(sql).all() as T[];

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
      "SELECT session_uuid, harness FROM sessions WHERE harness = 'testharness'",
    );
    expect(session.session_uuid).toBe('aaaaaaaa-1111-2222-3333-444444444444');
    expect(session.harness).toBe('testharness');
  });

  it('stores both messages with their tokens split by kind', () => {
    const totals = one<{ n: number; input: number; cacheRead: number; cacheWrite: number }>(`
      SELECT COUNT(*) AS n, SUM(input_tokens) AS input,
             SUM(cache_read_tokens) AS cacheRead, SUM(cache_creation_tokens) AS cacheWrite
      FROM messages m JOIN sessions s ON m.session_id = s.id
      WHERE s.harness = 'testharness'
    `);
    expect(totals.n).toBe(2);
    expect(totals.input).toBe(120);
    expect(totals.cacheRead).toBe(9000);
    expect(totals.cacheWrite).toBe(400);
  });

  it('writes the content blocks alongside', () => {
    const block = one<{ n: number }>(`
      SELECT COUNT(*) AS n FROM content_blocks cb
      JOIN messages m ON cb.message_id = m.id
      JOIN sessions s ON m.session_id = s.id
      WHERE cb.block_type = 'text' AND s.harness = 'testharness'
    `);
    expect(block.n).toBe(2);
  });

  it('ignores dot-directories that are not harnesses', () => {
    // ~/.ssh has no unfirehose folder; ~/.claude is read by its own reader
    // and must not be picked up twice as a native one.
    const projects = db.prepare('SELECT name FROM projects').all() as { name: string }[];
    expect(projects.map((p) => p.name)).not.toContain('ssh:-home-fox-git-demo');
    expect(projects.some((p) => p.name.startsWith('claude:'))).toBe(false);
  });

  it('reads Claude Code\'s own layout as well as the native one', () => {
    // Two different readers, one pass. The claude reader is the older and
    // larger half of ingestAll and had no test at all.
    const project = one<{ name: string }>(
      "SELECT name FROM projects WHERE name = '-home-fox-git-demo'",
    );
    expect(project?.name).toBe('-home-fox-git-demo');
  });

  it('normalises a Claude Code turn into our columns', () => {
    const row = one<{ input: number; cacheRead: number; model: string }>(`
      SELECT input_tokens AS input, cache_read_tokens AS cacheRead, model
      FROM messages WHERE message_uuid = 'cc-a1'
    `);
    expect(row).toEqual({ input: 200, cacheRead: 5000, model: 'claude-opus-4-6-20260301' });
  });

  it('keeps reasoning, text and a tool call as separate blocks', () => {
    const kinds = db.prepare(`
      SELECT DISTINCT block_type FROM content_blocks cb
      JOIN messages m ON cb.message_id = m.id
      WHERE m.message_uuid IN ('cc-a1', 'cc-u2')
      ORDER BY block_type
    `).all() as { block_type: string }[];
    // These are the canonical names, not the wire ones: Claude Code writes
    // 'thinking', 'tool_use' and 'tool_result', and the adapter normalises
    // them to 'reasoning', 'tool-call' and 'tool-result' on the way in. That
    // renaming is the whole point of having an adapter, and nothing else
    // asserted it.
    const types = kinds.map((k) => k.block_type);
    expect(types).toContain('reasoning');
    expect(types).toContain('tool-call');
    expect(types).toContain('tool-result');
    expect(types).not.toContain('thinking');
  });

  it('reads Fetch, which files its sessions under a different directory', () => {
    // Three readers now — native, Claude Code and Fetch — and each files
    // its projects differently. A reader that silently found nothing would
    // look exactly like a harness nobody used.
    const project = one<{ name: string; display_name: string }>(
      "SELECT name, display_name FROM projects WHERE display_name LIKE '[fetch]%'",
    );
    expect(project).toBeTruthy();
  });

  it('opens a todo from a TaskCreate tool call', () => {
    // Nothing in a transcript says "todo". It is a tool call, and this is
    // the only place that connection is made.
    const todo = one<{ content: string; status: string }>(
      "SELECT content, status FROM todos WHERE content = 'delete the dead report'",
    );
    expect(todo?.status).toBe('pending');
  });

  it('takes a todo id from the result text, not from the call', () => {
    // A TaskCreate call carries no id — the harness assigns one and reports
    // it back as "Task #N created". Without reading that, every later
    // TaskUpdate has nothing to match and no todo is ever closed.
    const ids = all<{ external_id: string }>(
      "SELECT external_id FROM todos WHERE source = 'claude' AND external_id IS NOT NULL ORDER BY external_id",
    ).map(r => r.external_id);
    expect(ids).toContain('1');
    expect(ids).toContain('2');
  });

  it('matches a task id to the todo the result names', () => {
    // Two TaskCreates in one message are answered by two results, and
    // pairing them by recency numbers them backwards — so TaskUpdate #1
    // closes the todo that #2 opened. The result text names its subject;
    // that is what decides.
    const first = one<{ external_id: string }>(
      "SELECT external_id FROM todos WHERE content = 'cover the ingest path'",
    );
    expect(first?.external_id).toBe('1');
  });

  it('closes the todo a TaskUpdate names', () => {
    const todo = one<{ status: string }>(
      "SELECT status FROM todos WHERE content = 'cover the ingest path'",
    );
    expect(todo?.status).toBe('completed');
  });

  it('takes a whole list from one TodoWrite', () => {
    const rows = all<{ content: string; status: string }>(
      "SELECT content, status FROM todos WHERE content IN ('run the suite', 'push') ORDER BY content",
    );
    expect(rows.map(r => r.content)).toEqual(['push', 'run the suite']);
    expect(rows.find(r => r.content === 'run the suite')?.status).toBe('in_progress');
  });

  it('identifies a project by its root commit, not by its path', () => {
    // A directory rename gives every harness a new encoded path and so a
    // new project. The root commit does not move, which is the whole point
    // of reading it.
    const row = one<{ root_commit_hash: string; origin_url: string; remotes_json: string }>(
      'SELECT root_commit_hash, origin_url, remotes_json FROM projects WHERE root_commit_hash IS NOT NULL',
    );
    expect(row?.root_commit_hash).toMatch(/^[0-9a-f]{40}$/);
    expect(row?.origin_url).toBe('ssh://git@git.unturf.com:2222/demo.git');
  });

  it('records every remote, not just origin', () => {
    // A mirror clone can have a different origin from the one we know it
    // by; the set of remotes is what ties those together.
    const row = one<{ remotes_json: string }>(
      'SELECT remotes_json FROM projects WHERE remotes_json IS NOT NULL',
    );
    expect(JSON.parse(row!.remotes_json)).toEqual([
      'git@github.com:demo/demo.git',
      'ssh://git@git.unturf.com:2222/demo.git',
    ]);
  });

  it('backfills a session from the header on line one', () => {
    // The session row is created from the filename alone — uuid and
    // harness. Everything a person reads about it arrives here.
    const row = one<{ git_branch: string; first_prompt: string; created_at: string }>(
      "SELECT git_branch, first_prompt, created_at FROM sessions WHERE session_uuid = 'aaaaaaaa-1111-2222-3333-444444444444'",
    );
    expect(row?.git_branch).toBe('main');
    expect(row?.created_at).toBe('2026-09-04T11:59:00.000Z');
  });

  it('strips an address out of a first prompt before storing it', () => {
    // The first prompt is shown on every list of sessions. It is the one
    // field of a transcript we surface without anyone asking for it.
    const row = one<{ first_prompt: string }>(
      "SELECT first_prompt FROM sessions WHERE session_uuid = 'aaaaaaaa-1111-2222-3333-444444444444'",
    );
    expect(row?.first_prompt).not.toContain('russell@unturf.com');
    expect(row?.first_prompt).toContain('add a test');
  });

  it('records a refusal, which is not a message', () => {
    // A 429 is the provider declining to serve. Counting it as a turn
    // would inflate every message total; dropping it loses the only
    // record that we were throttled at all.
    const row = one<{ kind: string; upstream: string; http_status: number }>(
      "SELECT kind, upstream, http_status FROM rate_limit_events WHERE rule = 'harness-reported' ORDER BY id DESC LIMIT 1",
    );
    expect(row).toMatchObject({ kind: 'rate_limit', upstream: 'anthropic', http_status: 429 });
  });

  it('adds nothing on a second pass over unchanged files', async () => {
    // Ingest runs on a timer against files that mostly have not moved. If a
    // pass re-inserted, every count in the dashboard would climb on its own.
    const count = () => one<{ n: number }>('SELECT COUNT(*) AS n FROM messages').n;
    const before = count();
    const { ingestAll } = await import('./ingest');
    const result = await ingestAll();
    expect(count()).toBe(before);
    expect(result.messagesAdded).toBe(0);
  });

  it('picks up a session appended after the first pass', async () => {
    const dir = path.join(home, '.testharness', 'unfirehose', '-home-fox-git-demo');
    fs.writeFileSync(path.join(dir, 'bbbbbbbb-1111-2222-3333-444444444444.jsonl'),
      message('m3', 'assistant', 'later work') + '\n');

    const { ingestAll } = await import('./ingest');
    await ingestAll();

    expect(one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sessions WHERE harness = 'testharness'",
    ).n).toBe(2);
    expect(one<{ n: number }>(`
      SELECT COUNT(*) AS n FROM messages m JOIN sessions s ON m.session_id = s.id
      WHERE s.harness = 'testharness'
    `).n).toBe(3);
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
