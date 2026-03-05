import { homedir } from 'os';
import path from 'path';

const CLAUDE_DIR = path.join(homedir(), '.claude');

export const claudePaths = {
  root: CLAUDE_DIR,
  projects: path.join(CLAUDE_DIR, 'projects'),
  statsCache: path.join(CLAUDE_DIR, 'stats-cache.json'),
  history: path.join(CLAUDE_DIR, 'history.jsonl'),
  debug: path.join(CLAUDE_DIR, 'debug'),
  todos: path.join(CLAUDE_DIR, 'todos'),
  tasks: path.join(CLAUDE_DIR, 'tasks'),
  plans: path.join(CLAUDE_DIR, 'plans'),

  projectDir(projectName: string) {
    return path.join(CLAUDE_DIR, 'projects', projectName);
  },

  sessionsIndex(projectName: string) {
    return path.join(CLAUDE_DIR, 'projects', projectName, 'sessions-index.json');
  },

  sessionFile(projectName: string, sessionId: string) {
    return path.join(CLAUDE_DIR, 'projects', projectName, `${sessionId}.jsonl`);
  },

  subagentsDir(projectName: string, sessionId: string) {
    return path.join(CLAUDE_DIR, 'projects', projectName, sessionId, 'subagents');
  },

  memory(projectName: string) {
    return path.join(CLAUDE_DIR, 'projects', projectName, 'memory', 'MEMORY.md');
  },
};

export function decodeProjectName(encoded: string): string {
  // The directory names encode the full path with - replacing / and .
  // e.g. "-home-fox-git-unsandbox-com" -> "unsandbox.com" (approximate)
  // Best effort: extract the last meaningful segment after "git"
  const parts = encoded.replace(/^-/, '').split('-');
  const gitIdx = parts.lastIndexOf('git');
  if (gitIdx >= 0 && gitIdx < parts.length - 1) {
    return parts.slice(gitIdx + 1).join('-');
  }
  return parts.slice(-2).join('-') || encoded;
}
