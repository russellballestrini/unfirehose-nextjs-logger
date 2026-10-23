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
  // Codex CLI's own rollouts, read in place (codex-adapter.ts).
  codex: () => path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'sessions'),
  // Gemini CLI honours GEMINI_CLI_HOME as its home (packages/core/src/utils/paths.ts).
  'gemini-cli': () => path.join(process.env.GEMINI_CLI_HOME || homedir(), '.gemini', 'tmp'),
  // Continue honours CONTINUE_GLOBAL_DIR (core/util/paths.ts).
  continue: () => path.join(process.env.CONTINUE_GLOBAL_DIR || path.join(homedir(), '.continue'), 'sessions'),
};
