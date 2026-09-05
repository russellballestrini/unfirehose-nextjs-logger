import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { matchPromptsToCommits, COMMIT_WINDOW_MS, type GitContext } from './prompt-commits';

/**
 * Pairing a prompt with the commit it produced.
 *
 * The correlation is a guess — nothing in a transcript names a commit — so
 * what matters is that the guess is stated and stays stated. These tests are
 * the statement. The rule: the soonest commit landing after the prompt and
 * inside our window, or, for a prompt still inside the window, whatever the
 * working tree shows.
 */

const NOW = Date.parse('2026-09-05T12:00:00Z');
beforeEach(() => vi.useFakeTimers({ now: NOW }));
afterEach(() => vi.useRealTimers());

const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function prompt(msAgo: number, over: Partial<{ prompt: string; response: string | null }> = {}) {
  return {
    prompt: 'do the thing',
    timestamp: at(msAgo),
    session_uuid: 'sess-1',
    response: 'done',
    ...over,
  };
}

function ctx(over: Partial<GitContext> = {}): GitContext {
  return { isDirty: false, unpushedCount: 0, recentCommits: [], remoteUrl: null, ...over };
}

const commit = (msAgo: number, hash: string, subject = 'did it') =>
  ({ hash, subject, date: at(msAgo) });

describe('with no git context', () => {
  it('still shows every prompt, claiming no commit for any of them', () => {
    // A project that is not a repo, or one git would not answer for. The
    // feed is about what was asked; losing that because git is unavailable
    // would be the wrong trade.
    const out = matchPromptsToCommits([prompt(0), prompt(1000)], null);
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.gitStatus === null && r.commitHash === null)).toBe(true);
  });

  it('shapes a row the same way it does with one', () => {
    // Two code paths built this object independently. The page reads one
    // shape; a missing key on the null path renders as blank, not as an error.
    const [withoutGit] = matchPromptsToCommits([prompt(0)], null);
    const [withGit] = matchPromptsToCommits([prompt(0)], ctx());
    expect(Object.keys(withoutGit).sort()).toEqual(Object.keys(withGit).sort());
  });
});

describe('matching a commit to the prompt that caused it', () => {
  it('credits a commit that landed after the prompt, inside the window', () => {
    const out = matchPromptsToCommits(
      [prompt(60 * 60 * 1000)],
      ctx({ recentCommits: [commit(30 * 60 * 1000, 'abc123', 'built the thing')] }),
    );
    expect(out[0]).toMatchObject({
      gitStatus: 'committed', commitHash: 'abc123', commitSubject: 'built the thing',
    });
  });

  it('ignores a commit that landed before the prompt', () => {
    // Work that predates the question cannot be its result. This is the
    // whole reason the filter is one-sided.
    const out = matchPromptsToCommits(
      [prompt(30 * 60 * 1000)],
      ctx({ recentCommits: [commit(60 * 60 * 1000, 'older')] }),
    );
    expect(out[0].commitHash).toBeNull();
  });

  it('ignores a commit past the window, so tomorrow is not credited to tonight', () => {
    const promptAgo = COMMIT_WINDOW_MS + 60_000;
    const out = matchPromptsToCommits(
      [prompt(promptAgo)],
      ctx({ recentCommits: [commit(0, 'much-later')] }),
    );
    expect(out[0].commitHash).toBeNull();
  });

  it('takes the commit at the far edge of the window but not the one on it', () => {
    // Boundary: strictly less than the window. Stated so a later change to
    // >= is a decision somebody makes on purpose.
    const promptAgo = COMMIT_WINDOW_MS;
    const justInside = matchPromptsToCommits(
      [prompt(promptAgo)], ctx({ recentCommits: [commit(1, 'inside')] }),
    );
    expect(justInside[0].commitHash).toBe('inside');
    const exactlyOn = matchPromptsToCommits(
      [prompt(promptAgo)], ctx({ recentCommits: [commit(0, 'on-the-line')] }),
    );
    expect(exactlyOn[0].commitHash).toBeNull();
  });

  it('picks the soonest commit after the prompt, not the newest', () => {
    // Two commits inside the window usually means the second belongs to the
    // next prompt. Crediting the newest would attribute a whole session's
    // work to its first question.
    const out = matchPromptsToCommits(
      [prompt(90 * 60 * 1000)],
      ctx({ recentCommits: [commit(10 * 60 * 1000, 'later'), commit(80 * 60 * 1000, 'sooner')] }),
    );
    expect(out[0].commitHash).toBe('sooner');
  });

  it('credits a commit at the same instant as the prompt', () => {
    const out = matchPromptsToCommits(
      [prompt(0)], ctx({ recentCommits: [commit(0, 'same-tick')] }),
    );
    expect(out[0].commitHash).toBe('same-tick');
  });
});

describe('a prompt with no commit yet', () => {
  it('reads a dirty tree as work still in progress', () => {
    const out = matchPromptsToCommits([prompt(10 * 60 * 1000)], ctx({ isDirty: true }));
    expect(out[0].gitStatus).toBe('uncommitted');
  });

  it('reads a clean tree with unpushed commits as unpushed', () => {
    const out = matchPromptsToCommits([prompt(10 * 60 * 1000)], ctx({ unpushedCount: 3 }));
    expect(out[0].gitStatus).toBe('unpushed');
  });

  it('prefers uncommitted over unpushed when both are true', () => {
    // Uncommitted is the more urgent of the two, and the more likely to be
    // this prompt's work rather than an earlier one's.
    const out = matchPromptsToCommits(
      [prompt(10 * 60 * 1000)], ctx({ isDirty: true, unpushedCount: 3 }),
    );
    expect(out[0].gitStatus).toBe('uncommitted');
  });

  it('claims nothing for a clean tree', () => {
    expect(matchPromptsToCommits([prompt(10 * 60 * 1000)], ctx())[0].gitStatus).toBeNull();
  });

  it('claims nothing once the prompt is older than the window', () => {
    // An old prompt with no commit is most likely conversation or planning.
    // Reading the working tree for it would label every past question with
    // today's uncommitted work, forever.
    const old = COMMIT_WINDOW_MS + 60_000;
    const out = matchPromptsToCommits([prompt(old)], ctx({ isDirty: true, unpushedCount: 3 }));
    expect(out[0].gitStatus).toBeNull();
  });
});

describe('what a row carries', () => {
  it('excerpts a long prompt and a long response', () => {
    const [r] = matchPromptsToCommits(
      [prompt(0, { prompt: 'p'.repeat(500), response: 'r'.repeat(5000) })], ctx(),
    );
    expect(r.prompt).toHaveLength(200);
    expect(r.response).toHaveLength(2000);
  });

  it('turns an empty response into null, so the page tests one thing', () => {
    expect(matchPromptsToCommits([prompt(0, { response: '' })], ctx())[0].response).toBeNull();
    expect(matchPromptsToCommits([prompt(0, { response: null })], ctx())[0].response).toBeNull();
  });

  it('carries the session through, since a row links back to it', () => {
    expect(matchPromptsToCommits([prompt(0)], ctx())[0].sessionId).toBe('sess-1');
  });
});
