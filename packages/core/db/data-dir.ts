import path from 'path';
import { homedir } from 'os';

/**
 * Our data directory: database, blobs, attachments, triage log.
 *
 * `UNFIREHOSE_DIR` moves all of it, so `make demo` can run against a seeded
 * copy under ~/.unfirehose-demo without touching the real one. Its own
 * module, free of the database, so anything can ask where we live without
 * opening anything.
 */
export const UNFIREHOSE_DIR = process.env.UNFIREHOSE_DIR || path.join(homedir(), '.unfirehose');
