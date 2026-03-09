import path from 'path';
import os from 'os';

/**
 * Path helpers for Fetch JSONL session data.
 *
 * Fetch writes JSONL to ~/.fetch/sessions/{project-slug}/{session-id}.jsonl.
 * Override with FETCH_JSONL_DIR env var if Fetch writes elsewhere.
 */

const FETCH_JSONL_DIR = process.env.FETCH_JSONL_DIR
  || path.join(os.homedir(), '.fetch', 'sessions');

export const fetchPaths = {
  root: FETCH_JSONL_DIR,

  projectDir(slug: string) {
    return path.join(FETCH_JSONL_DIR, slug);
  },

  sessionFile(slug: string, sessionId: string) {
    return path.join(FETCH_JSONL_DIR, slug, `${sessionId}.jsonl`);
  },
};

// Re-export from canonical location
export { decodeProjectName as decodeFetchProjectName } from './project-name.ts';
