/**
 * Which harnesses this machine has, read off the disk.
 *
 * One answer for every place that asks: the first-run wizard, the harness
 * section in Settings, and `make doctor`. The harnesses are the registry's
 * ingested ones (harness-registry.ts), each at the root ingest reads
 * (harness-roots.ts), plus any `~/.<name>/unfirehose` native writer — so
 * this cannot report a harness found at a path ingest never looks at, or
 * miss one it does.
 *
 * Pure filesystem, no database: the doctor runs it before there is one.
 * A harness that writes inside each repository (Aider, `repoFile`) has no
 * root to look at, so callers that know our projects pass their roots
 * (db/project-roots.ts); without them it reads as not found.
 */
import { readdirSync, statSync, accessSync, constants } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { harnessRootsInHome } from './fleet-roots';
import { ingestedHarnesses, harnessById } from './harness-registry';
import { HARNESS_ROOTS } from './harness-roots';
import { foreignSessionFiles } from './harness-files';
import type { HarnessFormat } from './harness-registry';

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
  /** How its session files are laid out; absent for a native `~/.<name>/unfirehose` writer. */
  format?: HarnessFormat;
  /** For a harness that writes inside each repository: the file it writes there. `root` then describes, not names, a path. */
  repoFile?: string;
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
  const fixed: HarnessLocation[] = ingestedHarnesses().map((h) => ({
    id: h.id, label: h.label, doc: h.doc, format: h.format,
    root: h.repoFile ? `<each project's root>/${h.repoFile}` : HARNESS_ROOTS[h.id](),
    ...(h.repoFile ? { repoFile: h.repoFile } : {}),
    ...(h.start ? { start: h.start } : {}),
  }));
  const seen = new Set(fixed.map((h) => h.root));
  // Any other ~/.<name>/unfirehose is a native unfirehose/1.0 writer; ingest
  // picks them up without registration, so detection does too.
  for (const h of harnessRootsInHome(home)) {
    if (seen.has(h.root)) continue;
    seen.add(h.root);
    // A native writer the registry documents keeps its own label and doc.
    const known = harnessById(h.name);
    fixed.push({ id: h.name, label: known?.label ?? h.name, root: h.root, doc: known?.doc ?? 'jsonl-format.md' });
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
function survey(root: string, maxFiles: number, format?: HarnessFormat): { files: number; newestMs: number | null; truncated: boolean } {
  // A format with its own layout (Codex's dated tree, Gemini's chats/,
  // Continue's flat .json) is listed the way ingest lists it.
  const foreign = format ? foreignSessionFiles(format, root) : null;
  if (foreign) {
    let newestMs: number | null = null;
    const counted = foreign.slice(0, maxFiles);
    for (const f of counted) {
      try {
        const m = statSync(f).mtimeMs;
        if (newestMs === null || m > newestMs) newestMs = m;
      } catch { /* gone between listing and stat */ }
    }
    return { files: counted.length, newestMs, truncated: foreign.length > maxFiles };
  }
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

/**
 * A `repoFile` harness: its file in each of our projects' roots. Found when
 * any root holds one; readable when every one found can be read.
 */
function surveyRepos(loc: HarnessLocation, roots: string[], maxFiles: number): HarnessDetection {
  const files = roots.flatMap((r) => foreignSessionFiles(loc.format!, r) ?? []);
  let newestMs: number | null = null;
  let unreadable: string | null = null;
  for (const f of files.slice(0, maxFiles)) {
    try { accessSync(f, constants.R_OK); } catch { unreadable ??= f; continue; }
    try {
      const m = statSync(f).mtimeMs;
      if (newestMs === null || m > newestMs) newestMs = m;
    } catch { /* gone between listing and stat */ }
  }
  const counted = Math.min(files.length, maxFiles);
  const where = files.length === 1 ? files[0] : `${loc.repoFile} in ${files.length} of our ${roots.length} project roots`;
  return {
    ...loc, root: files.length ? (unreadable ?? where) : loc.root, found: files.length > 0, readable: !unreadable,
    files: counted, newestMs, truncated: files.length > maxFiles,
  };
}

export function detectHarnesses(opts: { home?: string; maxFiles?: number; projectRoots?: string[] } = {}): HarnessDetection[] {
  const maxFiles = opts.maxFiles ?? 20_000;
  return harnessLocations(opts.home).map((loc) => {
    if (loc.repoFile) return surveyRepos(loc, opts.projectRoots ?? [], maxFiles);
    if (!isDir(loc.root)) return { ...loc, found: false, readable: false, files: 0, newestMs: null, truncated: false };
    let readable = true;
    try { accessSync(loc.root, constants.R_OK | constants.X_OK); } catch { readable = false; }
    if (!readable) return { ...loc, found: true, readable, files: 0, newestMs: null, truncated: false };
    return { ...loc, found: true, readable, ...survey(loc.root, maxFiles, loc.format) };
  });
}
