import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { getProjectActivity, getProjectRecentPrompts } from '@/lib/db/ingest';
import { claudePaths } from '@/lib/claude-paths';
import type { SessionsIndex } from '@/lib/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Average blended rate for rough per-project cost estimates (2026 Opus rates)
const AVG_RATE = { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 };

function gitExec(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

async function resolveRepoPath(projectName: string): Promise<string | null> {
  try {
    const raw = await readFile(claudePaths.sessionsIndex(projectName), 'utf-8');
    const index: SessionsIndex = JSON.parse(raw);
    return index.originalPath ?? null;
  } catch {
    return null;
  }
}

interface GitContext {
  isDirty: boolean;
  unpushedCount: number;
  recentCommits: Array<{ hash: string; subject: string; date: string }>;
  remoteUrl: string | null;
}

async function getGitContext(projectName: string): Promise<GitContext | null> {
  const repoPath = await resolveRepoPath(projectName);
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
  try {
    const days = Number(request.nextUrl.searchParams.get('days') ?? '30');
    const project = request.nextUrl.searchParams.get('project');

    const activity = getProjectActivity(days) as any[];

    // Compute per-project cost estimates using blended rate
    const enriched = activity.map((p: any) => {
      const costEstimate =
        ((p.total_input ?? 0) / 1_000_000) * AVG_RATE.input +
        ((p.total_output ?? 0) / 1_000_000) * AVG_RATE.output +
        ((p.total_cache_read ?? 0) / 1_000_000) * AVG_RATE.cacheRead +
        ((p.total_cache_write ?? 0) / 1_000_000) * AVG_RATE.cacheWrite;

      return {
        ...p,
        cost_estimate: Math.round(costEstimate * 100) / 100,
      };
    });

    // If a specific project is requested, include recent prompts + git context
    if (project) {
      const [prompts, gitCtx] = await Promise.all([
        Promise.resolve(getProjectRecentPrompts(project, 10)),
        getGitContext(project),
      ]);
      const proj = enriched.find((p: any) => p.name === project);
      const matched = matchPromptsToCommits(prompts, gitCtx);
      return NextResponse.json({
        project: proj ?? null,
        recentPrompts: matched,
        git: gitCtx ? {
          isDirty: gitCtx.isDirty,
          unpushedCount: gitCtx.unpushedCount,
          remoteUrl: gitCtx.remoteUrl,
        } : null,
      });
    }

    return NextResponse.json(enriched);
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to get activity', detail: String(err) },
      { status: 500 }
    );
  }
}
