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

// Re-export from canonical location
export { decodeProjectName, encodeProjectName, resolveProjectPath } from './project-name.ts';
