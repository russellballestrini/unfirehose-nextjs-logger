import { blobRoute } from '@/lib/blob-response';

/** Serve an archived tool-result payload by content hash. */
export const GET = blobRoute('SELECT mime_type, rel_path AS filename FROM tool_results WHERE hash = ? LIMIT 1');
