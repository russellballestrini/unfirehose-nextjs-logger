import { readGitState } from '@/lib/git-state';
import { matchPromptsToCommits, type GitContext } from '@/lib/prompt-commits';
import { NextRequest, NextResponse } from 'next/server';
import { readProjectList } from '@unturf/unfirehose/projects-list';
import { rollupTarget } from '@unturf/unfirehose/project-rollup';
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

/**
 * Per-project cost, cached beside the activity rows it is derived from.
 *
 * It was recomputed on every request even when the rows came from cache:
 * one calcCostBreakdown per (project, model, day) over the whole window.
 * Measured 2026-09-04 at days=365, that is 2.8-3.4 SECONDS of pure
 * arithmetic — and the projects page polls this every 10 seconds, so a
 * third of a core went to recalculating an answer that had not changed.
 * Nothing in it can change without the rows changing.
 */
const costCache = new Map<number, { data: Map<string, { cost: number; market: number; avoided: number }>; ts: number }>();

async function getGitContext(projectName: string): Promise<GitContext | null> {
  const repoPath = repoPathForProject(projectName);
  if (!repoPath) return null;

  try {
    const [state, logRaw, remoteRaw] = await Promise.all([
      // Dirty and unpushed are shared with our agent report, which reports
      // the same two facts about the same repository.
      readGitState(repoPath),
      gitExec(repoPath, ['log', '--format=%h|||%s|||%aI', '-20']).catch(() => ''),
      gitExec(repoPath, ['remote', 'get-url', 'origin']).catch(() => null),
    ]);
    const log = logRaw;
    const remote = remoteRaw;

    return {
      isDirty: state.isDirty,
      unpushedCount: state.unpushedCount,
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

/**
 * Collapse activity rows onto the projects a reader actually has.
 *
 * The path filter above catches scratch directories that carry a path. Most
 * do not — 6,961 rows came back for thirty days, at 2.4MB, when the folded
 * project list holds about a hundred. Each row here is folded into the repo
 * its name identifies, the same rule the Projects page uses, so the two
 * pages agree about what a project is and a workspace's work still counts
 * toward its repo rather than vanishing or standing beside it.
 */
function foldToProjects(rows: any[]): any[] {
  const folded = readProjectList()?.payload;
  // Before the worker has ever built the list there is nothing to fold onto;
  // the path filter alone is what we had, and is what we return.
  if (!folded?.length) return rows;
  const names = new Set(folded.map((p) => p.name));
  const out = new Map<string, any>();
  for (const r of rows) {
    const target = names.has(r.name) ? r.name : rollupTarget(r.name, names);
    if (!target) continue;
    const acc = out.get(target);
    if (!acc) { out.set(target, { ...r, name: target }); continue; }
    for (const k of ['user_messages', 'assistant_messages', 'session_count', 'active_days',
                     'total_input', 'total_output', 'total_cache_read', 'total_cache_write']) {
      acc[k] = (acc[k] ?? 0) + (r[k] ?? 0);
    }
    if ((r.last_activity ?? '') > (acc.last_activity ?? '')) acc.last_activity = r.last_activity;
  }
  // A folded row keeps the repo's own display name and path, not a child's.
  for (const p of folded) {
    const acc = out.get(p.name);
    if (acc) { acc.display_name = p.displayName; acc.path = p.path || acc.path; }
  }
  return [...out.values()];
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
      : foldToProjects(activity.filter((r: any) => !isWorkspacePath(r.path) && !isEphemeralPath(r.path)));

    // Per-project cost, summed over each model that actually ran there.
    const cachedCost = costCache.get(days);
    const costFromCache = cachedCost && Date.now() - cachedCost.ts < ACTIVITY_TTL;
    const costByProject = costFromCache
      ? cachedCost!.data
      : (() => {
          ensurePricingHydrated();
          const acc0 = new Map<string, { cost: number; market: number; avoided: number }>();
          for (const r of getProjectModelActivity(days)) {
            const selfHosted = isSelfHosted(r.model, r.endpoint, r.provider);
            const c = calcCostBreakdown(
              r.model, r.input, r.output, r.cache_read, r.cache_write,
              { selfHosted, at: r.day },
            );
            const acc = acc0.get(r.name) ?? { cost: 0, market: 0, avoided: 0 };
            acc.cost += c.total;
            acc.market += c.market;
            acc.avoided += c.avoided;
            acc0.set(r.name, acc);
          }
          costCache.set(days, { data: acc0, ts: Date.now() });
          return acc0;
        })();
    t.mark(costFromCache ? 'cost_cache' : 'cost');

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
