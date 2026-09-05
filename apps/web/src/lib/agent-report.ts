/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * What our agent panel says about a repo, from a git snapshot and the
 * prompts that came before.
 *
 * These three turn state into text a person reads and an agent is sent:
 * a status summary, a blocker list, and the prompt a nudge run receives.
 * They are pure, and they decide things worth being sure of — whether a
 * repo needs a human, and how much of a diff a nudged agent is handed.
 *
 * Kept out of the route because Next validates a `route.ts` export
 * surface, so nothing defined there can be imported by a test.
 */

export interface GitSnapshot {
  branch: string;
  isDirty: boolean;
  dirtyFiles: string[];
  unpushedCount: number;
  unpushedCommits: string[];
  diffStat: string;
  lastCommitAge: string | null;
}

export function buildStatus(git: GitSnapshot | null, prompts: any[]) {
  const lines: string[] = [];

  if (!git) {
    return { summary: 'Could not read git state', lines: [], severity: 'error' };
  }

  // Branch
  lines.push(`Branch: ${git.branch}`);

  // Dirty state
  if (git.isDirty) {
    lines.push(`${git.dirtyFiles.length} uncommitted file(s):`);
    for (const f of git.dirtyFiles.slice(0, 10)) lines.push(`  ${f}`);
    if (git.dirtyFiles.length > 10) lines.push(`  ... and ${git.dirtyFiles.length - 10} more`);
  } else {
    lines.push('Working tree clean');
  }

  // Unpushed
  if (git.unpushedCount > 0) {
    lines.push(`${git.unpushedCount} unpushed commit(s):`);
    for (const c of git.unpushedCommits.slice(0, 5)) lines.push(`  ${c}`);
  }

  // Diff stat
  if (git.diffStat) {
    lines.push('');
    lines.push(git.diffStat);
  }

  // Last activity
  if (prompts.length > 0) {
    const last = prompts[0];
    lines.push('');
    lines.push(`Last prompt: ${(last.prompt ?? '').slice(0, 150)}`);
    if (last.response) {
      lines.push(`Response: ${(last.response ?? '').slice(0, 200)}`);
    }
  }

  // Unpushed work counts even on a clean tree — it exists on exactly one
  // machine. buildBlockers already calls it a blocker; grading it 'ok' here
  // painted the panel green over the same fact.
  const severity = git.isDirty
    ? (git.unpushedCount > 0 ? 'warning' : 'info')
    : (git.unpushedCount > 0 ? 'info' : 'ok');
  const summary = git.isDirty
    ? `${git.dirtyFiles.length} dirty files on ${git.branch}` + (git.unpushedCount > 0 ? `, ${git.unpushedCount} unpushed` : '')
    : git.unpushedCount > 0
      ? `Clean tree, ${git.unpushedCount} unpushed on ${git.branch}`
      : `All clean on ${git.branch}`;

  return { summary, lines, severity, git };
}

export function buildBlockers(git: GitSnapshot | null, prompts: any[]) {
  const blockers: Array<{ type: string; description: string; severity: string }> = [];

  if (!git) {
    blockers.push({ type: 'git', description: 'Cannot read git state for this project', severity: 'error' });
    return { blockers, summary: 'Cannot access repository', needsHuman: true };
  }

  // Stale uncommitted work (dirty for 1hr+)
  if (git.isDirty && git.lastCommitAge) {
    const ageMatch = git.lastCommitAge.match(/(\d+)([hd])/);
    if (ageMatch) {
      const val = parseInt(ageMatch[1]);
      const unit = ageMatch[2];
      if (unit === 'h' && val >= 1 || unit === 'd') {
        blockers.push({
          type: 'stale-uncommitted',
          description: `${git.dirtyFiles.length} uncommitted files, last commit was ${git.lastCommitAge}`,
          severity: 'warning',
        });
      }
    }
  }

  // Unpushed commits
  if (git.unpushedCount > 0) {
    blockers.push({
      type: 'unpushed',
      description: `${git.unpushedCount} commit(s) not pushed to remote`,
      severity: 'warning',
    });
  }

  // Check if last prompt had no matching commit (agent may be stuck)
  if (prompts.length > 0) {
    const last = prompts[0];
    const promptAge = Date.now() - new Date(last.timestamp).getTime();
    if (promptAge > 3_600_000 && git.isDirty) {
      blockers.push({
        type: 'agent-stalled',
        description: `Last prompt was ${Math.floor(promptAge / 3_600_000)}h ago, work still uncommitted: "${(last.prompt ?? '').slice(0, 100)}"`,
        severity: 'error',
      });
    }
  }

  // Dirty files that look like they shouldn't be committed
  const suspicious = git.dirtyFiles.filter(f =>
    /\.(env|key|pem|secret|credentials)/.test(f) || f.includes('node_modules')
  );
  if (suspicious.length > 0) {
    blockers.push({
      type: 'suspicious-files',
      description: `Potentially sensitive files in working tree: ${suspicious.join(', ')}`,
      severity: 'error',
    });
  }

  const needsHuman = blockers.some(b => b.severity === 'error');
  const summary = blockers.length === 0
    ? 'No blockers detected'
    : `${blockers.length} blocker(s)` + (needsHuman ? ' — needs human decision' : '');

  return { blockers, summary, needsHuman };
}

export function buildNudgePrompt(git: GitSnapshot | null, prompts: any[], diff: string): string {
  const sections: string[] = [];

  sections.push('You have been triggered by the unfirehose dashboard to finish stale work in this repo.');
  sections.push('You MUST act, not just report. Do as much as you can, then create TODOs only for what remains.');
  sections.push('');
  sections.push('## Instructions (in order of priority)');
  sections.push('1. Fix obvious hygiene: add .gitignore entries for generated/artifact files, remove accidental files from tracking.');
  sections.push('2. If there are safe, complete changes: stage them, write a good commit message, commit, and push.');
  sections.push('3. If work is incomplete but you can finish it quickly (< 2 min): do it, then commit and push.');
  sections.push('4. For anything that genuinely needs a human decision: create a TODO with specific details on what is blocked and what the human needs to decide.');
  sections.push('5. You can do MULTIPLE of the above. Gitignore a file AND commit other changes AND create TODOs — all in one run.');
  sections.push('');

  if (git) {
    sections.push(`## Git State`);
    sections.push(`Branch: ${git.branch}`);
    sections.push(`Dirty files: ${git.dirtyFiles.length}`);
    if (git.dirtyFiles.length > 0) {
      sections.push(git.dirtyFiles.slice(0, 20).join('\n'));
    }
    sections.push(`Unpushed commits: ${git.unpushedCount}`);
    if (git.unpushedCommits.length > 0) {
      sections.push(git.unpushedCommits.slice(0, 5).join('\n'));
    }
    sections.push('');
  }

  if (diff) {
    // Truncate diff to avoid token explosion
    const maxDiff = 8000;
    const truncated = diff.length > maxDiff ? diff.slice(0, maxDiff) + '\n... (diff truncated)' : diff;
    sections.push('## Diff');
    sections.push(truncated);
    sections.push('');
  }

  if (prompts.length > 0) {
    sections.push('## Recent prompts (what the human last asked for)');
    for (const p of prompts.slice(0, 3)) {
      sections.push(`- "${(p.prompt ?? '').slice(0, 200)}"`);
      if (p.response) {
        sections.push(`  Agent responded: "${(p.response ?? '').slice(0, 300)}"`);
      }
    }
    sections.push('');
  }

  sections.push('Now ACT. Do not just analyze — fix what you can, commit, push, then report what you did and what remains. Be concise.');
  sections.push('When you are completely done, output the exact text UNEOF as your final line.');

  return sections.join('\n');
}
