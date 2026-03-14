/**
 * Project name encoding/decoding — the single source of truth.
 *
 * Claude Code (and other harnesses) encode filesystem paths as directory names:
 *   /home/fox/git/unfirehose-nextjs-logger → -home-fox-git-unfirehose-nextjs-logger
 *
 * Rules:
 *   encode: replace every `/` with `-`, replace `.` with `-`
 *   decode: ambiguous (dashes in real directory names), so we use filesystem probing
 *
 * This module is client-safe (pure functions) except resolveProjectPath which needs `fs`.
 */

/**
 * Encode a filesystem path into a project name slug.
 *   /home/fox/git/my-project  →  -home-fox-git-my-project
 *   /home/fox/git/unsandbox.com  →  -home-fox-git-unsandbox-com
 */
export function encodeProjectName(fsPath: string): string {
  return fsPath.replace(/[/.]/g, '-');
}

/**
 * Best-effort display name from an encoded project name.
 * Extracts the segment after the last `git` directory, or falls back to the last 2 segments.
 * This is NOT a path decoder — use resolveProjectPath for that.
 *
 *   -home-fox-git-unfirehose-nextjs-logger  →  unfirehose-nextjs-logger
 *   -home-fox-git-unsandbox-com             →  unsandbox-com
 *   -home-fox-myproject                     →  fox-myproject
 */
export function decodeProjectName(encoded: string): string {
  const parts = encoded.replace(/^-/, '').split('-');
  const gitIdx = parts.lastIndexOf('git');
  if (gitIdx >= 0 && gitIdx < parts.length - 1) {
    return parts.slice(gitIdx + 1).join('-');
  }
  return parts.slice(-2).join('-') || encoded;
}

/**
 * Resolve an encoded project name back to its original filesystem path.
 *
 * Strategy (in order):
 * 1. DB lookup (projects.path column)
 * 2. sessions-index.json originalPath
 * 3. Filesystem probing: try all possible dash-splits, stat each candidate,
 *    prefer longer segments (fewer splits) to handle ambiguous hyphens.
 *
 * Returns null if no valid path found.
 */
export async function resolveProjectPath(
  encoded: string,
  opts?: {
    dbLookup?: (name: string) => string | null;
    sessionsIndexPath?: string;
  }
): Promise<string | null> {
  // 1. DB lookup
  if (opts?.dbLookup) {
    const dbPath = opts.dbLookup(encoded);
    if (dbPath) return dbPath;
  }

  // 2. sessions-index.json
  if (opts?.sessionsIndexPath) {
    try {
      const { readFile } = await import('fs/promises');
      const raw = await readFile(opts.sessionsIndexPath, 'utf-8');
      const index = JSON.parse(raw);
      if (index.originalPath) return index.originalPath;
    } catch { /* no index */ }
  }

  // 3. Filesystem probing — DFS with greedy segment merging
  const { existsSync, statSync } = await import('fs');
  const parts = encoded.replace(/^-/, '').split('-');

  function probe(idx: number, prefix: string): string | null {
    if (idx >= parts.length) {
      // Check if this path exists and is a directory
      try {
        if (existsSync(prefix) && statSync(prefix).isDirectory()) return prefix;
      } catch { /* */ }
      return null;
    }
    // Try longest segment first (greedy: fewer splits = more likely correct)
    // For each segment length, try both '-' and '.' joins (e.g. unhomeschool-com vs unhomeschool.com)
    for (let end = parts.length; end > idx; end--) {
      const subParts = parts.slice(idx, end);
      const candidates = [subParts.join('-')];
      // Try '.' join for domain-style names (e.g. unsandbox.com, unhomeschool.com)
      if (subParts.length >= 2) {
        candidates.push(subParts.slice(0, -1).join('-') + '.' + subParts[subParts.length - 1]);
      }
      for (const segment of candidates) {
        const candidate = prefix + '/' + segment;
        const result = probe(end, candidate);
        if (result) return result;
      }
    }
    return null;
  }

  return probe(0, '');
}
