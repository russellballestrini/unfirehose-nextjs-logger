import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

const TRIAGE_PATH = join(homedir(), '.unfirehose', 'triage.jsonl');

interface TriageEntry {
  project: string;   // project name (e.g. -home-fox-git-unsandbox-com)
  content: string;    // todo content text
  status: string;     // completed, deleted, obsolete
  at: string;         // ISO timestamp
}

// Content hash for fast lookup
function contentKey(project: string, content: string): string {
  return createHash('sha256').update(`${project}\0${content}`).digest('hex').slice(0, 16);
}

// Load all triage decisions into a Set of content keys
let _cache: Set<string> | null = null;
let _cacheTime = 0;

export function loadTriageSet(): Set<string> {
  // Cache for 5 seconds to avoid re-reading on every todo during bulk ingest
  if (_cache && Date.now() - _cacheTime < 5000) return _cache;

  const set = new Set<string>();
  if (!existsSync(TRIAGE_PATH)) {
    _cache = set;
    _cacheTime = Date.now();
    return set;
  }

  const lines = readFileSync(TRIAGE_PATH, 'utf-8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry: TriageEntry = JSON.parse(line);
      if (['completed', 'deleted', 'obsolete'].includes(entry.status)) {
        set.add(contentKey(entry.project, entry.content));
      }
    } catch { /* skip malformed lines */ }
  }

  _cache = set;
  _cacheTime = Date.now();
  return set;
}

// Check if a todo has been triaged (completed/deleted) previously
export function isTriaged(projectName: string, content: string): boolean {
  const set = loadTriageSet();
  return set.has(contentKey(projectName, content));
}

// Record a triage decision — appends to JSONL so it survives DB rebuilds
export function recordTriage(projectName: string, content: string, status: string): void {
  const entry: TriageEntry = {
    project: projectName,
    content,
    status,
    at: new Date().toISOString(),
  };
  mkdirSync(dirname(TRIAGE_PATH), { recursive: true });
  appendFileSync(TRIAGE_PATH, JSON.stringify(entry) + '\n');
  // Invalidate cache
  _cache = null;
}

// Batch record — more efficient for bulk operations
export function recordTriageBatch(entries: Array<{ project: string; content: string; status: string }>): void {
  const now = new Date().toISOString();
  const lines = entries.map(e => JSON.stringify({ project: e.project, content: e.content, status: e.status, at: now }));
  mkdirSync(dirname(TRIAGE_PATH), { recursive: true });
  appendFileSync(TRIAGE_PATH, lines.join('\n') + '\n');
  _cache = null;
}

export const TRIAGE_FILE_PATH = TRIAGE_PATH;
