import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import {
  dryRunTrainingExport, parseTrainingExportQuery, resolveProjectId, trainingExportFacets, trainingExportLines,
} from '@unturf/unfirehose/training-export';
import { redactForExport } from '@unturf/unfirehose/pii';

/**
 * GET /api/training-export?project=&model=&harness=&from=&to=&toolErrors=&minTurns=&maxTurns=&reasoning=&tools=&metadata=&toolResultMaxChars=&limit=&dryRun=1
 *
 * Our sessions as supervised fine-tuning data (ticket 4011 item 8), one
 * `{"messages":[…]}` line per session, every string redacted for secrets,
 * home paths and PII. Streams NDJSON as a download; `dryRun=1` runs the same
 * pass and answers counts, redactions by type, the byte size and our first
 * example instead; `facets=1` answers the harnesses and models a filter form
 * can offer. Shape and rendering: packages/core/training-export.ts.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const filters = parseTrainingExportQuery(q);
  if ('error' in filters) return NextResponse.json({ error: filters.error }, { status: 400 });

  const db = getDb();
  let scope = 'all';
  if (filters.project) {
    const id = resolveProjectId(db, filters.project);
    if (id === null) return NextResponse.json({ error: `Project not found: "${filters.project}"` }, { status: 404 });
    // The display name, never the encoded dir: that one carries a username.
    const row = db.prepare('SELECT display_name FROM projects WHERE id = ?').get(id) as { display_name: string };
    scope = redactForExport(row.display_name).text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  }

  if (q.get('facets') === '1') {
    return NextResponse.json(trainingExportFacets(db, filters.project), { headers: { 'Cache-Control': 'no-store' } });
  }

  if (q.get('dryRun') === '1' || q.get('dryRun') === 'true') {
    try {
      return NextResponse.json(dryRunTrainingExport(db, filters), { headers: { 'Cache-Control': 'no-store' } });
    } catch (err) {
      return NextResponse.json({ error: 'Failed to build training export', detail: String(err) }, { status: 500 });
    }
  }

  const lines = trainingExportLines(db, filters);
  const encoder = new TextEncoder();
  // Pull, not push: the next session is read only when the client has taken
  // the last chunk, so a slow download never piles our database up in memory.
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      let chunk = '';
      try {
        while (chunk.length < 64 * 1024) {
          const next = lines.next();
          if (next.done) {
            if (chunk) controller.enqueue(encoder.encode(chunk));
            controller.close();
            return;
          }
          chunk += next.value;
        }
        controller.enqueue(encoder.encode(chunk));
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      lines.return(undefined);
    },
  });

  const day = new Date().toISOString().slice(0, 10);
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="unfirehose-training-${scope}-${day}.jsonl"`,
      'Cache-Control': 'no-store',
    },
  });
}
