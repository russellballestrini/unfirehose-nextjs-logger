import { NextRequest } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { serveBlob } from '@/lib/blob-response';

/** Serve an uploaded todo attachment by content hash. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ hash: string }> },
) {
  try {
    const { hash } = await params;
    const row = getDb()
      .prepare('SELECT mime_type, filename FROM todo_attachments WHERE hash = ?')
      .get(hash) as { mime_type: string | null; filename: string | null } | undefined;

    if (!row) return new Response('Not found', { status: 404 });

    return serveBlob(hash, { mimeType: row.mime_type, filename: row.filename });
  } catch (err) {
    return new Response(String(err), { status: 500 });
  }
}
