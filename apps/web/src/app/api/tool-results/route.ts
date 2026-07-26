import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * List archived tool-result spill files.
 *
 * Claude Code writes large tool outputs to a session's tool-results/ dir and
 * keeps only the path in the transcript, then sweeps those files at
 * cleanupPeriodDays. Ingest copies the bytes into our blob store; this is how
 * you find them again afterwards.
 *
 *   ?session=<uuid>     all spills for one session
 *   ?tool_use_id=toolu_...  resolve a specific dangling reference
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const session = searchParams.get('session');
    const toolUseId = searchParams.get('tool_use_id');
    const limit = Math.min(Number(searchParams.get('limit')) || 100, 1000);

    const where: string[] = [];
    const args: any[] = [];
    if (session) {
      where.push('session_uuid = ?');
      args.push(session);
    }
    if (toolUseId) {
      where.push('tool_use_id = ?');
      args.push(toolUseId);
    }

    const db = getDb();
    const rows = db
      .prepare(
        `SELECT session_uuid, tool_use_id, rel_path, mime_type, size_bytes, hash, archived_at
         FROM tool_results
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY archived_at DESC, rel_path ASC
         LIMIT ?`
      )
      .all(...args, limit) as any[];

    return NextResponse.json({
      count: rows.length,
      results: rows.map((r) => ({
        sessionUuid: r.session_uuid,
        toolUseId: r.tool_use_id,
        relPath: r.rel_path,
        mimeType: r.mime_type,
        sizeBytes: r.size_bytes,
        hash: r.hash,
        archivedAt: r.archived_at,
        url: `/api/tool-results/${r.hash}`,
      })),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
