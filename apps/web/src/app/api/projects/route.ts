import { readdir, readFile, stat } from 'fs/promises';
import { claudePaths, decodeProjectName } from '@unturf/unfirehose/claude-paths';
import { NextResponse } from 'next/server';
import type { ProjectInfo, SessionsIndex } from '@unturf/unfirehose/types';

// In-memory cache — 30s TTL
let cache: { data: ProjectInfo[]; ts: number } | null = null;
const CACHE_TTL = 30_000;

// Try to resolve actual filesystem path from encoded project name
function resolvePathFromName(name: string): string[] {
  const parts = name.replace(/^-/, '').split('-');
  const gitIdx = parts.lastIndexOf('git');
  if (gitIdx < 0 || gitIdx >= parts.length - 1) return [];

  const prefix = '/' + parts.slice(0, gitIdx + 1).join('/');
  const projectParts = parts.slice(gitIdx + 1);
  const candidates = [prefix + '/' + projectParts.join('-')];

  if (projectParts.length >= 2) {
    const lastPart = projectParts[projectParts.length - 1];
    if (['com', 'net', 'org', 'io', 'dev', 'ai', 'app'].includes(lastPart)) {
      candidates.push(prefix + '/' + projectParts.slice(0, -1).join('-') + '.' + lastPart);
      candidates.push(prefix + '/' + projectParts.join('.'));
    }
  }
  return candidates;
}

async function resolvePathFromNameAsync(name: string): Promise<string> {
  const candidates = resolvePathFromName(name);
  // Test all candidates in parallel
  const results = await Promise.all(
    candidates.map(async (p) => {
      try { return (await stat(p)).isDirectory() ? p : ''; } catch { return ''; }
    })
  );
  return results.find(Boolean) || '';
}

async function loadOneProject(dir: string): Promise<ProjectInfo | null> {
  try {
    const dirStat = await stat(claudePaths.projectDir(dir)).catch(() => null);
    if (!dirStat?.isDirectory()) return null;

    let sessionCount = 0;
    let totalMessages = 0;
    let latestActivity = '';
    let projectPath = '';

    try {
      const indexRaw = await readFile(claudePaths.sessionsIndex(dir), 'utf-8');
      const index: SessionsIndex = JSON.parse(indexRaw);
      sessionCount = index.entries.length;
      totalMessages = index.entries.reduce((s, e) => s + (e.messageCount ?? 0), 0);
      const dates = index.entries
        .map((e) => e.modified ?? e.created ?? '')
        .filter(Boolean)
        .sort();
      latestActivity = dates[dates.length - 1] ?? '';
      projectPath = index.originalPath ?? '';
    } catch {
      try {
        const files = await readdir(claudePaths.projectDir(dir));
        sessionCount = files.filter((f) => f.endsWith('.jsonl')).length;
      } catch { /* empty */ }
    }

    if (!projectPath) {
      projectPath = await resolvePathFromNameAsync(dir);
    }

    return {
      name: dir,
      displayName: decodeProjectName(dir),
      path: projectPath,
      sessionCount,
      totalMessages,
      latestActivity,
      hasMemory: false, // skip — not used in UI anymore
    };
  } catch {
    return null;
  }
}

export async function GET() {
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json(cache.data);
  }

  try {
    const projectDirs = await readdir(claudePaths.projects);

    // Load all projects in parallel
    const results = await Promise.all(projectDirs.map(loadOneProject));
    const projects = results.filter(Boolean) as ProjectInfo[];
    projects.sort((a, b) => b.latestActivity.localeCompare(a.latestActivity));

    cache = { data: projects, ts: Date.now() };
    return NextResponse.json(projects);
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to list projects', detail: String(err) },
      { status: 500 }
    );
  }
}
