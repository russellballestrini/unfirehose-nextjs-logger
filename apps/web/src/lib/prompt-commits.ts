/**
 * Pairing a prompt with the commit it produced.
 *
 * Our project activity feed shows what was asked and whether anything
 * landed. That correlation is a guess — nothing in a transcript names a
 * commit — so the rule it guesses by is worth stating plainly and worth
 * testing. It lived inside a route handler where neither was possible:
 * Next validates a route file's exports, so nothing there can be reached
 * from a test except through an HTTP request.
 */

export interface GitContext {
  isDirty: boolean;
  unpushedCount: number;
  recentCommits: Array<{ hash: string; subject: string; date: string }>;
  remoteUrl: string | null;
}

/**
 * How long after a prompt a commit still counts as its result.
 *
 * Two hours. Long enough for a real piece of work, short enough that the
 * next morning's commit is not credited to last night's question.
 */
export const COMMIT_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Truncation caps. A feed row shows an excerpt; the session view has the rest. */
const PROMPT_CHARS = 200, RESPONSE_CHARS = 2000;

type Prompt = { prompt: string; timestamp: string; session_uuid: string; response: string | null };
type Match = { hash: string; subject: string } | null;

/** One row of our feed. Built in one place so the unmatched case cannot drift. */
function row(p: Prompt, gitStatus: string | null, match: Match) {
  return {
    prompt: (p.prompt ?? '').slice(0, PROMPT_CHARS),
    timestamp: p.timestamp,
    sessionId: p.session_uuid,
    // An empty response is null, not '', so the page has one thing to test.
    response: (p.response ?? '').slice(0, RESPONSE_CHARS) || null,
    gitStatus,
    commitHash: match?.hash ?? null,
    commitSubject: match?.subject ?? null,
  };
}

export function matchPromptsToCommits(prompts: Prompt[], gitCtx: GitContext | null) {
  // No git context — the project is not a repo, or git would not answer.
  // Every prompt still shows; none of them claims a commit.
  if (!gitCtx) return prompts.map((p) => row(p, null, null));

  const commits = gitCtx.recentCommits.map((c) => ({ ...c, ts: new Date(c.date).getTime() }));

  return prompts.map((p) => {
    const promptTs = new Date(p.timestamp).getTime();
    // A commit counts as this prompt's result if it landed after the prompt
    // and inside our window: ask, work, commit.
    const candidates = commits.filter((c) => c.ts >= promptTs && c.ts - promptTs < COMMIT_WINDOW_MS);
    // The soonest one after the prompt, not the newest — a later commit is
    // more likely the next prompt's work than this one's.
    const match = candidates.length > 0 ? candidates.reduce((a, b) => (a.ts < b.ts ? a : b)) : null;
    if (match) return row(p, 'committed', match);

    // Nothing matched. If the prompt is still inside the window the work may
    // simply be unfinished, and the working tree says how far it got.
    // Outside the window, an unmatched prompt is most likely conversation,
    // so we claim nothing rather than call planning "uncommitted" forever.
    const inFlight = Date.now() - promptTs < COMMIT_WINDOW_MS;
    if (!inFlight) return row(p, null, null);
    return row(p, gitCtx.isDirty ? 'uncommitted' : gitCtx.unpushedCount > 0 ? 'unpushed' : null, null);
  });
}
