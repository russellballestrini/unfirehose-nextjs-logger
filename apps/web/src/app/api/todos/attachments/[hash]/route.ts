import { blobRoute } from '@/lib/blob-response';

/** Serve an uploaded todo attachment by content hash. */
export const GET = blobRoute('SELECT mime_type, filename FROM todo_attachments WHERE hash = ?');
