import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, seedProject } from '@unturf/unfirehose/test/db-helper';

/**
 * Retiring an agent that says it is done.
 *
 * An agent calls this when it finishes. Two things have to happen and both
 * are invisible from anywhere else: the deployment row is marked completed,
 * which is how our board stops showing work as in flight, and the tmux
 * window is told to exit and then killed, which is how a machine stops
 * carrying a dead session forever.
 *
 * Three ways to name the agent — its window, its project, or a todo it was
 * given — because the caller has a different one of those in hand each
 * time, and the fourth case, naming none of them, must be refused rather
 * than retiring everything.
 */

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getDb: () => db,
}));

let ran: string[][];
vi.mock('@unturf/unfirehose/git-exec', () => ({
  execAsync: async (cmd: string, args: string[]) => { ran.push([cmd, ...args]); return { stdout: '', stderr: '' }; },
}));

const { POST } = await import('./route');
const post = (body: unknown) => POST({ json: async () => body } as never);

/** Seeded once: the project name is unique, so re-seeding throws. */
const projectId = seedProject(db, '-home-fox-git-demo', 'demo');

/** One running agent, in a window, holding some todos. */
function deploy(session: string, window: string | null, todoIds: number[] = []) {
  return db.prepare(`
    INSERT INTO agent_deployments (tmux_session, tmux_window, project_id, todo_ids, status, started_at)
    VALUES (?, ?, ?, ?, 'running', datetime('now'))
  `).run(session, window, projectId, JSON.stringify(todoIds)).lastInsertRowid as number;
}

const statusOf = (id: number) =>
  (db.prepare('SELECT status FROM agent_deployments WHERE id = ?').get(id) as { status: string }).status;

beforeEach(() => {
  vi.useFakeTimers();
  ran = [];
  db.prepare('DELETE FROM agent_deployments').run();
});
afterEach(() => vi.useRealTimers());

describe('POST /api/boot/finished', () => {
  it('refuses to retire anything when told nothing', async () => {
    // The alternative reading of an empty body is "all of them".
    deploy('demo', '120000');
    const res = await post({});
    expect(res.status).toBe(400);
    expect(ran).toEqual([]);
  });

  it('retires the window it was given', async () => {
    const id = deploy('demo', '120000');
    const other = deploy('demo', '130000');
    const body = await (await post({ tmuxSession: 'demo', tmuxWindow: '120000' })).json();
    expect(body).toEqual({ ok: true, exited: ['demo:120000'] });
    expect(statusOf(id)).toBe('completed');
    expect(statusOf(other)).toBe('running');
  });

  it('retires every window of a session when no window is named', async () => {
    const a = deploy('demo', '120000');
    const b = deploy('demo', '130000');
    await post({ tmuxSession: 'demo' });
    expect([statusOf(a), statusOf(b)]).toEqual(['completed', 'completed']);
  });

  it('sends /exit before killing, so the harness can shut down', async () => {
    // Killing the window outright loses whatever the agent had not yet
    // flushed to its transcript.
    deploy('demo', '120000');
    await post({ tmuxSession: 'demo', tmuxWindow: '120000' });
    expect(ran[0]).toEqual(['tmux', 'send-keys', '-t', 'demo:120000', '/exit', 'Enter']);
    expect(ran).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(ran[1]).toEqual(['tmux', 'kill-window', '-t', 'demo:120000']);
  });

  it('names a session with no window by the session alone', async () => {
    deploy('demo', null);
    await post({ tmuxSession: 'demo' });
    expect(ran[0]).toEqual(['tmux', 'send-keys', '-t', 'demo', '/exit', 'Enter']);
  });

  it('retires every agent on a project', async () => {
    const a = deploy('demo', '120000');
    const b = deploy('demo', '130000');
    const body = await (await post({ projectName: '-home-fox-git-demo' })).json();
    expect(body.exited).toHaveLength(2);
    expect([statusOf(a), statusOf(b)]).toEqual(['completed', 'completed']);
  });

  it('says a project is unknown rather than silently retiring nothing', async () => {
    const res = await post({ projectName: 'never-heard-of-it' });
    expect(res.status).toBe(404);
  });

  it('finds the agent holding a todo', async () => {
    // A todo dragged to done knows its own id and nothing about tmux.
    const holder = deploy('demo', '120000', [11, 12]);
    const other = deploy('demo', '130000', [99]);
    const body = await (await post({ todoId: 12 })).json();
    expect(body.exited).toEqual(['demo:120000']);
    expect(statusOf(holder)).toBe('completed');
    expect(statusOf(other)).toBe('running');
  });

  it('takes a todo id that arrived as a string', async () => {
    // It comes off a URL as often as out of JSON.
    const id = deploy('demo', '120000', [11]);
    await post({ todoId: '11' });
    expect(statusOf(id)).toBe('completed');
  });

  it('retires nothing, and says so, for a todo no agent holds', async () => {
    deploy('demo', '120000', [11]);
    expect(await (await post({ todoId: 999 })).json()).toEqual({ ok: true, exited: [] });
  });

  it('leaves an already-finished agent alone', async () => {
    // Its window belongs to whatever is running there now.
    const id = deploy('demo', '120000');
    db.prepare("UPDATE agent_deployments SET status = 'completed' WHERE id = ?").run(id);
    expect((await (await post({ tmuxSession: 'demo' })).json()).exited).toEqual([]);
    expect(ran).toEqual([]);
  });
});
