import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { mergeProjects, autoMergeIdenticalProjects } from '@unturf/unfirehose/db/ingest';

/**
 * POST /api/projects/merge
 *
 * Body: { sourceId: number, targetId: number }
 *   sourceId is dropped; targetId absorbs all sessions, todos, usage_minutes (summed
 *   on overlap), agent_deployments, alerts, agent_actions. The source's encoded name
 *   becomes an alias of the target so future ingest still resolves correctly.
 *
 * Or: { autoIdentity: true } — sweep all (root_commit_hash, origin_url) groups within
 *   a harness slot and merge each into its most-recently-active member. Idempotent.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));

    if (body.autoIdentity) {
      const db = getDb();
      const merged = autoMergeIdenticalProjects(db);
      return NextResponse.json({ merged });
    }

    const sourceId = Number(body.sourceId);
    const targetId = Number(body.targetId);
    if (!Number.isFinite(sourceId) || !Number.isFinite(targetId)) {
      return NextResponse.json({ error: 'sourceId and targetId required' }, { status: 400 });
    }
    if (sourceId === targetId) {
      return NextResponse.json({ error: 'sourceId equals targetId' }, { status: 400 });
    }

    const db = getDb();
    const ok = mergeProjects(db, sourceId, targetId);
    if (!ok) return NextResponse.json({ error: 'merge failed — one or both ids missing' }, { status: 404 });

    return NextResponse.json({ merged: 1, sourceId, targetId });
  } catch (err) {
    return NextResponse.json(
      { error: 'merge failed', detail: String(err) },
      { status: 500 }
    );
  }
}

/**
 * GET /api/projects/merge/candidates
 *
 * Returns groups of project rows that share git identity within a single harness slot.
 * These would all be merged by the next ingest pass; this endpoint surfaces them for
 * inspection.
 */
export async function GET() {
  try {
    const db = getDb();
    const rows = db.prepare(`
      WITH grouped AS (
        SELECT
          CASE WHEN instr(name, ':') = 0 THEN '' ELSE substr(name, 1, instr(name, ':') - 1) END AS prefix,
          root_commit_hash AS root,
          COALESCE(origin_url, '') AS origin,
          id, name, display_name, path, last_cwd_seen
        FROM projects
        WHERE root_commit_hash IS NOT NULL
      )
      SELECT prefix, root, origin, id, name, display_name, path, last_cwd_seen
      FROM grouped
      WHERE (prefix, root, origin) IN (
        SELECT prefix, root, origin FROM grouped GROUP BY prefix, root, origin HAVING COUNT(*) > 1
      )
      ORDER BY prefix, root, origin, id
    `).all() as Array<{
      prefix: string; root: string; origin: string;
      id: number; name: string; display_name: string; path: string | null; last_cwd_seen: string | null;
    }>;

    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = `${r.prefix}|${r.root}|${r.origin}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }

    return NextResponse.json({
      groupCount: groups.size,
      groups: Array.from(groups.values()),
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'candidates failed', detail: String(err) },
      { status: 500 }
    );
  }
}
