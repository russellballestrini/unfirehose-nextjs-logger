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

export function decodeUncloseaiProjectName(cwdSlug: string): string {
  const parts = cwdSlug.split('-');
  const gitIdx = parts.lastIndexOf('git');
  if (gitIdx >= 0 && gitIdx < parts.length - 1) {
    return parts.slice(gitIdx + 1).join('-');
  }
  return parts.slice(-2).join('-') || cwdSlug;
}
