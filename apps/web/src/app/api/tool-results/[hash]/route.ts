import { NextRequest } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { serveBlob } from '@/lib/blob-response';

/** Serve an archived tool-result payload by content hash. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ hash: string }> },
) {
  try {
    const { hash } = await params;
    const row = getDb()
      .prepare('SELECT rel_path, mime_type FROM tool_results WHERE hash = ? LIMIT 1')
      .get(hash) as { rel_path: string | null; mime_type: string | null } | undefined;

    if (!row) return new Response('Not found', { status: 404 });

    return serveBlob(hash, { mimeType: row.mime_type, filename: row.rel_path });
  } catch (err) {
    return new Response(String(err), { status: 500 });
  }
}
