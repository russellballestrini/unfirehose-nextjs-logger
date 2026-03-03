import { readdir, readFile } from 'fs/promises';
import { claudePaths } from '@/lib/claude-paths';
import { streamJsonl } from '@/lib/jsonl-reader';
import { NextRequest, NextResponse } from 'next/server';
import type { SessionsIndex, SessionEntry } from '@/lib/types';

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const projectFilter = url.searchParams.get('project');
  const limit = parseInt(url.searchParams.get('limit') ?? '100');
  const typesParam = url.searchParams.get('types');
  const types = typesParam?.split(',') ?? ['user', 'assistant', 'system'];

  try {
    const projectDirs = await readdir(claudePaths.projects);
    const allEntries: (SessionEntry & { _project: string })[] = [];

    for (const dir of projectDirs) {
      if (projectFilter && dir !== projectFilter) continue;

      let sessionIds: string[] = [];
      try {
        const indexRaw = await readFile(claudePaths.sessionsIndex(dir), 'utf-8');
        const index: SessionsIndex = JSON.parse(indexRaw);
        // Take the most recent sessions only
        sessionIds = index.entries
          .sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''))
          .slice(0, 5)
          .map((e) => e.sessionId);
      } catch {
        continue;
      }

      for (const sid of sessionIds) {
        const filePath = claudePaths.sessionFile(dir, sid);
        try {
          for await (const entry of streamJsonl<SessionEntry>(filePath, {
            types,
            limit: 50,
          })) {
            (entry as SessionEntry & { _project: string })._project = dir;
            allEntries.push(entry as SessionEntry & { _project: string });
          }
        } catch {
          // skip
        }
      }
    }

    // Sort all entries by timestamp
    allEntries.sort((a, b) => {
      const ta = ('timestamp' in a ? String(a.timestamp) : '') ?? '';
      const tb = ('timestamp' in b ? String(b.timestamp) : '') ?? '';
      return tb.localeCompare(ta);
    });

    return NextResponse.json(allEntries.slice(0, limit));
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to aggregate logs', detail: String(err) },
      { status: 500 }
    );
  }
}
