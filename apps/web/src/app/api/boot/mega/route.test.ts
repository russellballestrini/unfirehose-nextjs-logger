import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb, seedProject, seedTodo } from '@unturf/unfirehose/test/db-helper';

/**
 * Launching an agent per project, and cleaning up after them.
 *
 * This starts real processes on this machine, one per project with open
 * todos, so what it refuses is the important half: a project that already
 * has an agent on it must be skipped, or two agents commit over each other
 * in the same repository, and a path that is not there must be skipped
 * rather than booting into a directory that does not exist.
 *
 * The other half is bookkeeping that nothing else does. A deployment whose
 * tmux session is gone stays 'running' forever unless one of these three
 * handlers notices, and a project with a stale running row is never
 * launched again.
 *
 * tmux is mocked.
 */

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getDb: () => db,
}));

let ran: string[][];
let liveSessions: string[];
let spawnFails: string | null;
vi.mock('@unturf/unfirehose/git-exec', () => ({
  execAsync: async (cmd: string, args: string[]) => {
    ran.push([cmd, ...args]);
    if (args[0] === 'list-sessions') return { stdout: liveSessions.join('\n'), stderr: '' };
    if (args[0] === 'new-session' && spawnFails) throw Object.assign(new Error('boom'), { stderr: spawnFails });
    return { stdout: '', stderr: '' };
  },
}));

let dirs: Set<string>;
vi.mock('fs/promises', () => ({
  stat: async (p: string) => {
    if (!dirs.has(String(p))) throw new Error('ENOENT');
    return { isDirectory: () => true };
  },
  writeFile: async () => {}, unlink: async () => {},
}));

const { POST, GET, DELETE } = await import('./route');
const post = (body: unknown = {}) => POST({ json: async () => body } as never);

const demo = seedProject(db, '-home-fox-git-demo', 'demo');
const other = seedProject(db, '-home-fox-git-other', 'other');
db.prepare('UPDATE projects SET path = ? WHERE id = ?').run('/home/fox/git/demo', demo);
db.prepare('UPDATE projects SET path = ? WHERE id = ?').run('/home/fox/git/other', other);

const running = (session: string, projectId: number, todoIds: number[] = []) =>
  db.prepare(`
    INSERT INTO agent_deployments (tmux_session, project_id, todo_ids, status, started_at)
    VALUES (?, ?, ?, 'running', datetime('now'))
  `).run(session, projectId, JSON.stringify(todoIds)).lastInsertRowid as number;

const statusOf = (id: number) =>
  (db.prepare('SELECT status FROM agent_deployments WHERE id = ?').get(id) as { status: string }).status;

let todoA: number;

beforeEach(() => {
  ran = []; liveSessions = []; spawnFails = null;
  dirs = new Set(['/home/fox/git/demo', '/home/fox/git/other']);
  db.prepare('DELETE FROM agent_deployments').run();
  db.prepare('DELETE FROM todos').run();
  todoA = seedTodo(db, demo, 'cover the ingest path', { status: 'pending', uuid: 'u1' });
  seedTodo(db, other, 'push the tag', { status: 'in_progress', uuid: 'u2' });
});

describe('POST — launching', () => {
  it('says so when there is nothing to work on', async () => {
    db.prepare('DELETE FROM todos').run();
    expect((await post()).status).toBe(404);
    expect(ran.filter(c => c[1] === 'new-session')).toEqual([]);
  });

  it('launches one agent per project with open todos', async () => {
    const body = await (await post()).json();
    expect(body.launched).toBe(2);
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['launched', 'launched']);
  });

  it('records each launch, so the next call knows it is running', async () => {
    await post();
    const rows = db.prepare("SELECT tmux_session, status FROM agent_deployments").all() as
      Array<{ tmux_session: string; status: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.status === 'running')).toBe(true);
    expect(rows[0].tmux_session).toMatch(/^mega-/);
  });

  it('skips a project that already has an agent on it', async () => {
    // Two agents in one repository commit over each other.
    liveSessions = ['mega-demo-000000'];
    running('mega-demo-000000', demo);
    const body = await (await post()).json();
    const skipped = body.results.find((r: { status: string }) => r.status === 'skipped');
    expect(skipped.reason).toBe('already running');
    expect(body.launched).toBe(1);
  });

  it('skips a project whose path is not there', async () => {
    dirs.delete('/home/fox/git/other');
    const body = await (await post()).json();
    const skipped = body.results.find((r: { status: string }) => r.status === 'skipped');
    expect(skipped.reason).toMatch(/invalid path/);
    expect(body.launched).toBe(1);
  });

  it('frees a project whose agent is gone before deciding what to launch', async () => {
    // The row says running and the session does not exist. Without this
    // the project is never launched again.
    const id = running('mega-demo-old', demo);
    liveSessions = [];
    const body = await (await post()).json();
    expect(statusOf(id)).toBe('failed');
    expect(body.launched).toBe(2);
  });

  it('honours a cap on how many agents to start at once', async () => {
    expect((await (await post({ maxAgents: 1 })).json()).total).toBe(1);
  });

  it('tells the agent which todos are its own, by id', async () => {
    // The prompt is the only place the agent learns what to work on and
    // which ids to mark complete.
    await post();
    const rows = db.prepare('SELECT todo_ids FROM agent_deployments').all() as Array<{ todo_ids: string }>;
    const allIds = rows.flatMap(r => JSON.parse(r.todo_ids) as number[]);
    expect(allIds).toContain(todoA);
  });

  it('reports a launch that failed, and does not record it as running', async () => {
    spawnFails = 'duplicate session';
    const body = await (await post()).json();
    expect(body.launched).toBe(0);
    expect(body.results[0]).toMatchObject({ status: 'failed', reason: 'duplicate session' });
    expect(db.prepare('SELECT COUNT(*) c FROM agent_deployments').get()).toEqual({ c: 0 });
  });

  it('kills a half-made session rather than leaving it behind', async () => {
    spawnFails = 'boom';
    await post({ maxAgents: 1 });
    expect(ran.some(c => c[1] === 'kill-session')).toBe(true);
  });
});

describe('GET — what is running', () => {
  it('reports progress against the todos an agent was given', async () => {
    const id = running('mega-demo', demo, [todoA]);
    liveSessions = ['mega-demo'];
    const body = await (await GET()).json();
    expect(body.active).toBe(1);
    expect(body.deployments ?? body.results).toBeDefined();
    const row = (body.deployments ?? body.results)[0];
    expect(row).toMatchObject({ id, alive: true, todoCount: 1, todosCompleted: 0, allDone: false });
  });

  it('calls an agent done when its todos are', async () => {
    db.prepare("UPDATE todos SET status = 'completed' WHERE id = ?").run(todoA);
    running('mega-demo', demo, [todoA]);
    liveSessions = ['mega-demo'];
    const body = await (await GET()).json();
    expect((body.deployments ?? body.results)[0]).toMatchObject({ todosCompleted: 1, allDone: true });
  });

  it('marks a deployment failed when its session is gone', async () => {
    // Nothing else ever notices. This is the only sweep.
    const id = running('mega-demo', demo, [todoA]);
    liveSessions = [];
    const body = await (await GET()).json();
    expect(body.dead).toBe(1);
    expect(statusOf(id)).toBe('failed');
  });

  it('copes with a deployment that was given no todos', async () => {
    running('mega-demo', demo, []);
    liveSessions = ['mega-demo'];
    const body = await (await GET()).json();
    expect((body.deployments ?? body.results)[0]).toMatchObject({ todoCount: 0, allDone: true });
  });
});

describe('DELETE — culling', () => {
  it('clears out a deployment whose session is gone', async () => {
    const id = running('mega-demo', demo, [todoA]);
    liveSessions = [];
    await DELETE();
    expect(statusOf(id)).toBe('failed');
  });

  it('leaves a live agent alone', async () => {
    const id = running('mega-demo', demo, [todoA]);
    liveSessions = ['mega-demo'];
    await DELETE();
    expect(statusOf(id)).toBe('running');
  });
});
