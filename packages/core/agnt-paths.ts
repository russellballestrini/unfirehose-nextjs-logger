import path from 'path';
import os from 'os';
import { harnessPaths } from './harness-paths';

/**
 * agnt is a Tier 1 native adopter — it writes unfirehose/1.0 straight to
 *   ~/.agnt/unfirehose/{project-slug}/{session-uuid}.jsonl
 * Override the root with AGNT_UNFIREHOSE_DIR.
 */
export const agntPaths = harnessPaths(
  process.env.AGNT_UNFIREHOSE_DIR ?? path.join(os.homedir(), '.agnt', 'unfirehose'),
);
