import { homedir } from 'os';
import path from 'path';

const UNCLOSEAI_DIR = path.join(homedir(), '.uncloseai');

export const uncloseaiPaths = {
  root: UNCLOSEAI_DIR,
  unfirehose: path.join(UNCLOSEAI_DIR, 'unfirehose'),

  projectDir(cwdSlug: string) {
    return path.join(UNCLOSEAI_DIR, 'unfirehose', cwdSlug);
  },

  sessionFile(cwdSlug: string, sessionId: string) {
    return path.join(UNCLOSEAI_DIR, 'unfirehose', cwdSlug, `${sessionId}.jsonl`);
  },
};

// Re-export from canonical location — same encoding as Claude Code
export { decodeProjectName as decodeUncloseaiProjectName } from './project-name';
