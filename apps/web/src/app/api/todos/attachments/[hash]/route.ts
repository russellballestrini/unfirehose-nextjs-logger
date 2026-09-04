import { blobRoute } from '@/lib/blob-response';

/** Serve an uploaded todo attachment by content hash. */
export const GET = blobRoute((db, hash) => {
  const row = db
    .prepare('SELECT mime_type, filename FROM todo_attachments WHERE hash = ?')
    .get(hash) as { mime_type: string | null; filename: string | null } | undefined;
  return row && { mimeType: row.mime_type, filename: row.filename };
});
