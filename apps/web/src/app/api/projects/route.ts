import { readdir, readFile, stat } from 'fs/promises';
import { claudePaths } from '@unturf/unfirehose/claude-paths';
import { decodeProjectName, resolveProjectPath } from '@unturf/unfirehose/project-name';
import { NextResponse } from 'next/server';
import type { ProjectInfo, SessionsIndex } from '@unturf/unfirehose/types';

// In-memory cache — 30s TTL
let cache: { data: ProjectInfo[]; ts: number } | null = null;
const CACHE_TTL = 30_000;

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
      projectPath = (await resolveProjectPath(dir)) ?? '';
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
