import { readdir, readFile, stat } from 'fs/promises';
import { watch, createReadStream } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import { claudePaths } from '@/lib/claude-paths';
import { decodeProjectName } from '@/lib/claude-paths';
import type { SessionsIndex } from '@/lib/types';

interface TrackedFile {
  path: string;
  project: string;
  sessionId: string;
  size: number;
  originalPath?: string;
}

async function findHotSessions(): Promise<TrackedFile[]> {
  const cutoff = Date.now() - 10 * 60 * 1000; // last 10 minutes
  const hot: TrackedFile[] = [];

  const projectDirs = await readdir(claudePaths.projects).catch(() => []);

  for (const dir of projectDirs) {
    const projDir = claudePaths.projectDir(dir);
    const dirStat = await stat(projDir).catch(() => null);
    if (!dirStat?.isDirectory()) continue;

    // Check sessions-index for recent sessions
    try {
      const indexRaw = await readFile(claudePaths.sessionsIndex(dir), 'utf-8');
      const index: SessionsIndex = JSON.parse(indexRaw);

      for (const entry of index.entries) {
        const modified = entry.modified ? new Date(entry.modified).getTime() : 0;
        if (modified < cutoff) continue;

        const filePath = claudePaths.sessionFile(dir, entry.sessionId);
        const fstat = await stat(filePath).catch(() => null);
        if (!fstat) continue;

        // Also check actual file mtime
        if (fstat.mtimeMs >= cutoff) {
          hot.push({
            path: filePath,
            project: dir,
            sessionId: entry.sessionId,
            size: fstat.size,
            originalPath: index.originalPath,
          });
        }
      }
    } catch {
      // No index — scan JSONL files directly
      try {
        const files = await readdir(projDir);
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          const filePath = path.join(projDir, f);
          const fstat = await stat(filePath).catch(() => null);
          if (fstat && fstat.mtimeMs >= cutoff) {
            hot.push({
              path: filePath,
              project: dir,
              sessionId: f.replace('.jsonl', ''),
              size: fstat.size,
            });
          }
        }
      } catch { /* skip */ }
    }
  }

  return hot;
}

async function readNewLines(
  filePath: string,
  fromByte: number
): Promise<{ lines: string[]; newSize: number }> {
  const fstat = await stat(filePath).catch(() => null);
  if (!fstat || fstat.size <= fromByte) {
    return { lines: [], newSize: fromByte };
  }

  return new Promise((resolve) => {
    const lines: string[] = [];
    const stream = createReadStream(filePath, {
      start: fromByte,
      encoding: 'utf-8',
    });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (line.trim()) lines.push(line);
    });
    rl.on('close', () => {
      resolve({ lines, newSize: fstat.size });
    });
    rl.on('error', () => {
      resolve({ lines, newSize: fromByte });
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

      async function scanAndEmit() {
        if (closed) return;

        const hotFiles = await findHotSessions();

        // Send session list update
        send({
          type: 'sessions',
          sessions: hotFiles.map((f) => ({
            project: f.project,
            projectName: decodeProjectName(f.project),
            sessionId: f.sessionId,
            originalPath: f.originalPath,
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
                if (['user', 'assistant', 'system'].includes(parsed.type)) {
                  send({
                    type: 'entry',
                    project: file.project,
                    projectName: decodeProjectName(file.project),
                    sessionId: file.sessionId,
                    entry: parsed,
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
                if (['user', 'assistant', 'system'].includes(parsed.type)) {
                  send({
                    type: 'entry',
                    project: file.project,
                    projectName: decodeProjectName(file.project),
                    sessionId: file.sessionId,
                    entry: parsed,
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

      // Initial scan
      await scanAndEmit();

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
