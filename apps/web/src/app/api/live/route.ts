import { readdir, readFile, stat } from 'fs/promises';
import { readdirSync, statSync, watch, createReadStream } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import os from 'os';
import { claudePaths } from '@unturf/unfirehose/claude-paths';
import { decodeProjectName } from '@unturf/unfirehose/claude-paths';
import type { SessionsIndex } from '@unturf/unfirehose/types';

interface TrackedFile {
  path: string;
  project: string;
  sessionId: string;
  size: number;
  originalPath?: string;
  // Source format dictates how we filter entries on the wire.
  //   'claude'  — Claude Code native (entry.type ∈ {user, assistant, system})
  //   'unfirehose' — unfirehose/1.0 (entry.type === 'message' with entry.role)
  format: 'claude' | 'unfirehose';
  // Display tag for the harness ('claude-code' / 'aborist' / 'agnt' / …).
  // Mirrored into the SSE payload so the live UI can render an
  // origin badge per native harness.
  harness?: string;
}

// Mirror of `discoverNativeHarnesses` from packages/core/db/ingest.ts.
// Re-implemented here to avoid pulling the DB layer into a route
// that runs in the Next.js edge runtime; the discovery itself is a
// 10-line homedir scan.
const EXCLUDED_HARNESS_DIRS = new Set(['unfirehose', 'claude', 'fetch']);

interface NativeHarnessRoot {
  name: string;
  root: string;
}

function discoverNativeHarnessRoots(): NativeHarnessRoot[] {
  const home = os.homedir();
  const out: NativeHarnessRoot[] = [];
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.startsWith('.')) continue;
    const name = entry.slice(1);
    if (!name || EXCLUDED_HARNESS_DIRS.has(name)) continue;
    const ufDir = path.join(home, entry, 'unfirehose');
    try {
      if (statSync(ufDir).isDirectory()) {
        out.push({ name, root: ufDir });
      }
    } catch {
      // no unfirehose subdir — skip
    }
  }
  return out;
}

async function findHotSessions(): Promise<TrackedFile[]> {
  const cutoff = Date.now() - 10 * 60 * 1000; // last 10 minutes
  const hot: TrackedFile[] = [];

  // Claude Code session dirs.
  const projectDirs = await readdir(claudePaths.projects).catch(() => []);

  // Scan one project dir (claude or native-harness slug) and collect any
  // .jsonl files modified within cutoff. Returns an array of TrackedFile.
  async function scanProjectDir(opts: {
    projDir: string;
    project: string;
    format: 'claude' | 'unfirehose';
    harness: string;
    originalPath?: string;
  }): Promise<TrackedFile[]> {
    const out: TrackedFile[] = [];
    let files: string[];
    try {
      files = await readdir(opts.projDir);
    } catch {
      return out;
    }
    const stats = await Promise.all(
      files
        .filter((f) => f.endsWith('.jsonl'))
        .map(async (f) => {
          const filePath = path.join(opts.projDir, f);
          const fstat = await stat(filePath).catch(() => null);
          return { f, filePath, fstat };
        })
    );
    for (const { f, filePath, fstat } of stats) {
      if (fstat && fstat.mtimeMs >= cutoff) {
        out.push({
          path: filePath,
          project: opts.project,
          sessionId: f.replace('.jsonl', ''),
          size: fstat.size,
          originalPath: opts.originalPath,
          format: opts.format,
          harness: opts.harness,
        });
      }
    }
    return out;
  }

  // Claude project dirs — fan out the per-dir scan in parallel.
  const claudeResults = await Promise.all(
    projectDirs.map(async (dir) => {
      const projDir = claudePaths.projectDir(dir);
      const dirStat = await stat(projDir).catch(() => null);
      if (!dirStat?.isDirectory()) return [];

      let originalPath: string | undefined;
      try {
        const indexRaw = await readFile(claudePaths.sessionsIndex(dir), 'utf-8');
        const index: SessionsIndex = JSON.parse(indexRaw);
        originalPath = index.originalPath;
      } catch { /* no index */ }

      return scanProjectDir({
        projDir,
        project: dir,
        format: 'claude',
        harness: 'claude-code',
        originalPath,
      });
    })
  );
  for (const arr of claudeResults) hot.push(...arr);

  // Native harness session dirs (~/.<name>/unfirehose/<slug>/<uuid>.jsonl).
  // Parallel per-harness, parallel per-slug — slowest single dir caps total time.
  const roots = discoverNativeHarnessRoots();
  const nativeResults = await Promise.all(
    roots.map(async (harness) => {
      const slugs = await readdir(harness.root).catch(() => []);
      const slugResults = await Promise.all(
        slugs.map(async (slug) => {
          const slugDir = path.join(harness.root, slug);
          const dirStat = await stat(slugDir).catch(() => null);
          if (!dirStat?.isDirectory()) return [];
          return scanProjectDir({
            projDir: slugDir,
            project: `${harness.name}:${slug}`,
            format: 'unfirehose',
            harness: harness.name,
          });
        })
      );
      return slugResults.flat();
    })
  );
  for (const arr of nativeResults) hot.push(...arr);

  return hot;
}

// Decide whether a parsed JSONL entry is something the live stream
// should emit. Both shapes flow through the same SSE channel; the UI
// extracts text/role generically from `entry.message` (Claude) or
// `entry.content[]` (unfirehose/1.0 — handled in extractText).
function isStreamableEntry(parsed: unknown, format: 'claude' | 'unfirehose'): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const e = parsed as Record<string, unknown>;
  if (format === 'claude') {
    return (
      typeof e.type === 'string' &&
      ['user', 'assistant', 'system'].includes(e.type)
    );
  }
  // unfirehose/1.0: every payload is type='message' with a role.
  // Skip the session-header line (type='session') and the implicit
  // session_end system message — those are envelope-level signals
  // for the DB ingestion, not stream content.
  if (e.type !== 'message') return false;
  if (e.subtype === 'session_end') return false;
  return (
    typeof e.role === 'string' &&
    ['user', 'assistant', 'system'].includes(e.role)
  );
}

async function readNewLines(
  filePath: string,
  fromByte: number
): Promise<{ lines: string[]; newSize: number }> {
  const fstat = await stat(filePath).catch(() => null);
  if (!fstat || fstat.size <= fromByte) {
    return { lines: [], newSize: fromByte };
  }

  // Hard 3s ceiling — actively-written JSONL files (esp. while the producer
  // is mid-flush) can leave the read stream without ever emitting 'close',
  // which would block scanAndEmit forever and starve the SSE heartbeat.
  return new Promise((resolve) => {
    const lines: string[] = [];
    const stream = createReadStream(filePath, {
      start: fromByte,
      encoding: 'utf-8',
    });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let done = false;
    const finish = (newSize: number) => {
      if (done) return;
      done = true;
      try { rl.close(); } catch { /* ignore */ }
      try { stream.destroy(); } catch { /* ignore */ }
      resolve({ lines, newSize });
    };

    const timer = setTimeout(() => finish(fromByte), 3000);

    rl.on('line', (line) => {
      if (line.trim()) lines.push(line);
    });
    rl.on('close', () => {
      clearTimeout(timer);
      finish(fstat.size);
    });
    rl.on('error', () => {
      clearTimeout(timer);
      finish(fromByte);
    });
  });
}

export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Track file sizes for tail behavior
      const fileSizes = new Map<string, number>();
      const watchers: ReturnType<typeof watch>[] = [];
      const watchedDirs = new Set<string>();
      let closed = false;

      function send(data: object) {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          closed = true;
        }
      }

      // Native-harness project keys look like "<harness>:<slug>"; strip the
      // prefix before decoding so the rendered name is just the project, not
      // a duplicate of the harness badge the UI draws separately.
      function displayName(project: string): string {
        const i = project.indexOf(':');
        const slug = i >= 0 ? project.slice(i + 1) : project;
        return decodeProjectName(slug);
      }

      // Concurrency guard. Poll interval fires every 2s but a full scan can
      // take longer under load — without this, scans pile up, libuv saturates,
      // and the SSE goes silent.
      let scanning = false;
      async function scanAndEmit() {
        if (closed || scanning) return;
        scanning = true;
        try {
          const hotFiles = await findHotSessions();
          await runScan(hotFiles);
        } finally {
          scanning = false;
        }
      }

      async function runScan(hotFiles: TrackedFile[]) {

        send({
          type: 'sessions',
          sessions: hotFiles.map((f) => ({
            project: f.project,
            projectName: displayName(f.project),
            sessionId: f.sessionId,
            originalPath: f.originalPath,
            harness: f.harness,
          })),
        });

        // Initialize sizes for new files, read new lines for known files
        for (const file of hotFiles) {
          const prevSize = fileSizes.get(file.path) ?? file.size;

          if (!fileSizes.has(file.path)) {
            // New file — read last 20 lines for initial context
            const { lines } = await readNewLines(file.path, Math.max(0, file.size - 50000));
            const recent = lines.slice(-20);
            for (const line of recent) {
              try {
                const parsed = JSON.parse(line);
                if (isStreamableEntry(parsed, file.format)) {
                  send({
                    type: 'entry',
                    project: file.project,
                    projectName: displayName(file.project),
                    sessionId: file.sessionId,
                    entry: parsed,
                    harness: file.harness,
                  });
                }
              } catch { /* skip */ }
            }
            fileSizes.set(file.path, file.size);
          } else if (file.size > prevSize) {
            // File grew — read new bytes
            const { lines, newSize } = await readNewLines(file.path, prevSize);
            fileSizes.set(file.path, newSize);

            for (const line of lines) {
              try {
                const parsed = JSON.parse(line);
                if (isStreamableEntry(parsed, file.format)) {
                  send({
                    type: 'entry',
                    project: file.project,
                    projectName: displayName(file.project),
                    sessionId: file.sessionId,
                    entry: parsed,
                    harness: file.harness,
                  });
                }
              } catch { /* skip */ }
            }
          }

          // Watch the directory for changes
          const dir = path.dirname(file.path);
          if (!watchedDirs.has(dir)) {
            watchedDirs.add(dir);
            try {
              const w = watch(dir, { persistent: false }, () => {
                // Debounced scan triggered by fs change
                if (!closed) {
                  clearTimeout(fsDebounce);
                  fsDebounce = setTimeout(scanAndEmit, 500);
                }
              });
              watchers.push(w);
            } catch { /* skip unwatchable dirs */ }
          }
        }
      }

      let fsDebounce: ReturnType<typeof setTimeout>;

      // Flush headers + an initial heartbeat right away so the browser opens
      // the EventSource immediately. Without this the first paint waits for
      // scanAndEmit() to complete — and any blocking read in that scan would
      // leave the SSE silent (no headers, no events, no heartbeat).
      try {
        controller.enqueue(encoder.encode(': hello\n\n'));
      } catch {
        closed = true;
      }

      // Kick the scan off without awaiting — start() returns immediately,
      // intervals start ticking, heartbeat keeps the connection visibly alive.
      void scanAndEmit();

      // Poll every 2 seconds as fallback (fs.watch isn't always reliable)
      const pollInterval = setInterval(() => {
        if (closed) {
          clearInterval(pollInterval);
          return;
        }
        scanAndEmit();
      }, 2000);

      // Also scan for new hot sessions every 15 seconds
      const sessionScan = setInterval(async () => {
        if (closed) {
          clearInterval(sessionScan);
          return;
        }
        const hotFiles = await findHotSessions();
        for (const file of hotFiles) {
          if (!fileSizes.has(file.path)) {
            await scanAndEmit();
            break;
          }
        }
      }, 15000);

      // Cleanup on close
      const cleanup = () => {
        closed = true;
        clearInterval(pollInterval);
        clearInterval(sessionScan);
        clearTimeout(fsDebounce);
        for (const w of watchers) {
          try { w.close(); } catch { /* ignore */ }
        }
      };

      // Keep connection alive with heartbeat
      const heartbeat = setInterval(() => {
        if (closed) {
          clearInterval(heartbeat);
          cleanup();
          return;
        }
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          cleanup();
        }
      }, 10000);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
