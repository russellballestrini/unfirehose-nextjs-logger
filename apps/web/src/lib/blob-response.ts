/**
 * Serving a file from our content-addressed store.
 *
 * Two routes did this — todo attachments and archived tool results — and the
 * copies had not stayed level. tool-results checked that the hash was a bare
 * sha256 before letting it into a path, and reduced the download name to its
 * basename with quotes stripped. attachments did neither: it joined the URL
 * segment straight onto a directory, and interpolated a filename chosen by
 * whoever uploaded the file into a quoted header value.
 *
 * Neither gap was reachable today — hashes are computed server-side on
 * upload, so a traversing hash never lands in a row — but the second one
 * only needed a file named `a".png` to put an attacker's text into a
 * response header. The strict version is the one that survives here.
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import { UNFIREHOSE_DIR, getDb } from '@unturf/unfirehose/db/schema';

const SHA256 = /^[a-f0-9]{64}$/;

/** Where a blob lives, once we trust its name. */
export const blobPath = (hash: string) => path.join(UNFIREHOSE_DIR, 'attachments', hash);

/**
 * Reduce an arbitrary stored name to something safe to put in a header:
 * no directory parts, no quotes to close the value early, no control
 * characters to start a new header line.
 */
export function downloadName(name: string | null | undefined, fallback: string): string {
  const base = path.basename(name ?? '').replace(/["\\]/g, '').replace(/[\x00-\x1f\x7f]/g, '');
  return base || fallback;
}

/**
 * The file at `hash`, or the reason it cannot be served.
 *
 * Content addressing is what makes the immutable cache honest: the bytes at
 * a hash cannot change, so a year is not too long.
 */
export function serveBlob(
  hash: string,
  { mimeType, filename }: { mimeType?: string | null; filename?: string | null },
): Response {
  if (!SHA256.test(hash)) {
    return new Response('Invalid hash', { status: 400 });
  }

  const file = blobPath(hash);
  if (!existsSync(file)) {
    return new Response('File not found on disk', { status: 404 });
  }

  return new Response(readFileSync(file), {
    headers: {
      'Content-Type': mimeType || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${downloadName(filename, hash)}"`,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

/**
 * A route that serves one blob, given the query that finds its row.
 *
 * Both callers had shrunk to the same twenty-two lines — await the params,
 * read one row, 404, hand off — so the shape of the route is now stated once
 * and each route keeps only the query that is actually its own. `sql` takes
 * the hash as its one parameter and selects `mime_type` and `filename`; a
 * stored path is fine as the filename, serveBlob reduces it to a basename.
 */
export function blobRoute(sql: string) {
  return async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ hash: string }> },
  ) {
    try {
      const { hash } = await params;
      const row = getDb().prepare(sql).get(hash) as
        { mime_type: string | null; filename: string | null } | undefined;
      if (!row) return new Response('Not found', { status: 404 });
      return serveBlob(hash, { mimeType: row.mime_type, filename: row.filename });
    } catch (err) {
      return new Response(String(err), { status: 500 });
    }
  };
}
