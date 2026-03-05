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

export function decodeFetchProjectName(slug: string): string {
  // Fetch project slugs are typically just the project directory name
  return slug.replace(/-/g, ' ').trim() || slug;
}
