/** Where a harness process is writing, as far as our host can tell. */
export interface HarnessSession {
  sessionId: string;
  /** The JSONL on the node's disk. */
  path: string;
  /** Encoded project dir the file sits in: claude's `-home-fox-x`, a native harness's `home-fox-x`. */
  project: string;
  /** claude-code for ~/.claude/projects, else the dotdir name (uncloseai, agnt …). */
  harness: string;
  /**
   * How the file was chosen. `born` -- created within a minute after the
   * process started, the strongest tie; `written` -- newest file touched
   * since the process started; `nearest` -- nothing written since it
   * started (a resumed session at its prompt), so the newest file at all.
   */
  matched: 'named' | 'born' | 'written' | 'nearest';
}

interface HarnessSessionCandidate { path: string; mtime: number; birth: number | null; authoritative?: boolean }
interface HarnessSessionProc { start: number; cwd: string; files: HarnessSessionCandidate[] }

/**
 * The HARNESS_SESSIONS section: `pid|proc|start_epoch|cwd`, then
 * `pid|file|mtime|birth|path` for each JSONL in that cwd's project dirs.
 */
export function parseHarnessSessions(raw: string): Map<number, HarnessSessionProc> {
  const out = new Map<number, HarnessSessionProc>();
  if (!raw || raw === 'n/a') return out;
  for (const line of raw.split('\n')) {
    const parts = line.split('|');
    const pid = parseInt(parts[0] ?? '');
    if (!Number.isFinite(pid) || parts.length < 3) continue;
    if (parts[1] === 'proc') {
      out.set(pid, { start: parseInt(parts[2] ?? '') || 0, cwd: parts.slice(3).join('|'), files: [] });
    } else if ((parts[1] === 'file' || parts[1] === 'idfile') && parts.length >= 5) {
      const p = out.get(pid);
      if (!p) continue;
      const birth = parseInt(parts[3] ?? '');
      p.files.push({
        path: parts.slice(4).join('|'),
        mtime: parseInt(parts[2] ?? '') || 0,
        // stat prints 0 (or "-") for a filesystem that does not record birth.
        birth: Number.isFinite(birth) && birth > 0 ? birth : null,
        // An idfile is the file the command line resumes by id -- the tie is
        // exact, not inferred, so it wins over every heuristic below.
        authoritative: parts[1] === 'idfile',
      });
    }
  }
  return out;
}

/** What a path under ~/.claude/projects or ~/.<harness>/unfirehose says about itself. */
function sessionFromPath(path: string): Pick<HarnessSession, 'sessionId' | 'project' | 'harness'> | null {
  const m = path.match(/\/\.([^/]+)\/(?:projects|unfirehose)\/([^/]+)\/([^/]+)\.jsonl$/);
  if (!m) return null;
  return { sessionId: m[3]!, project: m[2]!, harness: m[1] === 'claude' ? 'claude-code' : m[1]! };
}

/**
 * The one file a process is writing, from the candidates the probe listed.
 * Ties go by birth first: a session file created within a minute of the
 * process starting is that process's session, however many others share
 * the cwd. Then the newest file written since it started; a subagent
 * forked into the same cwd lands on its parent's file this way, which is
 * where its lines go. Last, the newest file at all, marked as a guess.
 */
export function resolveHarnessSession(p: HarnessSessionProc, harness?: string): HarnessSession | null {
  // Only files of the process's own harness: an unclose run from a claude
  // session shares its cwd, and claude's file is the newest thing there,
  // but nothing unclose says lands in it. ps calls claude "claude"; the
  // dotdir is .claude and the harness key claude-code.
  const own = harness ? p.files.filter((f) => {
    const h = sessionFromPath(f.path)?.harness;
    return h === harness || (h === 'claude-code' && harness === 'claude');
  }) : p.files;
  if (own.length === 0) return null;
  // The command line named this session by id: exact, not inferred.
  const named = own.filter((f) => f.authoritative).sort((a, b) => b.mtime - a.mtime)[0];
  if (named) {
    const id = sessionFromPath(named.path);
    if (id) return { ...id, path: named.path, matched: 'named' };
  }
  const byMtimeDesc = [...own].sort((a, b) => b.mtime - a.mtime);
  const born = own
    .filter((f) => f.birth !== null && f.birth >= p.start - 5 && f.birth <= p.start + 60)
    .sort((a, b) => (a.birth! - p.start) - (b.birth! - p.start))[0];
  const pick = born
    ? { f: born, matched: 'born' as const }
    : byMtimeDesc[0]!.mtime >= p.start
      ? { f: byMtimeDesc[0]!, matched: 'written' as const }
      : { f: byMtimeDesc[0]!, matched: 'nearest' as const };
  const id = sessionFromPath(pick.f.path);
  return id ? { ...id, path: pick.f.path, matched: pick.matched } : null;
}

/** Hang a session on each harness process row that the probe could place. */
export function attachHarnessSessions<P extends { pid: number; harness?: string }>(
  procs: P[], sessions: Map<number, HarnessSessionProc>,
): (P & { cwd?: string; session?: HarnessSession | null })[] {
  if (sessions.size === 0) return procs;
  return procs.map((p) => {
    const s = sessions.get(p.pid);
    return s ? { ...p, cwd: s.cwd, session: resolveHarnessSession(s, p.harness) } : p;
  });
}
