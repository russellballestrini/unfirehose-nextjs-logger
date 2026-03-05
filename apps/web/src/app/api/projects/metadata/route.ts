import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { execFile } from 'child_process';
import path from 'path';
import { claudePaths } from '@sexy-logger/core/claude-paths';
import type { ProjectMetadata, GitRemote, GitCommit, SessionsIndex } from '@sexy-logger/core/types';

// Module-level cache: project -> { data, ts }
const cache = new Map<string, { data: ProjectMetadata; ts: number }>();
const CACHE_TTL = 60_000; // 60s

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

async function fetchMetadata(projectName: string): Promise<ProjectMetadata> {
  const repoPath = await resolveRepoPath(projectName) ?? '';
  let branch: string | null = null;
  let remotes: GitRemote[] = [];
  let recentCommits: GitCommit[] = [];

  if (repoPath) {
    // Branch
    try {
      branch = await gitExec(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    } catch { /* not a git repo or no commits */ }

    // Remotes
    try {
      const raw = await gitExec(repoPath, ['remote', '-v']);
      remotes = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [name, rest] = line.split('\t');
          const match = rest?.match(/^(\S+)\s+\((fetch|push)\)$/);
          return match ? { name, url: match[1], type: match[2] as 'fetch' | 'push' } : null;
        })
        .filter((r): r is GitRemote => r !== null);
    } catch { /* no remotes */ }

    // Recent commits
    try {
      const raw = await gitExec(repoPath, [
        'log', '--format=%h|||%s|||%an|||%aI', '-10',
      ]);
      recentCommits = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, subject, author, date] = line.split('|||');
          return { hash, subject, author, date };
        });
    } catch { /* no commits */ }
  }

  // CLAUDE.md
  let claudeMd: string | null = null;
  let claudeMdExists = false;

  if (repoPath) {
    try {
      const full = await readFile(path.join(repoPath, 'CLAUDE.md'), 'utf-8');
      claudeMdExists = true;
      claudeMd = full.slice(0, 500);
    } catch { /* no CLAUDE.md */ }
  }

  return { repoPath, branch, remotes, recentCommits, claudeMd, claudeMdExists };
}

export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get('project');
  if (!project) {
    return NextResponse.json({ error: 'Missing ?project= param' }, { status: 400 });
  }

  // Check cache
  const cached = cache.get(project);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  try {
    const data = await fetchMetadata(project);
    cache.set(project, { data, ts: Date.now() });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to fetch metadata', detail: String(err) },
      { status: 500 }
    );
  }
}
