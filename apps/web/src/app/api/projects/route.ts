import { readdir, readFile, stat } from 'fs/promises';
import { claudePaths, decodeProjectName } from '@unfirehose/core/claude-paths';
import { NextResponse } from 'next/server';
import type { ProjectInfo, SessionsIndex } from '@unfirehose/core/types';

// Try to resolve actual filesystem path from encoded project name
// e.g. "-home-fox-git-unsandbox-com" → check if /home/fox/git/unsandbox-com or similar exists
async function resolvePathFromName(name: string): Promise<string> {
  // The name encodes the full path with - replacing /
  // We know the pattern is typically /home/<user>/git/<project>
  const parts = name.replace(/^-/, '').split('-');
  const gitIdx = parts.lastIndexOf('git');
  if (gitIdx < 0 || gitIdx >= parts.length - 1) return '';

  const prefix = '/' + parts.slice(0, gitIdx + 1).join('/');
  const projectParts = parts.slice(gitIdx + 1);

  // Try the exact dash-joined name first (most common)
  const dashJoined = prefix + '/' + projectParts.join('-');
  try {
    const s = await stat(dashJoined);
    if (s.isDirectory()) return dashJoined;
  } catch {}

  // Try with dots for common TLD patterns (e.g. unsandbox-com → unsandbox.com)
  if (projectParts.length >= 2) {
    const lastPart = projectParts[projectParts.length - 1];
    if (['com', 'net', 'org', 'io', 'dev', 'ai', 'app'].includes(lastPart)) {
      // Try replacing last dash with dot
      const dotted = prefix + '/' + projectParts.slice(0, -1).join('-') + '.' + lastPart;
      try {
        const s = await stat(dotted);
        if (s.isDirectory()) return dotted;
      } catch {}

      // Try replacing all dashes with dots
      const allDots = prefix + '/' + projectParts.join('.');
      try {
        const s = await stat(allDots);
        if (s.isDirectory()) return allDots;
      } catch {}
    }
  }

  return '';
}

export async function GET() {
  try {
    const projectDirs = await readdir(claudePaths.projects);
    const projects: ProjectInfo[] = [];

    for (const dir of projectDirs) {
      const dirStat = await stat(claudePaths.projectDir(dir)).catch(() => null);
      if (!dirStat?.isDirectory()) continue;

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
        // No index — count JSONL files
        try {
          const files = await readdir(claudePaths.projectDir(dir));
          sessionCount = files.filter((f) => f.endsWith('.jsonl')).length;
        } catch { /* empty project dir */ }
      }

      // If no path from sessions index, try to resolve from directory name
      if (!projectPath) {
        projectPath = await resolvePathFromName(dir);
      }

      const hasMemory = await stat(claudePaths.memory(dir))
        .then(() => true)
        .catch(() => false);

      projects.push({
        name: dir,
        displayName: decodeProjectName(dir),
        path: projectPath,
        sessionCount,
        totalMessages,
        latestActivity,
        hasMemory,
      });
    }

    projects.sort((a, b) => b.latestActivity.localeCompare(a.latestActivity));
    return NextResponse.json(projects);
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to list projects', detail: String(err) },
      { status: 500 }
    );
  }
}
