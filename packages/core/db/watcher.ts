import { watch, type FSWatcher } from 'fs';
import { stat } from 'fs/promises';
import { claudePaths } from '../claude-paths';
import { fetchPaths } from '../fetch-paths';
import { join, sep } from 'path';
import { nativeHarnesses } from './ingest';
import { ingestAll } from './ingest';
import { getDb } from './schema';
import { watchRewriteFile } from './rewrite-watch';

let watcher: FSWatcher | null = null;
let fetchWatcher: FSWatcher | null = null;
const harnessWatchers = new Map<string, FSWatcher>();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let ingesting = false;

const DEBOUNCE_MS = 2000;

// The project directories touched since the last pass. A change event
// names its file, so the pass it triggers reads that file's project and
// nothing else — a full pass stats every journal on the box (~47k, ~4 s
// measured 2026-09-17) and ran after every two-second lull in a session
// that never stops writing. Past MAX_TARGETED_DIRS in one burst (a restore,
// a sync landing) the full pass is cheaper than the bookkeeping.
const MAX_TARGETED_DIRS = 64;
const changedDirs = new Set<string>();

/** The project directory a watched path belongs to: root + first segment. */
function projectDirOf(root: string, filename: string): string {
  return join(root, String(filename).split(sep)[0]);
}

function noteChange(root: string, filename: string) {
  changedDirs.add(projectDirOf(root, filename));
  debouncedIngest();
}

async function onFileChange() {
  // A pass already running: keep what has accumulated and look again after
  // it. Dropping the burst here left its files to the periodic pass, up to
  // a minute later.
  if (ingesting) { debouncedIngest(); return; }
  ingesting = true;
  const dirs = new Set(changedDirs);
  changedDirs.clear();
  try {
    await ingestAll(dirs.size > 0 && dirs.size <= MAX_TARGETED_DIRS ? { dirs } : {});
  } catch (err) {
    console.error('[watcher] ingest failed:', err);
  } finally {
    // Must reset in finally: if the reset is ever skipped (an unexpected throw
    // outside the try, a future early return) the flag sticks true and every
    // later file event is silently dropped by the guard above.
    ingesting = false;
  }
}

function debouncedIngest() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(onFileChange, DEBOUNCE_MS);
}

// The rewrite watch runs per change event, ahead of the ingest debounce:
// a writer that appends a line and rewrites it within two seconds settles
// before the pass ever looks, so the pass can only see the final state.
// One trailing check 150 ms after the last event of a burst, per file.
// Never load-bearing: a failure is logged once and ingest is untouched.
//
// A check reads the whole journal, hashes every line and loads the whole
// shadow, so it costs what the file weighs: a few ms on a young session,
// ~800 ms on an 18 MB one (measured 2026-09-17), and a live session only
// grows. Claude Code fires several events per turn, so on a long session
// that was seconds of every minute spent re-hashing an unchanged prefix.
// The check therefore paces itself: after a check that took T, the next
// one for that file waits at least QUICK_PACE × T. A cheap file is checked
// on every burst as before; an expensive one is checked at a rate that
// keeps it under 1/QUICK_PACE of the worker's time by construction. The
// leading-edge check is gone for the same reason — the trailing one sees
// the same settled state 150 ms later.
const QUICK_TRAIL_MS = 150;
const QUICK_PACE = 10;
const quickNotBefore = new Map<string, number>();
const quickPending = new Map<string, ReturnType<typeof setTimeout>>();
let quickFailed = false;

function quickRewriteCheck(filePath: string) {
  const t0 = Date.now();
  try {
    watchRewriteFile(getDb(), filePath);
  } catch (err) {
    if (!quickFailed) { quickFailed = true; console.error('[watcher] rewrite check failed:', err); }
  }
  const took = Date.now() - t0;
  quickNotBefore.set(filePath, Date.now() + Math.max(QUICK_TRAIL_MS, QUICK_PACE * took));
}

export function onJournalEvent(filePath: string) {
  const pending = quickPending.get(filePath);
  if (pending) clearTimeout(pending);
  const wait = Math.max(QUICK_TRAIL_MS, (quickNotBefore.get(filePath) ?? 0) - Date.now());
  quickPending.set(filePath, setTimeout(() => {
    quickPending.delete(filePath);
    quickRewriteCheck(filePath);
  }, wait));
}

export async function startWatcher() {
  if (watcher) return;

  const enabled = process.env.UNFIREHOSE_HARNESSES?.split(',').map(value => value.trim());

  // Watch Claude Code (custom adapter — uses sessions-index.json)
  try {
    if (!enabled || enabled.includes('claude-code')) watcher = watch(claudePaths.projects, { recursive: true }, (_event, filename) => {
      if (filename && (filename.endsWith('.jsonl') || filename.endsWith('sessions-index.json'))) {
        if (filename.endsWith('.jsonl')) onJournalEvent(join(claudePaths.projects, String(filename)));
        noteChange(claudePaths.projects, String(filename));
      }
    });
    console.log('[watcher] watching', claudePaths.projects);
  } catch (err) {
    console.error('[watcher] failed to start:', err);
  }

  // Watch Fetch (custom adapter)
  if (!fetchWatcher && fetchPaths.root && (!enabled || enabled.includes('fetch'))) {
    try {
      fetchWatcher = watch(fetchPaths.root, { recursive: true }, (_event, filename) => {
        if (filename && filename.endsWith('.jsonl')) {
          noteChange(fetchPaths.root, String(filename));
        }
      });
      console.log('[watcher] watching', fetchPaths.root);
    } catch (err) {
      console.error('[watcher] fetch watch failed:', err);
    }
  }

  // Watch all auto-discovered native harness directories
  for (const harness of nativeHarnesses) {
    if (enabled && !enabled.includes(harness.name)) continue;
    if (harnessWatchers.has(harness.name)) continue;
    const exists = await stat(harness.root).catch(() => null);
    if (!exists?.isDirectory()) continue;
    try {
      const w = watch(harness.root, { recursive: true }, (_event, filename) => {
        if (filename && filename.endsWith('.jsonl')) {
          onJournalEvent(join(harness.root, String(filename)));
          noteChange(harness.root, String(filename));
        }
      });
      harnessWatchers.set(harness.name, w);
      console.log(`[watcher] watching ${harness.name}:`, harness.root);
    } catch (err) {
      console.error(`[watcher] ${harness.name} watch failed:`, err);
    }
  }
}

export function stopWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (fetchWatcher) {
    fetchWatcher.close();
    fetchWatcher = null;
  }
  for (const [name, w] of harnessWatchers) {
    w.close();
    harnessWatchers.delete(name);
  }
  for (const t of quickPending.values()) clearTimeout(t);
  quickPending.clear();
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  changedDirs.clear();
}
