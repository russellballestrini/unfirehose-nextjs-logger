import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { getProjectActivity, getProjectModelActivity, getProjectRecentPrompts } from '@unturf/unfirehose/db/ingest';
import { calcCostBreakdown, isSelfHosted } from '@unturf/unfirehose/pricing';
import { ensurePricingHydrated } from '@unturf/unfirehose/pricing-sync';
import { isWorkspacePath, isEphemeralPath } from '@unturf/unfirehose/project-rollup';
import { Timing } from '@/lib/timing';
import { repoPathForProject } from '@unturf/unfirehose/db/repo-path';
import { gitExec } from '@unturf/unfirehose/git-exec';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Per-project cost is computed per MODEL against the price catalog. It used to
// use one blended Opus rate for every project, which billed cheap traffic as if
// it were Anthropic's most expensive tier: riseallships runs entirely on
// ox-alpha and a local Qwen and reported $14 against an actual $0.70.

// Cache: activity aggregates are expensive — refresh every 60s
const activityCache = new Map<number, { data: any[]; ts: number }>();
const ACTIVITY_TTL = 60_000;

interface GitContext {
  isDirty: boolean;
  unpushedCount: number;
  recentCommits: Array<{ hash: string; subject: string; date: string }>;
  remoteUrl: string | null;
}

async function getGitContext(projectName: string): Promise<GitContext | null> {
  const repoPath = repoPathForProject(projectName);
  if (!repoPath) return null;

  try {
    const [statusRaw, logRaw, unpushedRaw, remoteRaw] = await Promise.allSettled([
      gitExec(repoPath, ['status', '--porcelain']),
      gitExec(repoPath, ['log', '--format=%h|||%s|||%aI', '-20']),
      gitExec(repoPath, ['log', '--oneline', '@{upstream}..HEAD']).catch(() => ''),
      gitExec(repoPath, ['remote', 'get-url', 'origin']).catch(() => null),
    ]);

    const status = statusRaw.status === 'fulfilled' ? statusRaw.value : '';
    const log = logRaw.status === 'fulfilled' ? logRaw.value : '';
    const unpushed = unpushedRaw.status === 'fulfilled' ? unpushedRaw.value : '';
    const remote = remoteRaw.status === 'fulfilled' ? remoteRaw.value : null;

    return {
      isDirty: status.length > 0,
      unpushedCount: unpushed ? unpushed.split('\n').filter(Boolean).length : 0,
      recentCommits: log.split('\n').filter(Boolean).map((line) => {
        const [hash, subject, date] = line.split('|||');
        return { hash, subject, date };
      }),
      remoteUrl: remote,
    };
  } catch {
    return null;
  }
}

function matchPromptsToCommits(
  prompts: Array<{ prompt: string; timestamp: string; session_uuid: string; response: string | null }>,
  gitCtx: GitContext | null
) {
  if (!gitCtx) {
    return prompts.map((p) => ({
      prompt: (p.prompt ?? '').slice(0, 200),
      timestamp: p.timestamp,
      sessionId: p.session_uuid,
      response: (p.response ?? '').slice(0, 2000) || null,
      gitStatus: null as string | null,
      commitHash: null as string | null,
      commitSubject: null as string | null,
    }));
  }

  const commits = gitCtx.recentCommits.map((c) => ({
    ...c,
    ts: new Date(c.date).getTime(),
  }));

  return prompts.map((p) => {
    const promptTs = new Date(p.timestamp).getTime();
    // Find commits that happened AFTER this prompt within a 2-hour window
    // (agent works on prompt, then commits the result)
    const WINDOW_MS = 2 * 60 * 60 * 1000;
    const candidates = commits.filter(
      (c) => c.ts >= promptTs && c.ts - promptTs < WINDOW_MS
    );
    // Pick the closest commit after the prompt
    const match = candidates.length > 0
      ? candidates.reduce((a, b) => (a.ts < b.ts ? a : b))
      : null;

    let gitStatus: string | null = null;
    if (match) {
      gitStatus = 'committed';
    } else {
      // Check if this is a very recent prompt that might still be in flight
      const ageMs = Date.now() - promptTs;
      if (ageMs < WINDOW_MS) {
        // Recent prompt, check if working tree is dirty
        gitStatus = gitCtx.isDirty ? 'uncommitted' : (gitCtx.unpushedCount > 0 ? 'unpushed' : null);
      }
      // Older prompts with no matching commit — might be conversation/planning, leave null
    }

    return {
      prompt: (p.prompt ?? '').slice(0, 200),
      timestamp: p.timestamp,
      sessionId: p.session_uuid,
      response: (p.response ?? '').slice(0, 2000) || null,
      gitStatus,
      commitHash: match?.hash ?? null,
      commitSubject: match?.subject ?? null,
    };
  });
}

export async function GET(request: NextRequest) {
  const t = new Timing();
  try {
    const days = Number(request.nextUrl.searchParams.get('days') ?? '30');
    const project = request.nextUrl.searchParams.get('project');

    const cached = activityCache.get(days);
    const fromCache = cached && Date.now() - cached.ts < ACTIVITY_TTL;
    const activity: any[] = fromCache
      ? cached!.data
      : (() => {
          const fresh = getProjectActivity(days) as any[];
          activityCache.set(days, { data: fresh, ts: Date.now() });
          return fresh;
        })();
    t.mark(fromCache ? 'activity_cache' : 'activity_query');

    // A fleet worker is the most recently active thing on this box almost
    // every minute of a run, so an unfiltered list puts 2,455 of them above
    // every real repo — including in the sidebar, which takes the top five.
    // Asking for one by name still returns it; only the list is filtered.
    const listed = project
      ? activity
      : activity.filter((r: any) => !isWorkspacePath(r.path) && !isEphemeralPath(r.path));

    // Per-project cost, summed over each model that actually ran there.
    ensurePricingHydrated();
    const costByProject = new Map<string, { cost: number; market: number; avoided: number }>();
    for (const r of getProjectModelActivity(days)) {
      const selfHosted = isSelfHosted(r.model, r.endpoint, r.provider);
      const c = calcCostBreakdown(
        r.model, r.input, r.output, r.cache_read, r.cache_write,
        { selfHosted, at: r.day },
      );
      const acc = costByProject.get(r.name) ?? { cost: 0, market: 0, avoided: 0 };
      acc.cost += c.total;
      acc.market += c.market;
      acc.avoided += c.avoided;
      costByProject.set(r.name, acc);
    }
    t.mark('cost');

    const enriched = listed.map((p: any) => {
      const c = costByProject.get(p.name) ?? { cost: 0, market: 0, avoided: 0 };
      return {
        ...p,
        cost_estimate: Math.round(c.cost * 100) / 100,
        market_estimate: Math.round(c.market * 100) / 100,
        avoided_estimate: Math.round(c.avoided * 100) / 100,
      };
    });
    t.mark('enrich');

    // If a specific project is requested, include recent prompts + git context
    if (project) {
      const [prompts, gitCtx] = await Promise.all([
        Promise.resolve(getProjectRecentPrompts(project, 10)),
        getGitContext(project),
      ]);
      t.mark('prompts_git');
      const proj = enriched.find((p: any) => p.name === project);
      const matched = matchPromptsToCommits(prompts, gitCtx);
      t.mark('match_commits');
      return NextResponse.json({
        project: proj ?? null,
        recentPrompts: matched,
        git: gitCtx ? {
          isDirty: gitCtx.isDirty,
          unpushedCount: gitCtx.unpushedCount,
          remoteUrl: gitCtx.remoteUrl,
        } : null,
      }, { headers: { 'Server-Timing': t.header() } });
    }

    return NextResponse.json(enriched, { headers: { 'Server-Timing': t.header() } });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to get activity', detail: String(err) },
      { status: 500 }
    );
  }
}
