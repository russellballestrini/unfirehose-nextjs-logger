import { readFile, readdir, stat } from 'fs/promises';
import { claudePaths } from '@unturf/unfirehose/claude-paths';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import type { SessionsIndex } from '@unturf/unfirehose/types';

/**
 * Resolve a Claude project name (e.g. "-home-fox-git-unfirehose-nextjs-logger")
 * back to its original filesystem path by testing which `-` are directory separators.
 * Uses DFS, preferring longer segments (fewer splits) to handle ambiguous hyphens.
 */
async function resolveProjectPath(projectName: string): Promise<string | undefined> {
  const parts = projectName.replace(/^-/, '').split('-');

  async function resolve(idx: number, prefix: string): Promise<string | undefined> {
    if (idx >= parts.length) {
      try { await stat(prefix); return prefix; } catch { return undefined; }
    }
    // Try consuming remaining parts as one segment first (fewest splits = most likely)
    for (let end = parts.length; end > idx; end--) {
      const segment = parts.slice(idx, end).join('-');
      const candidate = `${prefix}/${segment}`;
      try {
        const s = await stat(candidate);
        if (end === parts.length) return candidate; // final segment, path exists
        if (s.isDirectory()) {
          const result = await resolve(end, candidate);
          if (result) return result;
        }
      } catch {
        // Not a valid path at this split
      }
    }
    return undefined;
  }

  return resolve(0, '');
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ project: string }> }
) {
  const { project } = await params;

  try {
    let index: SessionsIndex;
    try {
      const raw = await readFile(claudePaths.sessionsIndex(project), 'utf-8');
      index = JSON.parse(raw);
      // Backfill originalPath if missing from index
      if (!index.originalPath) {
        index.originalPath = await resolveProjectPath(project);
      }
    } catch {
      // No index — build from JSONL filenames + enrich from DB
      const files = await readdir(claudePaths.projectDir(project));
      const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
      const sessionIds = jsonlFiles.map((f) => f.replace('.jsonl', ''));

      const db = getDb();
      const dbSessions = sessionIds.length > 0
        ? db.prepare(
            `SELECT s.session_uuid, s.git_branch, s.first_prompt, s.last_message_at,
                    COUNT(m.id) as message_count
             FROM sessions s
             LEFT JOIN messages m ON m.session_id = s.id
             WHERE s.session_uuid IN (${sessionIds.map(() => '?').join(',')})
             GROUP BY s.session_uuid`
          ).all(...sessionIds) as Array<{
            session_uuid: string; git_branch: string | null;
            first_prompt: string | null; last_message_at: string | null;
            message_count: number;
          }>
        : [];
      const dbMap = new Map(dbSessions.map(r => [r.session_uuid, r]));

      // Try to resolve the original filesystem path from the project name
      const derivedPath = await resolveProjectPath(project);

      index = {
        originalPath: derivedPath,
        entries: sessionIds.map((id) => {
          const row = dbMap.get(id);
          return {
            sessionId: id,
            messageCount: row?.message_count ?? 0,
            gitBranch: row?.git_branch ?? undefined,
            firstPrompt: row?.first_prompt ?? undefined,
            modified: row?.last_message_at ?? undefined,
          };
        }),
      };
    }

    const url = new URL(request.url);
    const sort = url.searchParams.get('sort') ?? 'modified';
    const order = url.searchParams.get('order') ?? 'desc';

    const sorted = [...index.entries].sort((a, b) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const aVal = String((a as any)[sort] ?? '');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bVal = String((b as any)[sort] ?? '');
      return order === 'desc' ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
    });

    // Augment with display names from DB
    const db = getDb();
    const uuids = sorted.map(s => s.sessionId);
    const displayNames: Record<string, string> = {};
    if (uuids.length > 0) {
      const rows = db.prepare(
        `SELECT session_uuid, display_name FROM sessions WHERE session_uuid IN (${uuids.map(() => '?').join(',')})`
      ).all(...uuids) as Array<{ session_uuid: string; display_name: string | null }>;
      for (const row of rows) {
        if (row.display_name) displayNames[row.session_uuid] = row.display_name;
      }
    }

    return NextResponse.json({
      project,
      originalPath: index.originalPath,
      sessions: sorted.map(s => ({
        ...s,
        displayName: displayNames[s.sessionId] ?? null,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to list sessions', detail: String(err) },
      { status: 500 }
    );
  }
}
