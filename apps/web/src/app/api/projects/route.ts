import { readdir, readFile, stat } from 'fs/promises';
import { claudePaths, decodeProjectName } from '@sexy-logger/core/claude-paths';
import { NextResponse } from 'next/server';
import type { ProjectInfo, SessionsIndex } from '@sexy-logger/core/types';

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
