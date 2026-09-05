import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Committing from our dashboard.
 *
 * This route runs git against a real repo on the strength of a click, so
 * its refusals matter more than its successes: an empty commit message, a
 * file path that climbs out of the project, a push that was rejected
 * because the remote moved. The last one is the interesting case — it
 * rebases and retries, and if that conflicts it must abort rather than
 * leave the repo sitting mid-rebase for whoever opens the terminal next.
 *
 * git is mocked. What is under test is which commands we decided to run
 * and in what order.
 */

let repoPath: string | null = '/home/fox/git/demo';
vi.mock('@unturf/unfirehose/db/repo-path', () => ({ repoPathForProject: () => repoPath }));

const settings: Record<string, string> = {};
vi.mock('@unturf/unfirehose/db/ingest', () => ({ getSetting: (k: string) => settings[k] ?? null }));

/** Every git command run, in order, as a flat string for readability. */
let ran: string[];
let impl: (args: string[]) => Promise<string>;
vi.mock('@unturf/unfirehose/git-exec', () => ({
  gitExec: (_repo: string, args: string[]) => { ran.push(args.join(' ')); return impl(args); },
}));

const appended: Array<[string, string]> = [];
let gitignore: string | Error = new Error('ENOENT');
vi.mock('fs/promises', () => ({
  readFile: async () => { if (gitignore instanceof Error) throw gitignore; return gitignore; },
  appendFile: async (p: string, data: string) => { appended.push([p, data]); },
  unlink: async () => {},
}));

const { GET, POST, DELETE } = await import('./route');

/** A distinct project each call, since GET caches per project. */
let n = 0;
const ctx = () => ({ params: Promise.resolve({ project: `demo-${n++}` }) });
const call = (fn: typeof POST, body: unknown) =>
  fn({ json: async () => body } as never, ctx() as never);

beforeEach(() => {
  ran = []; appended.length = 0;
  repoPath = '/home/fox/git/demo';
  gitignore = new Error('ENOENT');
  for (const k of Object.keys(settings)) delete settings[k];
  impl = async (args) =>
    args[0] === 'diff' && args[1] === '--cached' ? ' a.ts | 2 +-\n'
    : args[0] === 'log' ? 'abc1234 a commit\n'
    : args[0] === 'status' ? ' M a.ts\n'
    : '';
});

describe('POST — committing', () => {
  it('refuses without a repo it can find', async () => {
    repoPath = null;
    expect((await call(POST, { message: 'x' })).status).toBe(404);
  });

  it('refuses an empty commit message', async () => {
    // git would take '   ' happily, and the log entry is then unreadable.
    expect((await call(POST, { message: '   ' })).status).toBe(400);
    expect(ran).toEqual([]);
  });

  it('stages only tracked files unless asked for everything', async () => {
    // `add -A` sweeps in whatever else is lying in the tree — including,
    // when agents are working in parallel, their half-written files.
    await call(POST, { message: 'a commit' });
    expect(ran[0]).toBe('add -u');
    ran = [];
    await call(POST, { message: 'a commit', addAll: true });
    expect(ran[0]).toBe('add -A');
  });

  it('refuses to make an empty commit', async () => {
    impl = async () => '';
    const res = await call(POST, { message: 'a commit' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Nothing staged to commit');
    expect(ran).not.toContain('commit -m a commit');
  });

  it('commits and pushes, and says which commit it made', async () => {
    const body = await (await call(POST, { message: 'a commit' })).json();
    expect(body).toMatchObject({ success: true, commit: 'abc1234 a commit', pushed: true });
    expect(ran).toContain('push');
  });

  it('holds the push back when the caller is driving it step by step', async () => {
    const body = await (await call(POST, { message: 'a commit', skipPush: true })).json();
    expect(body.pushed).toBe(false);
    expect(ran).not.toContain('push');
  });

  it('honours the setting that turns auto-push off', async () => {
    settings.git_auto_push = 'false';
    expect((await (await call(POST, { message: 'a commit' })).json()).pushed).toBe(false);
  });

  it('keeps the commit when the push fails, and says why', async () => {
    // The commit is done and is not lost. Reporting the whole thing as a
    // failure invites someone to run it again and commit twice.
    impl = async (args) => {
      if (args[0] === 'push') throw new Error('Could not read from remote repository');
      return args[0] === 'diff' ? ' a.ts | 2 +-\n' : args[0] === 'log' ? 'abc1234 a commit\n' : '';
    };
    const body = await (await call(POST, { message: 'a commit' })).json();
    expect(body).toMatchObject({ success: true, commit: 'abc1234 a commit', pushed: false });
    expect(body.pushError).toMatch(/Could not read from remote/);
  });
});

describe('POST — pushing on its own', () => {
  it('pushes and reports what git said', async () => {
    impl = async () => '  main -> main\n';
    const body = await (await call(POST, { action: 'push' })).json();
    expect(body).toMatchObject({ success: true, pushed: true, output: 'main -> main' });
    expect(ran).toEqual(['push']);
  });

  it('rebases and retries when the remote has moved on', async () => {
    let pushes = 0;
    impl = async (args) => {
      if (args[0] === 'push' && pushes++ === 0) throw new Error('Updates were rejected, fetch first');
      return '';
    };
    const body = await (await call(POST, { action: 'push' })).json();
    expect(body).toMatchObject({ success: true, pushed: true, rebased: true });
    expect(ran).toEqual(['push', 'pull --rebase', 'push']);
  });

  it('aborts a conflicting rebase rather than leaving the repo mid-rebase', async () => {
    // A repo left mid-rebase is a trap for whoever opens that terminal
    // next, and nothing in this dashboard would say it happened.
    impl = async (args) => {
      if (args[0] === 'push') throw new Error('failed to push some refs');
      if (args[0] === 'pull') throw new Error('CONFLICT in a.ts');
      return '';
    };
    const res = await call(POST, { action: 'push' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/need manual resolution/);
    expect(ran).toContain('rebase --abort');
  });

  it('does not rebase over an unrelated push failure', async () => {
    // A rebase in response to an auth failure changes history for no
    // reason and still does not push.
    impl = async (args) => { if (args[0] === 'push') throw new Error('Permission denied (publickey)'); return ''; };
    const res = await call(POST, { action: 'push' });
    expect(res.status).toBe(500);
    expect(ran).not.toContain('pull --rebase');
  });
});

describe('DELETE — removing and ignoring files', () => {
  it('refuses a path that climbs out of the project', async () => {
    for (const file of ['../../../etc/passwd', '/etc/passwd']) {
      const res = await call(DELETE, { file, action: 'delete' });
      expect(res.status).toBe(400);
    }
    expect(ran).toEqual([]);
  });

  it('refuses without a file to act on', async () => {
    expect((await call(DELETE, { action: 'delete' })).status).toBe(400);
  });

  it('adds to .gitignore and stops tracking the file', async () => {
    // Ignoring a file git still tracks changes nothing — it keeps
    // appearing in every status until it is removed from the index.
    const body = await (await call(DELETE, { file: 'notes.txt', action: 'gitignore' })).json();
    expect(body).toMatchObject({ success: true, action: 'gitignore', file: 'notes.txt' });
    expect(appended[0][1]).toBe('notes.txt\n');
    expect(ran).toContain('rm --cached notes.txt');
  });

  it('does not add a second copy of an entry already there', async () => {
    gitignore = 'node_modules\nnotes.txt\n';
    const body = await (await call(DELETE, { file: 'notes.txt', action: 'gitignore' })).json();
    expect(body.note).toBe('Already in .gitignore');
    expect(appended).toEqual([]);
  });

  it('starts a new line when the file does not end with one', async () => {
    // Appending to a file with no trailing newline joins two patterns into
    // one that matches neither.
    gitignore = 'node_modules';
    await call(DELETE, { file: 'notes.txt', action: 'gitignore' });
    expect(appended[0][1]).toBe('\nnotes.txt\n');
  });

  it('deletes an untracked file from disk when git will not', async () => {
    impl = async (args) => { if (args[0] === 'rm') throw new Error('did not match any files'); return ''; };
    const body = await (await call(DELETE, { file: 'scratch.txt', action: 'delete' })).json();
    expect(body).toMatchObject({ success: true, action: 'delete' });
  });

  it('restores a file from both the index and the working tree', async () => {
    // A file removed with git rm is gone from both, and unstaging alone
    // leaves an empty space where the file was.
    await call(DELETE, { file: 'a.ts', action: 'restore' });
    expect(ran).toEqual(['restore --staged a.ts', 'restore a.ts']);
  });
});

describe('GET — reading the repo', () => {
  it('calls a directory without history a project, not a failure', async () => {
    // ~/git/thinking-room is files and tests with no .git. A 500 there
    // renders as a missing path.
    impl = async (args) => { if (args[1] === '--git-dir') throw new Error('not a git repository'); return ''; };
    const body = await (await GET({} as never, ctx() as never)).json();
    expect(body).toMatchObject({ vcs: false, branch: null, files: [], isDirty: false });
  });

  it('reads status, diff, branch and log in one pass', async () => {
    const body = await (await GET({} as never, ctx() as never)).json();
    expect(body.files).toHaveLength(1);
    expect(body.isDirty).toBe(true);
  });

  it('serves a second read from cache rather than spawning git again', async () => {
    await GET({} as never, { params: Promise.resolve({ project: 'cached-git' }) } as never);
    const spawns = ran.length;
    await GET({} as never, { params: Promise.resolve({ project: 'cached-git' }) } as never);
    expect(ran.length).toBe(spawns);
  });
});
