import { watch, type FSWatcher } from 'fs';
import { claudePaths } from '../claude-paths';
import { ingestAll } from './ingest';

let watcher: FSWatcher | null = null;
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

export function startWatcher() {
  if (watcher) return;
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
}

export function stopWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
