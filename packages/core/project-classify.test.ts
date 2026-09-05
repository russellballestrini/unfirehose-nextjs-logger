import { describe, it, expect } from 'vitest';
import { classifyProjectRows, cleanPath, type ClassifyRow } from './project-classify';

/**
 * Which rows in `projects` are actually projects.
 *
 * Every rule here exists because a specific wrong list shipped: `/tmp` as a
 * 5,648-session "project", `~/git/contra` eaten into "fox-git", 2,166 rows
 * where about a hundred were real. The cases below are those lists.
 */

const row = (name: string, path: string | null, is_repo = 0): ClassifyRow => ({ name, path, is_repo });
const NO_FS = new Set<string>();

describe('what counts as a project', () => {
  it('trusts a directory that exists on disk under our harness root', () => {
    // A transcript directory is proof some harness worked there.
    const c = classifyProjectRows([], new Set(['-home-fox-git-thing']));
    expect(c.repoNames.has('-home-fox-git-thing')).toBe(true);
  });

  it('trusts a git root', () => {
    const c = classifyProjectRows([row('repo', '/home/fox/git/repo', 1)], NO_FS);
    expect(c.repoNames.has('repo')).toBe(true);
  });

  it('does not trust a path on its own', () => {
    // 1,352 rows carry a path and are scratch directories inside a repo.
    // Having somewhere to be is not the same as being a project.
    const c = classifyProjectRows([
      row('repo', '/home/fox/git/repo', 1),
      row('scratch', '/home/fox/git/repo/bench/run-1'),
    ], NO_FS);
    expect(c.repoNames.has('scratch')).toBe(false);
  });

  it('promotes a real directory that is not a git root yet', () => {
    // ~/git/contra had nine sessions and no .git. Nesting is what
    // disqualifies a row, not the absence of a commit.
    const c = classifyProjectRows([
      row('git', '/home/fox/git'),
      row('a', '/home/fox/git/a', 1),
      row('b', '/home/fox/git/b', 1),
      row('contra', '/home/fox/git/contra'),
    ], NO_FS);
    expect(c.repoNames.has('contra')).toBe(true);
  });
});

describe('container directories', () => {
  /** ~/git holding several repos, plus one plain directory under it. */
  const tree = [
    row('fox-git', '/home/fox/git'),
    row('alpha', '/home/fox/git/alpha', 1),
    row('beta', '/home/fox/git/beta', 1),
    row('contra', '/home/fox/git/contra'),
  ];

  it('calls a directory with several tracked children a container', () => {
    expect(classifyProjectRows(tree, NO_FS).containers.has('fox-git')).toBe(true);
  });

  it('lets a container keep its own row', () => {
    // Agents do run with ~/git as cwd. The row is real; what it may not do
    // is absorb the repos beneath it.
    expect(classifyProjectRows(tree, NO_FS).repoNames.has('fox-git')).toBe(true);
  });

  it('refuses to let a container absorb anybody', () => {
    // This is the rule that stopped ~/git/contra being eaten into "fox-git"
    // and /tmp becoming a 5,648-session project.
    expect(classifyProjectRows(tree, NO_FS).foldTargets.has('fox-git')).toBe(false);
  });

  it('never calls a git root a container, however many rows sit inside it', () => {
    // arborist holds its bench workspaces. It is still one repo.
    const c = classifyProjectRows([
      row('arborist', '/home/fox/git/arborist', 1),
      row('w1', '/home/fox/git/arborist/bench/a'),
      row('w2', '/home/fox/git/arborist/bench/b'),
    ], NO_FS);
    expect(c.containers.has('arborist')).toBe(false);
    expect(c.foldTargets.has('arborist')).toBe(true);
  });

  it('needs more than one child before it calls anything a container', () => {
    // A directory holding one project is that project's parent, not a hub.
    const c = classifyProjectRows([
      row('parent', '/home/fox/work'),
      row('only', '/home/fox/work/only', 1),
    ], NO_FS);
    expect(c.containers.has('parent')).toBe(false);
  });
});

describe('scratch space', () => {
  it('drops a fleet worker workspace from the list of projects', () => {
    const c = classifyProjectRows([row('w', '/tmp/agent-workspaces/run-9/repo')], NO_FS);
    expect(c.repoNames.has('w')).toBe(false);
    expect(c.ephemeral.has('w')).toBe(true);
  });

  it('drops it even when it looks like a git root', () => {
    // One run of one agent in a clone is still one run, not a project.
    const c = classifyProjectRows([row('w', '/tmp/agent-workspaces/run-9/repo', 1)], NO_FS);
    expect(c.repoNames.has('w')).toBe(false);
  });

  it('does not let scratch space become a container either', () => {
    const c = classifyProjectRows([
      row('tmpdir', '/tmp/agent-workspaces'),
      row('a', '/tmp/agent-workspaces/a'),
      row('b', '/tmp/agent-workspaces/b'),
    ], NO_FS);
    expect(c.containers.has('tmpdir')).toBe(false);
  });

  it('folds a scratch path that names its own repo rather than promoting it', () => {
    // A scratchpad under /tmp sits there exactly as ~/git/contra sits under
    // ~/git. The difference is that its name says where it belongs.
    const c = classifyProjectRows([
      row('tmp', '/tmp'),
      row('x', '/tmp/x'),
      row('y', '/tmp/y'),
      row('-home-fox-git-uncloseai-cli', '/home/fox/git/uncloseai-cli', 1),
      row('claude-1000--home-fox-git-uncloseai-cli-abc-scratchpad', '/tmp/claude-1000-abc'),
    ], NO_FS);
    expect(c.repoNames.has('claude-1000--home-fox-git-uncloseai-cli-abc-scratchpad')).toBe(false);
    expect(c.repoNames.has('-home-fox-git-uncloseai-cli')).toBe(true);
  });
});

describe('nesting', () => {
  it('keeps a row out when a tracked path contains it', () => {
    const c = classifyProjectRows([
      row('repo', '/home/fox/git/repo', 1),
      row('inner', '/home/fox/git/repo/sub'),
    ], NO_FS);
    expect(c.repoNames.has('inner')).toBe(false);
  });

  it('does not count a container as containing anything, for this purpose', () => {
    // Everything is under ~/git. If that counted, nothing would ever be
    // promoted and ~/git/contra would have stayed invisible.
    const c = classifyProjectRows([
      row('fox-git', '/home/fox/git'),
      row('a', '/home/fox/git/a', 1),
      row('b', '/home/fox/git/b', 1),
      row('contra', '/home/fox/git/contra'),
    ], NO_FS);
    expect(c.repoNames.has('contra')).toBe(true);
  });

  it('is not fooled by a sibling path that merely starts the same way', () => {
    // /home/fox/git/alpha-two is not inside /home/fox/git/alpha. Comparing
    // prefixes without the separator would fold a sibling away. The names
    // here share no prefix, so this isolates the path rule from the name one.
    const c = classifyProjectRows([
      row('alpha', '/home/fox/git/alpha', 1),
      row('beta', '/home/fox/git/alpha-two'),
    ], NO_FS);
    expect(c.repoNames.has('beta')).toBe(true);
  });

  it('folds a row whose name extends a repo it is not inside', () => {
    // A worktree or scratch clone is named for its repo and sits elsewhere
    // on disk; the name is the only thing that says where it belongs. The
    // cost is that a genuine sibling repo named `<repo>-two` folds too,
    // which is why a real sibling carries its own root commit and is
    // trusted before this rule is ever consulted.
    const folded = classifyProjectRows([
      row('repo', '/home/fox/git/repo', 1),
      row('repo-two', '/elsewhere/repo-two'),
    ], NO_FS);
    expect(folded.repoNames.has('repo-two')).toBe(false);

    const sibling = classifyProjectRows([
      row('repo', '/home/fox/git/repo', 1),
      row('repo-two', '/home/fox/git/repo-two', 1),
    ], NO_FS);
    expect(sibling.repoNames.has('repo-two')).toBe(true);
  });

  it('treats a trailing slash as the same directory', () => {
    const c = classifyProjectRows([
      row('repo', '/home/fox/git/repo/', 1),
      row('inner', '/home/fox/git/repo/sub'),
    ], NO_FS);
    expect(c.repoNames.has('inner')).toBe(false);
  });
});

describe('cleanPath', () => {
  it('strips trailing slashes so one directory has one spelling', () => {
    expect(cleanPath('/home/fox/git/')).toBe('/home/fox/git');
    expect(cleanPath('/home/fox/git///')).toBe('/home/fox/git');
    expect(cleanPath('/home/fox/git')).toBe('/home/fox/git');
  });

  it('leaves a bare root alone rather than emptying it', () => {
    expect(cleanPath('/')).toBe('');
  });
});

describe('edges', () => {
  it('has nothing to classify for an empty list', () => {
    const c = classifyProjectRows([], NO_FS);
    expect([c.repoNames.size, c.containers.size, c.ephemeral.size, c.foldTargets.size]).toEqual([0, 0, 0, 0]);
  });

  it('ignores a row with no path at all', () => {
    // Rows exist whose cwd was never captured. They are not projects and
    // they must not crash the walk.
    const c = classifyProjectRows([row('nowhere', null)], NO_FS);
    expect(c.repoNames.has('nowhere')).toBe(false);
    expect(c.containers.size).toBe(0);
  });

  it('keeps a git root with no path, since the commit already identified it', () => {
    const c = classifyProjectRows([row('known', null, 1)], NO_FS);
    expect(c.repoNames.has('known')).toBe(true);
  });
});
