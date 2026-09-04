import { blobRoute } from '@/lib/blob-response';

/** Serve an archived tool-result payload by content hash. */
export const GET = blobRoute((db, hash) => {
  const row = db
    .prepare('SELECT rel_path, mime_type FROM tool_results WHERE hash = ? LIMIT 1')
    .get(hash) as { rel_path: string | null; mime_type: string | null } | undefined;
  // rel_path is a path; serveBlob reduces it to a basename for the header.
  return row && { mimeType: row.mime_type, filename: row.rel_path };
});
