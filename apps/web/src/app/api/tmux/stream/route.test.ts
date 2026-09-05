import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, seedProject, seedTodo } from '@unturf/unfirehose/test/db-helper';

/**
 * Watching, and typing into, a tmux session.
 *
 * This route both lists what is running and forwards keystrokes to it, and
 * the second of those puts characters into a shell on whichever machine
 * the host parameter names. Both the session name and the host reach a
 * command line, so both are matched against a pattern first — a hostname
 * with a semicolon in it is not a hostname.
 *
 * tmux and ssh are mocked. What is under test is which command we decided
 * to run, and what the listing says about work in flight.
 */

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getDb: () => db,
}));

/** Every command run, as one flat string, plus canned stdout per command. */
let ran: string[];
let stdout: (cmd: string, args: string[]) => string | Error;
vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => {
    ran.push([cmd, ...args].join(' '));
    const out = stdout(cmd, args);
    if (out instanceof Error) cb(out, '');
    else cb(null, out);
    return { on() {}, kill() {} };
  },
}));

const { GET, POST } = await import('./route');

const get = (query = '') =>
  GET({ nextUrl: { searchParams: new URLSearchParams(query) } } as never);
const post = (body: unknown) => POST({ json: async () => body } as never);

const projectId = seedProject(db, '-home-fox-git-demo', 'demo');

beforeEach(() => {
  ran = [];
  db.prepare('DELETE FROM agent_deployments').run();
  stdout = (_cmd, args) =>
    args.includes('list-sessions') ? 'demo\nagnt\n'
    : args.includes('list-windows') ? '0:main:1\n1:agent:0\n'
    : args.includes('capture-pane') ? '$ ls\na.ts  b.ts\n'
    : '';
});
afterEach(() => vi.useRealTimers());

describe('GET — listing', () => {
  it('lists the sessions tmux reports', async () => {
    const body = await (await get()).json();
    expect(body.sessions).toEqual(['demo', 'agnt']);
    expect(ran[0]).toContain('tmux list-sessions');
  });

  it('says tmux is not running rather than failing the page', async () => {
    // No tmux is the ordinary state of a fresh machine, not an error.
    stdout = () => new Error('no server running on /tmp/tmux-1000/default');
    const body = await (await get()).json();
    expect(body).toEqual({ sessions: [], error: 'tmux not running' });
  });

  it('says which todos an agent in a session was given', async () => {
    // This is the only place a tmux session is tied back to the work it
    // was started for.
    const todoId = seedTodo(db, projectId, 'fix the thing', { status: 'in_progress', uuid: 'todo-uuid-1' });
    db.prepare(`
      INSERT INTO agent_deployments (tmux_session, tmux_window, project_id, todo_ids, status, started_at)
      VALUES ('demo', '120000', ?, ?, 'running', '2026-09-04T12:00:00Z')
    `).run(projectId, JSON.stringify([todoId]));

    const body = await (await get()).json();
    expect(body.deployments.demo).toMatchObject({ status: 'running', startedAt: '2026-09-04T12:00:00Z' });
    expect(body.deployments.demo.todos).toEqual([{ id: todoId, uuid: 'todo-uuid-1' }]);
  });

  it('keeps only the most recent deployment per session', async () => {
    // A session is reused across boots; showing the first one found means
    // showing whichever the database happened to return.
    for (const [started, status] of [['2026-09-01T00:00:00Z', 'completed'], ['2026-09-04T00:00:00Z', 'running']]) {
      db.prepare(`
        INSERT INTO agent_deployments (tmux_session, tmux_window, project_id, todo_ids, status, started_at)
        VALUES ('demo', '1', ?, '[]', ?, ?)
      `).run(projectId, status, started);
    }
    const body = await (await get()).json();
    expect(body.deployments.demo.status).toBe('running');
  });

  it('still lists sessions when the deployment lookup fails', async () => {
    // The listing is the useful half. Losing it because the bookkeeping
    // half threw is losing the terminal.
    db.prepare('DROP TABLE IF EXISTS agent_deployments').run();
    const body = await (await get()).json();
    expect(body.sessions).toEqual(['demo', 'agnt']);
    db.exec(`CREATE TABLE agent_deployments (
      id INTEGER PRIMARY KEY, tmux_session TEXT, tmux_window TEXT, project_id INTEGER,
      todo_ids TEXT, status TEXT, started_at TEXT, stopped_at TEXT)`);
  });

  it('lists the windows of a session, and which one is active', async () => {
    const body = await (await get('session=demo&windows=1')).json();
    expect(body.windows).toEqual([
      { index: '0', name: 'main', active: true },
      { index: '1', name: 'agent', active: false },
    ]);
  });

  it('says a session is gone rather than returning nothing', async () => {
    stdout = () => new Error("can't find session: demo");
    const body = await (await get('session=demo&windows=1')).json();
    expect(body).toEqual({ windows: [], error: 'session not found' });
  });

  it('reaches a remote host over ssh', async () => {
    await get('host=cammy');
    expect(ran[0]).toContain('ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no cammy tmux list-sessions');
  });

  it('refuses a hostname that is not one', async () => {
    // It goes onto a command line. A semicolon in it is a second command.
    const body = await (await get('host=cammy;%20rm%20-rf%20/')).json();
    expect(body.sessions).toEqual([]);
    expect(ran).toEqual([]);
  });
});

describe('POST — typing', () => {
  it('refuses without a session', async () => {
    expect((await post({ keys: 'ls' })).status).toBe(400);
    expect(ran).toEqual([]);
  });

  it('refuses a session name that is not one', async () => {
    for (const session of ['a b', '../etc', 'a;b', 'a:b']) {
      expect((await post({ session, keys: 'ls' })).status).toBe(400);
    }
    expect(ran).toEqual([]);
  });

  it('types into a session and hands back what the pane looks like after', async () => {
    // Without the capture the caller waits for the next poll, and typing
    // feels like it did nothing.
    const body = await (await post({ session: 'demo', keys: 'ls\n' })).json();
    expect(ran[0]).toContain('tmux send-keys -t demo');
    expect(body.content).toContain('a.ts');
  });

  it('addresses a window when one is named', async () => {
    await post({ session: 'demo', window: '1', keys: 'ls' });
    expect(ran[0]).toContain('send-keys -t demo:1');
  });

  it('sends a named key by name, which is what tmux expects', async () => {
    await post({ session: 'demo', special: 'C-c' });
    expect(ran[0]).toContain('send-keys -t demo C-c');
  });

  it('refuses a key that is not on the list', async () => {
    const res = await post({ session: 'demo', special: '; rm -rf /' });
    expect(res.status).toBe(400);
    expect(ran).toEqual([]);
  });

  it('bounds a paste', async () => {
    expect((await post({ session: 'demo', keys: 'x'.repeat(5000) })).status).toBe(400);
  });

  it('refuses a request that says nothing to do', async () => {
    expect((await post({ session: 'demo' })).status).toBe(400);
  });

  it('clamps a resize instead of forwarding a nonsense geometry', async () => {
    await post({ session: 'demo', action: 'resize', cols: 0, rows: 100_000 });
    expect(ran[0]).toContain('resize-window -t demo -x 40 -y 200');
  });

  it('refuses a resize with no geometry', async () => {
    expect((await post({ session: 'demo', action: 'resize' })).status).toBe(400);
  });

  it('still reports success when the pane could not be captured', async () => {
    // The keystroke went in. Reporting failure invites someone to send it
    // twice.
    stdout = (_c, args) => (args.includes('capture-pane') ? new Error('pane gone') : '');
    expect(await (await post({ session: 'demo', keys: 'ls' })).json()).toEqual({ ok: true });
  });
});
