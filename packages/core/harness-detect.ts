/**
 * Which harnesses this machine has, read off the disk.
 *
 * One answer for every place that asks: the first-run wizard, the harness
 * section in Settings, and `make doctor`. Each root comes from the module
 * that ingest itself reads it from — claudePaths, fetchPaths, uncloseaiPaths,
 * agntPaths, and the `~/.<name>/unfirehose` scan — so this cannot report a
 * harness found at a path ingest never looks at, or miss one it does.
 *
 * Pure filesystem, no database: the doctor runs it before there is one.
 */
import { readdirSync, statSync, accessSync, constants } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { claudePaths } from './claude-paths';
import { fetchPaths } from './fetch-paths';
import { uncloseaiPaths } from './uncloseai-paths';
import { agntPaths } from './agnt-paths';
import { harnessRootsInHome } from './fleet-roots';

export interface HarnessLocation {
  /** The name sessions carry in `sessions.harness`. */
  id: string;
  label: string;
  /** Where its JSONL lives. */
  root: string;
  /** The adapter doc in @unturf/unfirehose-schema, relative to its docs/. */
  doc: string;
  /** How a person starts it writing, for the wizard's "not found" line. */
  start?: string;
}

export interface HarnessDetection extends HarnessLocation {
  found: boolean;
  /** Found but not readable by this process: a permissions problem, not an absence. */
  readable: boolean;
  /** Session files under the root (JSONL, one project level deep). */
  files: number;
  /** mtime of the newest of them, epoch ms. */
  newestMs: number | null;
  /** Counting stopped at `maxFiles`; `files` is a floor. */
  truncated: boolean;
}

/** Every harness root ingest reads, in the order a person would look for them. */
export function harnessLocations(home = homedir()): HarnessLocation[] {
  const fixed: HarnessLocation[] = [
    { id: 'claude-code', label: 'Claude Code', root: claudePaths.projects, doc: 'harnesses/claude-code.md', start: 'cd ~/your/repo && claude' },
    { id: 'fetch', label: 'Fetch', root: fetchPaths.root, doc: 'harnesses/fetch.md' },
    { id: 'uncloseai', label: 'uncloseai-cli', root: uncloseaiPaths.root, doc: 'harnesses/uncloseai-cli.md' },
    { id: 'agnt', label: 'agnt', root: agntPaths.root, doc: 'harnesses/agnt.md' },
  ];
  const seen = new Set(fixed.map((h) => h.root));
  // Any other ~/.<name>/unfirehose is a native unfirehose/1.0 writer; ingest
  // picks them up without registration, so detection does too.
  for (const h of harnessRootsInHome(home)) {
    if (seen.has(h.root)) continue;
    seen.add(h.root);
    fixed.push({ id: h.name, label: h.name, root: h.root, doc: 'jsonl-format.md' });
  }
  return fixed;
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Count `{root}/{project}/*.jsonl` and find the newest. Bounded: a long-lived
 * Claude Code install holds tens of thousands of transcripts, and the wizard
 * polls this.
 */
function survey(root: string, maxFiles: number): { files: number; newestMs: number | null; truncated: boolean } {
  let files = 0;
  let newestMs: number | null = null;
  let projects: string[] = [];
  try { projects = readdirSync(root); } catch { return { files, newestMs, truncated: false }; }
  for (const p of projects) {
    const dir = path.join(root, p);
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      files++;
      try {
        const m = statSync(path.join(dir, n)).mtimeMs;
        if (newestMs === null || m > newestMs) newestMs = m;
      } catch { /* gone between readdir and stat */ }
      if (files >= maxFiles) return { files, newestMs, truncated: true };
    }
  }
  return { files, newestMs, truncated: false };
}

export function detectHarnesses(opts: { home?: string; maxFiles?: number } = {}): HarnessDetection[] {
  const maxFiles = opts.maxFiles ?? 20_000;
  return harnessLocations(opts.home).map((loc) => {
    if (!isDir(loc.root)) return { ...loc, found: false, readable: false, files: 0, newestMs: null, truncated: false };
    let readable = true;
    try { accessSync(loc.root, constants.R_OK | constants.X_OK); } catch { readable = false; }
    if (!readable) return { ...loc, found: true, readable, files: 0, newestMs: null, truncated: false };
    return { ...loc, found: true, readable, ...survey(loc.root, maxFiles) };
  });
}
