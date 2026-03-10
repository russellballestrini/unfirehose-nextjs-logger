import path from 'path';
import os from 'os';

/**
 * Path helpers for agnt unfirehose/1.0 JSONL session data.
 *
 * agnt is a Tier 1 native adopter — writes unfirehose/1.0 directly to:
 *   ~/.agnt/unfirehose/{project-slug}/{session-uuid}.jsonl
 *
 * Override with UNFIREHOSE_DIR env var if agnt writes elsewhere.
 */

const AGNT_UNFIREHOSE_DIR = process.env.AGNT_UNFIREHOSE_DIR
  || path.join(os.homedir(), '.agnt', 'unfirehose');

export const agntPaths = {
  root: AGNT_UNFIREHOSE_DIR,

  projectDir(slug: string) {
    return path.join(AGNT_UNFIREHOSE_DIR, slug);
  },

  sessionFile(slug: string, sessionId: string) {
    return path.join(AGNT_UNFIREHOSE_DIR, slug, `${sessionId}.jsonl`);
  },
};

// Re-export from canonical location
export { decodeProjectName as decodeAgntProjectName } from './project-name';
