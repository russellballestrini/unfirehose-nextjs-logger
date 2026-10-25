/**
 * Which files hold a foreign-format harness's sessions, under its root.
 *
 * Ingest (db/ingest-foreign.ts) and detection (harness-detect.ts: the
 * wizard, Settings, `make doctor`) both ask, so the answer lives once, here.
 * Pure filesystem: the doctor asks before there is a database.
 *
 * Listings are remembered against each directory's mtime, which moves when
 * an entry is created, renamed or removed and not when a file grows, so a
 * quiet pass over a Codex tree of a few thousand rollouts costs one stat per
 * directory rather than a readdir.
 */
import { readdirSync, statSync } from 'fs';
import path from 'path';
import type { HarnessFormat } from './harness-registry';
import { AIDER_HISTORY_FILE } from './aider-adapter';

interface Listing { mtimeMs: number; files: string[]; dirs: string[] }
const _cache = new Map<string, Listing>();

function list(dir: string): Listing {
  let mtimeMs: number;
  try { mtimeMs = statSync(dir).mtimeMs; } catch { return { mtimeMs: 0, files: [], dirs: [] }; }
  const hit = _cache.get(dir);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  const files: string[] = [];
  const dirs: string[] = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) dirs.push(e.name);
      else if (e.isFile()) files.push(e.name);
    }
  } catch { /* unreadable: nothing listed */ }
  files.sort();
  dirs.sort();
  const listing = { mtimeMs, files, dirs };
  _cache.set(dir, listing);
  return listing;
}

/** Codex: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl (codex-rs core/src/rollout). */
function codexFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    const l = list(dir);
    for (const f of l.files) if (f.endsWith('.jsonl')) out.push(path.join(dir, f));
    if (depth < 4) for (const d of l.dirs) walk(path.join(dir, d), depth + 1);
  };
  walk(root, 0);
  return out;
}

/**
 * Gemini CLI: ~/.gemini/tmp/<project>/chats/session-*.jsonl, legacy
 * session-*.json, and subagents at chats/<parentSessionId>/<id>.jsonl.
 */
function geminiFiles(root: string): string[] {
  const out: string[] = [];
  for (const project of list(root).dirs) {
    const chats = path.join(root, project, 'chats');
    const l = list(chats);
    for (const f of l.files) if (f.startsWith('session-') && (f.endsWith('.jsonl') || f.endsWith('.json'))) out.push(path.join(chats, f));
    for (const parent of l.dirs) {
      for (const f of list(path.join(chats, parent)).files) if (f.endsWith('.jsonl')) out.push(path.join(chats, parent, f));
    }
  }
  return out;
}

/** Continue: ~/.continue/sessions/<sessionId>.json; sessions.json is the index, not a session. */
function continueFiles(root: string): string[] {
  return list(root).files.filter((f) => f.endsWith('.json') && f !== 'sessions.json').map((f) => path.join(root, f));
}

/**
 * Aider: `<repo root>/.aider.chat.history.md`. Its "root" is one project's
 * directory (db/project-roots.ts names them), so this is a stat, never a
 * listing: a repo's other files are none of our business.
 */
function aiderFiles(root: string): string[] {
  const file = path.join(root, AIDER_HISTORY_FILE);
  try { return statSync(file).isFile() ? [file] : []; } catch { return []; }
}

const LISTERS: Partial<Record<HarnessFormat, (root: string) => string[]>> = {
  'codex-rollout': codexFiles,
  'gemini-chat': geminiFiles,
  'continue-session': continueFiles,
  'aider-history': aiderFiles,
};

/** Every session file of a foreign format under `root`, or null for a format laid out as `{root}/{slug}/{id}.jsonl`. */
export function foreignSessionFiles(format: HarnessFormat, root: string): string[] | null {
  const lister = LISTERS[format];
  return lister ? lister(root) : null;
}
