import path from 'path';
import os from 'os';
import { harnessPaths } from './harness-paths';

/**
 * uncloseai writes to ~/.uncloseai/unfirehose/{project-slug}/{session-id}.jsonl,
 * with the same slug encoding Claude Code uses.
 */
export const uncloseaiPaths = harnessPaths(
  process.env.UNCLOSEAI_UNFIREHOSE_DIR ?? path.join(os.homedir(), '.uncloseai', 'unfirehose'),
);
