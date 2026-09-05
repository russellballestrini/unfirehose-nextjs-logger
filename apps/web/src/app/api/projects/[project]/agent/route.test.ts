import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb, seedProject } from '@unturf/unfirehose/test/db-helper';

/**
 * The agent panel's four actions.
 *
 * status and blockers only read. finish runs git against a real repo, and
 * nudge spawns an agent with a prompt. Both of those do something to a
 * machine on the strength of a click, so what they refuse matters: finish
 * must not push when there is nothing to push, must not commit a clean
 * tree, and must record what it did either way, since agent_actions is the
 * only record that the click happened at all.
 *
 * git and the spawn are mocked.
 */

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getDb: () => db,
}));

let prompts: unknown[] = [];
vi.mock('@unturf/unfirehose/db/ingest', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getProjectRecentPrompts: () => prompts,
}));

let repoPath: string | null = '/home/fox/git/demo';
vi.mock('@unturf/unfirehose/db/repo-path', () => ({ repoPathForProject: () => repoPath }));

let ran: string[];
let git: (args: string[]) => Promise<string>;
vi.mock('@unturf/unfirehose/git-exec', () => ({
  gitExec: (_r: string, args: string[]) => { ran.push(args.join(' ')); return git(args); },
}));

const spawned: unknown[][] = [];
vi.mock('child_process', () => ({
  spawn: (...a: unknown[]) => {
    spawned.push(a);
    return { stdin: { write() {}, end() {} }, stdout: { on() {} }, stderr: { on() {} },
             on() {}, kill() {}, unref() {} };
  },
  execFile: () => ({ on() {} }),
}));

const { GET, POST } = await import('./route');

const ctx = () => ({ params: Promise.resolve({ project: '-home-fox-git-demo' }) });
const post = (body: unknown) => POST({ json: async () => body } as never, ctx() as never);

/** Everything the action log recorded, newest last. */
const actions = () => db.prepare(
  'SELECT action, status, result FROM agent_actions ORDER BY id',
).all() as Array<{ action: string; status: string; result: string | null }>;

beforeEach(() => {
  ran = []; prompts = []; spawned.length = 0;
  repoPath = '/home/fox/git/demo';
  db.prepare('DELETE FROM agent_actions').run();
  git = async (args) =>
    args[0] === 'status' ? ' M a.ts\n'
    : args[0] === 'rev-parse' ? 'main\n'
    : args[0] === 'log' && args.includes('@{upstream}..HEAD') ? ''
    : args[0] === 'log' ? '2026-09-04T12:00:00Z\n'
    : '';
});

describe('POST — refusals', () => {
  it('refuses an action it does not have', async () => {
    const res = await post({ action: 'rm -rf' });
    expect(res.status).toBe(400);
    expect(actions()).toEqual([]);
  });

  it('refuses when it cannot find the repo', async () => {
    repoPath = null;
    expect((await post({ action: 'status' })).status).toBe(404);
  });
});

describe('POST — status and blockers', () => {
  it('records the action before doing it, and marks it done after', async () => {
    // agent_actions is the only record a click happened. Writing it after
    // the work means a crash mid-action leaves no trace of the attempt.
    const body = await (await post({ action: 'status' })).json();
    expect(body.ok).toBe(true);
    const [row] = actions();
    expect(row).toMatchObject({ action: 'status', status: 'done' });
    expect(JSON.parse(row.result!).summary).toBe('1 dirty files on main');
  });

  it('reports blockers without touching the repo', async () => {
    const body = await (await post({ action: 'blockers' })).json();
    expect(body.result.summary).toBeTruthy();
    expect(ran.every(c => c.startsWith('status') || c.startsWith('rev-parse') || c.startsWith('log') || c.startsWith('diff'))).toBe(true);
  });

  it('marks the action failed when git could not be read at all', async () => {
    git = async () => { throw new Error('not a repository'); };
    const res = await post({ action: 'finish' });
    expect(res.status).toBe(500);
    expect(actions()[0]).toMatchObject({ status: 'failed' });
  });
});

describe('POST — finish', () => {
  it('commits and pushes, and says what it did', async () => {
    git = async (args) =>
      args[0] === 'status' ? ' M a.ts\n'
      : args[0] === 'rev-parse' ? 'main\n'
      : args.includes('@{upstream}..HEAD') ? 'abc1234 the commit\n'
      : args[0] === 'log' ? 'abc1234 the commit\n'
      : '';
    const body = await (await post({ action: 'finish' })).json();
    expect(ran).toContain('add -A');
    expect(ran).toContain('push');
    expect(body.result.actions.join(' ')).toMatch(/Committed.*Pushed 1 commit/s);
  });

  it('uses the message it was given rather than inventing one', async () => {
    await post({ action: 'finish', message: 'fix: the gauge thresholds' });
    expect(ran).toContain('commit -m fix: the gauge thresholds');
  });

  it('names how many files it swept up when nobody wrote a message', async () => {
    // An auto-commit with no message at all is unreadable in a log a
    // person will read later.
    git = async (args) => (args[0] === 'status' ? ' M a.ts\n M b.ts\n' : args[0] === 'rev-parse' ? 'main\n' : '');
    await post({ action: 'finish' });
    expect(ran.find(c => c.startsWith('commit'))).toContain('auto-commit 2 file(s)');
  });

  it('does not commit a clean tree', async () => {
    git = async (args) => (args[0] === 'status' ? '' : args[0] === 'rev-parse' ? 'main\n' : '');
    const body = await (await post({ action: 'finish' })).json();
    expect(ran).not.toContain('add -A');
    expect(body.result.summary).toMatch(/Nothing to do/);
  });

  it('does not push when there is nothing ahead of the remote', async () => {
    git = async (args) => (args[0] === 'status' ? '' : args[0] === 'rev-parse' ? 'main\n' : '');
    await post({ action: 'finish' });
    expect(ran).not.toContain('push');
  });

  it('pushes commits made before this action, not only its own', async () => {
    // Someone committed in a terminal and forgot to push. Finish is the
    // button that is supposed to notice.
    git = async (args) =>
      args[0] === 'status' ? ''
      : args[0] === 'rev-parse' ? 'main\n'
      : args.includes('@{upstream}..HEAD') ? 'abc1234 earlier work\n'
      : '';
    const body = await (await post({ action: 'finish' })).json();
    expect(ran).toContain('push');
    expect(body.result.summary).toMatch(/Pushed 1 commit/);
  });
});

describe('POST — nudge', () => {
  it('answers immediately and leaves the agent running', async () => {
    // The agent takes minutes. Holding the request open means the click
    // times out on a run that is going fine.
    const body = await (await post({ action: 'nudge' })).json();
    expect(body).toMatchObject({ ok: true, status: 'spawned' });
    expect(actions()[0].status).toBe('running');
    expect(spawned).toHaveLength(1);
  });

  it('collects the diff to hand over when there is uncommitted work', async () => {
    await post({ action: 'nudge' });
    expect(ran).toContain('diff HEAD');
  });

  it('does not collect a diff of a clean tree', async () => {
    git = async (args) => (args[0] === 'status' ? '' : args[0] === 'rev-parse' ? 'main\n' : '');
    await post({ action: 'nudge' });
    expect(ran).not.toContain('diff HEAD');
  });

  it('records which trigger asked for it', async () => {
    // A nudge fired by a schedule and one fired by a person are different
    // events, and only one of them means somebody is watching.
    await post({ action: 'nudge', trigger: 'schedule' });
    const row = db.prepare('SELECT trigger_type FROM agent_actions ORDER BY id DESC LIMIT 1').get();
    expect(row).toEqual({ trigger_type: 'schedule' });
  });
});

describe('GET', () => {
  it('lists what this project has been asked to do', async () => {
    seedProject(db, '-home-fox-git-demo', 'demo');
    await post({ action: 'status' });
    const body = await (await GET({} as never, ctx() as never)).json();
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0].action).toBe('status');
  });
});
