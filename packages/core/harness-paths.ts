/**
 * Where a harness writes its JSONL.
 *
 * Three modules stated the same three functions — a root, a directory per
 * project slug, a file per session — differing only in which directory they
 * start from. Adding a fourth harness meant copying the shape again and
 * hoping it matched.
 *
 * Native unfirehose/1.0 adopters all use the same layout:
 *   {root}/{project-slug}/{session-uuid}.jsonl
 * so the layout belongs here and only the root belongs to each harness.
 */

import path from 'path';

export interface HarnessPaths {
  root: string;
  projectDir(slug: string): string;
  sessionFile(slug: string, sessionId: string): string;
}

export function harnessPaths(root: string): HarnessPaths {
  return {
    root,
    projectDir: (slug) => path.join(root, slug),
    sessionFile: (slug, sessionId) => path.join(root, slug, `${sessionId}.jsonl`),
  };
}
