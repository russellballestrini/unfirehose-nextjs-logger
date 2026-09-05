import { gitExec } from '@unturf/unfirehose/git-exec';

/**
 * What is uncommitted and what is unpushed, asked once.
 *
 * Two routes report these same two facts about the same repository — the
 * agent report and the project activity feed — and each was running the
 * same two git commands and deriving the same two numbers from them. They
 * have to agree: a page that says "clean" beside a report that says "three
 * dirty files" is a contradiction the reader has to resolve, and there is
 * no way to tell from the outside which one is right.
 *
 * Both commands are tolerated failing. `@{upstream}..HEAD` exits non-zero
 * on a branch with no upstream, which is a normal state, not an error.
 */
export interface GitState {
  /** Porcelain lines, trimmed. Empty means a clean tree. */
  dirtyFiles: string[];
  isDirty: boolean;
  /** Commits on HEAD that the upstream does not have. */
  unpushedCommits: string[];
  unpushedCount: number;
}

export const EMPTY_GIT_STATE: GitState = {
  dirtyFiles: [], isDirty: false, unpushedCommits: [], unpushedCount: 0,
};

/** Parse the two outputs. Separate from the spawning so it can be tested. */
export function parseGitState(statusRaw: string, unpushedRaw: string): GitState {
  const dirtyFiles = statusRaw.split('\n').filter(Boolean).map((l) => l.trim());
  const unpushedCommits = unpushedRaw.split('\n').filter(Boolean);
  return {
    dirtyFiles,
    isDirty: dirtyFiles.length > 0,
    unpushedCommits,
    unpushedCount: unpushedCommits.length,
  };
}

export async function readGitState(repoPath: string): Promise<GitState> {
  const [status, unpushed] = await Promise.all([
    gitExec(repoPath, ['status', '--porcelain']).catch(() => ''),
    // Non-zero on a branch with no upstream — a normal state, not a failure.
    gitExec(repoPath, ['log', '--oneline', '@{upstream}..HEAD']).catch(() => ''),
  ]);
  return parseGitState(status, unpushed);
}
