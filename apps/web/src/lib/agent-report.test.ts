import { describe, it, expect } from 'vitest';
import { buildStatus, buildBlockers, buildNudgePrompt, type GitSnapshot } from './agent-report';

/**
 * What our agent panel decides about a repo.
 *
 * These read as reporting code, but two of the decisions here have teeth:
 * `needsHuman` is what stops an unattended agent from being nudged at a
 * repo, and the diff cap is what stops one nudge from spending a context
 * window on a lockfile. Both are quiet when wrong.
 */

const git = (over: Partial<GitSnapshot> = {}): GitSnapshot => ({
  branch: 'main', isDirty: false, dirtyFiles: [], unpushedCount: 0,
  unpushedCommits: [], diffStat: '', lastCommitAge: '5m ago', ...over,
});

describe('buildStatus', () => {
  it('says so plainly when there is nothing to do', () => {
    const s = buildStatus(git(), []);
    expect(s.summary).toBe('All clean on main');
    expect(s.severity).toBe('ok');
  });

  it('counts dirty files and unpushed commits in one line', () => {
    const s = buildStatus(git({ isDirty: true, dirtyFiles: ['M a.ts', 'M b.ts'], unpushedCount: 3 }), []);
    expect(s.summary).toBe('2 dirty files on main, 3 unpushed');
    expect(s.severity).toBe('warning');
  });

  it('a clean tree with unpushed work is worth saying, but is not a warning', () => {
    const s = buildStatus(git({ unpushedCount: 2 }), []);
    expect(s.summary).toBe('Clean tree, 2 unpushed on main');
    expect(s.severity).toBe('info');
  });

  it('caps the file list rather than printing a thousand paths', () => {
    // A fresh clone with a bad .gitignore is thousands of files, and this
    // list goes into a panel and into an agent's prompt.
    const files = Array.from({ length: 25 }, (_, i) => `M src/f${i}.ts`);
    const s = buildStatus(git({ isDirty: true, dirtyFiles: files }), []);
    expect(s.lines.filter(l => l.startsWith('  M src/'))).toHaveLength(10);
    expect(s.lines).toContain('  ... and 15 more');
  });

  it('reports that it could not read git, rather than reporting a clean repo', () => {
    // The failure mode this guards: no git state read as nothing to do.
    const s = buildStatus(null, []);
    expect(s.severity).toBe('error');
    expect(s.summary).toMatch(/Could not read git state/);
  });

  it('quotes the last prompt so the panel says what was being worked on', () => {
    const s = buildStatus(git(), [{ prompt: 'fix the gauge thresholds', response: 'done' }]);
    expect(s.lines.join('\n')).toContain('Last prompt: fix the gauge thresholds');
    expect(s.lines.join('\n')).toContain('Response: done');
  });
});

describe('buildBlockers', () => {
  it('finds nothing wrong with a clean repo', () => {
    const b = buildBlockers(git(), []);
    expect(b.blockers).toEqual([]);
    expect(b.needsHuman).toBe(false);
    expect(b.summary).toBe('No blockers detected');
  });

  it('calls uncommitted work stale once the last commit is an hour old', () => {
    const b = buildBlockers(git({ isDirty: true, dirtyFiles: ['M a.ts'], lastCommitAge: '2h ago' }), []);
    expect(b.blockers.map(x => x.type)).toContain('stale-uncommitted');
  });

  it('does not call work stale minutes after a commit', () => {
    const b = buildBlockers(git({ isDirty: true, dirtyFiles: ['M a.ts'], lastCommitAge: '40m ago' }), []);
    expect(b.blockers.map(x => x.type)).not.toContain('stale-uncommitted');
  });

  it('treats a credential in the working tree as needing a person', () => {
    // Nudging an agent at this would commit it. This is the one blocker
    // that must never be resolved automatically.
    const b = buildBlockers(git({ isDirty: true, dirtyFiles: ['?? .env.production'] }), []);
    const found = b.blockers.find(x => x.type === 'suspicious-files');
    expect(found?.severity).toBe('error');
    expect(b.needsHuman).toBe(true);
    expect(b.summary).toMatch(/needs human decision/);
  });

  it('flags node_modules the same way, since committing it is not recoverable cheaply', () => {
    const b = buildBlockers(git({ isDirty: true, dirtyFiles: ['?? node_modules/left-pad/'] }), []);
    expect(b.blockers.map(x => x.type)).toContain('suspicious-files');
  });

  it('calls an agent stalled when its prompt is old and its work uncommitted', () => {
    const old = new Date(Date.now() - 5 * 3_600_000).toISOString();
    const b = buildBlockers(
      git({ isDirty: true, dirtyFiles: ['M a.ts'] }),
      [{ prompt: 'refactor the thing', timestamp: old }],
    );
    const stalled = b.blockers.find(x => x.type === 'agent-stalled');
    expect(stalled?.description).toMatch(/5h ago/);
    expect(b.needsHuman).toBe(true);
  });

  it('does not call it stalled when the tree is clean — that is finished work', () => {
    const old = new Date(Date.now() - 5 * 3_600_000).toISOString();
    const b = buildBlockers(git(), [{ prompt: 'refactor the thing', timestamp: old }]);
    expect(b.blockers.map(x => x.type)).not.toContain('agent-stalled');
  });

  it('unpushed commits are a blocker but not a human decision', () => {
    const b = buildBlockers(git({ unpushedCount: 4 }), []);
    expect(b.blockers[0].type).toBe('unpushed');
    expect(b.needsHuman).toBe(false);
  });

  it('says it cannot read the repo instead of saying it is fine', () => {
    const b = buildBlockers(null, []);
    expect(b.needsHuman).toBe(true);
    expect(b.summary).toBe('Cannot access repository');
  });
});

describe('buildNudgePrompt', () => {
  it('tells the agent to act, and how to say it is done', () => {
    // The UNEOF line is how the orchestrator knows to retire the session.
    // Without it the window stays open until somebody notices.
    const p = buildNudgePrompt(git(), [], '');
    expect(p).toContain('You MUST act, not just report');
    expect(p.trimEnd().endsWith('output the exact text UNEOF as your final line.')).toBe(true);
  });

  it('truncates a large diff and says that it did', () => {
    // A regenerated lockfile is megabytes. Passing it whole spends the
    // context window before the agent reaches its instructions.
    const p = buildNudgePrompt(git(), [], 'x'.repeat(20_000));
    expect(p).toContain('... (diff truncated)');
    expect(p.length).toBeLessThan(12_000);
  });

  it('passes a small diff through untouched', () => {
    const p = buildNudgePrompt(git(), [], 'diff --git a/a.ts b/a.ts');
    expect(p).toContain('diff --git a/a.ts b/a.ts');
    expect(p).not.toContain('truncated');
  });

  it('includes the git state so the agent does not have to rediscover it', () => {
    const p = buildNudgePrompt(
      git({ branch: 'feat/x', isDirty: true, dirtyFiles: ['M a.ts'], unpushedCount: 1, unpushedCommits: ['abc fix'] }),
      [], '');
    expect(p).toContain('Branch: feat/x');
    expect(p).toContain('Dirty files: 1');
    expect(p).toContain('Unpushed commits: 1');
    expect(p).toContain('abc fix');
  });

  it('carries the last three prompts, not every one ever asked', () => {
    const prompts = Array.from({ length: 8 }, (_, i) => ({ prompt: `ask ${i}`, timestamp: new Date().toISOString() }));
    const p = buildNudgePrompt(git(), prompts, '');
    expect(p).toContain('"ask 0"');
    expect(p).toContain('"ask 2"');
    expect(p).not.toContain('"ask 3"');
  });

  it('still produces a usable prompt when git could not be read', () => {
    const p = buildNudgePrompt(null, [], '');
    expect(p).toContain('You MUST act');
    expect(p).not.toContain('## Git State');
  });
});
