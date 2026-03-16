import { watch, type FSWatcher } from 'fs';
import { stat } from 'fs/promises';
import { claudePaths } from '../claude-paths';
import { fetchPaths } from '../fetch-paths';
import { nativeHarnesses } from './ingest';
import { ingestAll } from './ingest';

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
  }
  ingesting = false;
}

function debouncedIngest() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(onFileChange, DEBOUNCE_MS);
}

export async function startWatcher() {
  if (watcher) return;

  // Watch Claude Code (custom adapter — uses sessions-index.json)
  try {
    watcher = watch(claudePaths.projects, { recursive: true }, (_event, filename) => {
      if (filename && (filename.endsWith('.jsonl') || filename.endsWith('sessions-index.json'))) {
        debouncedIngest();
      }
    });
    console.log('[watcher] watching', claudePaths.projects);
  } catch (err) {
    console.error('[watcher] failed to start:', err);
  }

  // Watch Fetch (custom adapter)
  if (!fetchWatcher && fetchPaths.root) {
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
    if (harnessWatchers.has(harness.name)) continue;
    const exists = await stat(harness.root).catch(() => null);
    if (!exists?.isDirectory()) continue;
    try {
      const w = watch(harness.root, { recursive: true }, (_event, filename) => {
        if (filename && filename.endsWith('.jsonl')) {
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
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
