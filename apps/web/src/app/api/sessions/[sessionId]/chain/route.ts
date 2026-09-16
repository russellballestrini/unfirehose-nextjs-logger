import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { getDb } from '@unturf/unfirehose/db/schema';
import { getSessionChain, getAnchorEvents } from '@unturf/unfirehose/db/provenance-ingest';
import { verifyLines } from '@unturf/unfirehose/provenance';
import { harnessFor } from '@unturf/unfirehose/session-paths';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/sessions/{sessionId}/chain[?project=…&live=1]
 *
 * The session's provenance verdict — `unchained` / `open` / `verified` /
 * `corrupted` — as the ingester recorded it, with the break index and
 * reason when there is one and the root the closed record committed to.
 *
 * `live=1` (needs `project`) re-reads the journal from disk and verifies
 * it now, so the page can show a verdict for a session ingest has not
 * reached yet, or confirm the recorded one against the file as it is
 * this second. A trailing partial line (a writer mid-write) is set aside
 * and reported as `partialTail`, never counted as a break.
 *
 * `events` lists every finding by line index — each leaf the witness saw
 * differ (`rewritten`, or `hash_mismatch` when the line's bytes changed
 * under its own hash), each range of lines the file lost, each chain
 * break the verifier hit — oldest line first, up to 200.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const url = new URL(request.url);
  const project = url.searchParams.get('project');
  const live = url.searchParams.get('live') === '1';

  const recorded = getSessionChain(getDb(), sessionId);
  const body: Record<string, unknown> = {
    sessionId,
    recorded: recorded ?? null,
    state: recorded?.state ?? 'unchained',
    events: getAnchorEvents(getDb(), sessionId, 200),
  };

  if (live) {
    if (!project) {
      return NextResponse.json({ error: 'project query param required for live=1' }, { status: 400 });
    }
    const { adapter, slug } = harnessFor(project);
    const filePath = adapter.sessionFile(slug, sessionId);
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch {
      return NextResponse.json({ ...body, live: null, error: 'Session file not found', path: filePath }, { status: 404 });
    }
    let partialTail = false;
    if (text.length && !text.endsWith('\n')) {
      text = text.slice(0, text.lastIndexOf('\n') + 1);
      partialTail = true;
    }
    const rep = verifyLines(text.split('\n'));
    body.live = { ...rep, partialTail, path: filePath };
    body.state = rep.state;
  }

  return NextResponse.json(body);
}
