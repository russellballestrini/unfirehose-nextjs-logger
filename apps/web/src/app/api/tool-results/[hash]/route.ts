import { NextRequest } from 'next/server';
import { getDb, UNFIREHOSE_DIR } from '@unturf/unfirehose/db/schema';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Serve an archived tool-result payload by content hash. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ hash: string }> }
) {
  try {
    const { hash } = await params;

    // Reject anything that is not a bare sha256 — the hash lands in a path.
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      return new Response('Invalid hash', { status: 400 });
    }

    const db = getDb();
    const row = db
      .prepare('SELECT rel_path, mime_type FROM tool_results WHERE hash = ? LIMIT 1')
      .get(hash) as any;

    if (!row) {
      return new Response('Not found', { status: 404 });
    }

    const filePath = path.join(UNFIREHOSE_DIR, 'attachments', hash);
    if (!existsSync(filePath)) {
      return new Response('File not found on disk', { status: 404 });
    }

    // Strip any directory part — a nested spill's rel_path would otherwise
    // smuggle separators into the Content-Disposition filename.
    const downloadName = path.basename(row.rel_path).replace(/"/g, '');

    return new Response(readFileSync(filePath), {
      headers: {
        'Content-Type': row.mime_type || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${downloadName}"`,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (err: any) {
    return new Response(err.message, { status: 500 });
  }
}
