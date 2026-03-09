import { homedir } from 'os';
import path from 'path';

const UNCLOSEAI_DIR = path.join(homedir(), '.uncloseai');

export const uncloseaiPaths = {
  root: UNCLOSEAI_DIR,
  sessions: path.join(UNCLOSEAI_DIR, 'sessions'),

  projectDir(cwdSlug: string) {
    return path.join(UNCLOSEAI_DIR, 'sessions', cwdSlug);
  },

  sessionFile(cwdSlug: string, sessionId: string) {
    return path.join(UNCLOSEAI_DIR, 'sessions', cwdSlug, `${sessionId}.jsonl`);
  },
};

// Re-export from canonical location — same encoding as Claude Code
export { decodeProjectName as decodeUncloseaiProjectName } from './project-name.ts';
