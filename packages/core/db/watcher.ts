import { watch, type FSWatcher } from 'fs';
import { stat } from 'fs/promises';
import { claudePaths } from '../claude-paths';
import { fetchPaths } from '../fetch-paths';
import { join } from 'path';
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

async function onFileChange() {
  if (ingesting) return;
  ingesting = true;
  try {
    await ingestAll();
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
// Leading edge on the first event of a burst, one trailing check 150 ms
// after the last, per file; a check reads one live journal and compares
// it with its shadow (a few ms). Never load-bearing: a failure is logged
// once and ingest is untouched.
const QUICK_TRAIL_MS = 150;
const quickLast = new Map<string, number>();
const quickPending = new Map<string, ReturnType<typeof setTimeout>>();
let quickFailed = false;

function quickRewriteCheck(filePath: string) {
  try {
    watchRewriteFile(getDb(), filePath);
  } catch (err) {
    if (!quickFailed) { quickFailed = true; console.error('[watcher] rewrite check failed:', err); }
  }
}

export function onJournalEvent(filePath: string) {
  const now = Date.now();
  if (now - (quickLast.get(filePath) ?? 0) >= QUICK_TRAIL_MS) {
    quickLast.set(filePath, now);
    quickRewriteCheck(filePath);
  }
  const pending = quickPending.get(filePath);
  if (pending) clearTimeout(pending);
  quickPending.set(filePath, setTimeout(() => {
    quickPending.delete(filePath);
    quickLast.set(filePath, Date.now());
    quickRewriteCheck(filePath);
  }, QUICK_TRAIL_MS));
}

export async function startWatcher() {
  if (watcher) return;

  const enabled = process.env.UNFIREHOSE_HARNESSES?.split(',').map(value => value.trim());

  // Watch Claude Code (custom adapter — uses sessions-index.json)
  try {
    if (!enabled || enabled.includes('claude-code')) watcher = watch(claudePaths.projects, { recursive: true }, (_event, filename) => {
      if (filename && (filename.endsWith('.jsonl') || filename.endsWith('sessions-index.json'))) {
        if (filename.endsWith('.jsonl')) onJournalEvent(join(claudePaths.projects, String(filename)));
        debouncedIngest();
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
          debouncedIngest();
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
          debouncedIngest();
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
}
