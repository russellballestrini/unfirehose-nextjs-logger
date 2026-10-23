/**
 * Where each ingested harness writes its sessions, server-side.
 *
 * The registry (harness-registry.ts) stays free of node modules so client
 * components can read it; the paths live here, each from the module ingest
 * itself reads it from, so detection and ingest cannot disagree. A test
 * holds this map and the registry's ingested set to the same ids.
 */
import path from 'path';
import { homedir } from 'os';
import { claudePaths } from './claude-paths';
import { fetchPaths } from './fetch-paths';
import { uncloseaiPaths } from './uncloseai-paths';
import { agntPaths } from './agnt-paths';

export const HARNESS_ROOTS: Record<string, () => string> = {
  'claude-code': () => claudePaths.projects,
  fetch: () => fetchPaths.root,
  uncloseai: () => uncloseaiPaths.root,
  agnt: () => agntPaths.root,
  // scripts/codex-bridge.mts writes native unfirehose/1.0 here from
  // $CODEX_HOME/sessions.
  codex: () => process.env.UNFIREHOSE_CODEX_DIR || path.join(homedir(), '.codex', 'unfirehose'),
};
