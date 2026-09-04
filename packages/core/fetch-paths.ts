import path from 'path';
import os from 'os';
import { harnessPaths } from './harness-paths';

/**
 * Fetch writes to ~/.fetch/sessions/{project-slug}/{session-id}.jsonl.
 * Override the root with FETCH_JSONL_DIR.
 */
export const fetchPaths = harnessPaths(
  process.env.FETCH_JSONL_DIR ?? path.join(os.homedir(), '.fetch', 'sessions'),
);
