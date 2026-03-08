import { NextRequest } from 'next/server';
import { getDb, UNFIREHOSE_DIR } from '@unturf/unfirehose/db/schema';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ hash: string }> }
) {
  try {
    const { hash } = await params;
    const db = getDb();

    const row = db.prepare(
      'SELECT mime_type, filename FROM todo_attachments WHERE hash = ?'
    ).get(hash) as any;

    if (!row) {
      return new Response('Not found', { status: 404 });
    }

    const filePath = path.join(UNFIREHOSE_DIR, 'attachments', hash);

    if (!existsSync(filePath)) {
      return new Response('File not found on disk', { status: 404 });
    }

    const buffer = readFileSync(filePath);

    return new Response(buffer, {
      headers: {
        'Content-Type': row.mime_type || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${row.filename}"`,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (err: any) {
    return new Response(err.message, { status: 500 });
  }
}
