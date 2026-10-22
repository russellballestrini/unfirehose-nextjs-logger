// Claude Code session extras: subagent transcripts and spilled tool
// results. The main Claude Code transcript loop lives in ingestAll
// (ingest.ts). Extracted from ingest.ts.
import { readFile, stat, mkdir, writeFile } from 'fs/promises';
import { createReadStream, existsSync, readdirSync } from 'fs';
import { createInterface } from 'readline';
import { createHash } from 'crypto';
import path from 'path';
import { UNFIREHOSE_DIR } from './schema';
import type { getDb } from './schema';
import { claudePaths } from '../claude-paths';
import { normalizeClaudeCodeEntry } from '../claude-code-adapter';
import { knownOffset, readdirSyncSafe, statSyncSafe } from './ingest-cache';
import { getOrCreateSession, insertContentBlocks, insertMessage } from './ingest-rows';
import { extractTodosFromEntry } from './ingest-todos';

/**
 * Walk the subagents/ directory for a Claude Code session and ingest every
 * agent-*.jsonl as its own sidechain session. Idempotent via ingest_offsets;
 * cheap when there are no new bytes.
 */
export async function ingestSubagentsForSession(
  db: ReturnType<typeof getDb>,
  projectDirName: string,
  meta: { sessionId: string; gitBranch?: string },
  projectId: number,
  result: { filesScanned: number; sessionsAdded: number; messagesAdded: number; blocksAdded: number },
): Promise<void> {
  const subagentDir = claudePaths.subagentsDir(projectDirName, meta.sessionId);
  const subagentFiles = readdirSyncSafe(subagentDir, { recursive: true });
  for (const subFile of subagentFiles) {
    const base = path.basename(subFile);
    if (!base.startsWith('agent-') || !base.endsWith('.jsonl')) continue;
    const agentId = path.join(path.dirname(subFile), base.slice('agent-'.length, -'.jsonl'.length));
    const subFilePath = path.join(subagentDir, subFile);
    const subStat = statSyncSafe(subFilePath);
    if (!subStat) continue;

    const subOffset = knownOffset(db, subFilePath);
    const subStartByte = subOffset ?? 0;
    if (subStat.size <= subStartByte) continue;

    result.filesScanned++;

    // Composite session_uuid keeps the parent → subagent link explicit and
    // guarantees uniqueness even if agentId ever collides across parents.
    const subSessionUuid = `${meta.sessionId}/${agentId}`;
    const subSessionId = getOrCreateSession(db, subSessionUuid, projectId, {
      gitBranch: meta.gitBranch,
      isSidechain: true,
      delegatedFrom: meta.sessionId,
      harness: 'claude-code',
    });
    if (subOffset === undefined) result.sessionsAdded++;

    const subStream = createReadStream(subFilePath, {
      start: subStartByte,
      encoding: 'utf-8',
    });
    const subRl = createInterface({ input: subStream, crlfDelay: Infinity });

    const subBatchInsert = db.transaction((lines: string[]) => {
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const normalized = normalizeClaudeCodeEntry(entry);
          if (!normalized) continue;
          normalized.sidechain = true;
          normalized.provider ??= 'anthropic';
          const messageId = insertMessage(db, subSessionId, normalized);
          if (messageId === null) continue;
          result.messagesAdded++;
          if (Array.isArray(normalized.content)) {
            result.blocksAdded += insertContentBlocks(db, messageId, normalized.content);
          }
          // Usage rollup skipped — parent already counted these tokens.
          extractTodosFromEntry(db, projectId, subSessionId, entry, subSessionUuid);
        } catch {
          // skip malformed lines
        }
      }
    });

    const subBatch: string[] = [];
    let subBatchBytes = 0;
    for await (const line of subRl) {
      subBatch.push(line);
      subBatchBytes += Buffer.byteLength(line);
      if (subBatch.length >= 500 || subBatchBytes >= 2 * 1024 * 1024) {
        subBatchInsert(subBatch.splice(0));
        subBatchBytes = 0;
      }
    }
    if (subBatch.length > 0) subBatchInsert(subBatch);

    db.prepare(
      `INSERT INTO ingest_offsets (file_path, byte_offset, last_ingested)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(file_path) DO UPDATE SET
         byte_offset = excluded.byte_offset,
         last_ingested = excluded.last_ingested`
    ).run(subFilePath, subStat.size);

    db.prepare(
      'UPDATE sessions SET updated_at = ? WHERE session_uuid = ?'
    ).run(new Date().toISOString(), subSessionUuid);
  }
}

// Matches todo_attachments — same blob store, same ceiling. Observed spill
// files top out around 2.7MB, so this leaves generous headroom.
const TOOL_RESULT_MAX_BYTES = 10 * 1024 * 1024;

// Spills nest one level when a single tool call renders a document
// (pdf-<uuid>/page-NN.jpg). Cap the descent so a symlink loop or an
// unexpectedly deep tree can't stall ingest.
const TOOL_RESULT_MAX_DEPTH = 3;

const TOOL_RESULT_MIME: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.csv': 'text/csv',
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

function toolResultMime(relPath: string): string {
  return TOOL_RESULT_MIME[path.extname(relPath).toLowerCase()] ?? 'application/octet-stream';
}

/** Relative paths of every file under a spill dir, descending into subdirs. */
function walkToolResultFiles(root: string, prefix = '', depth = 0): string[] {
  if (depth >= TOOL_RESULT_MAX_DEPTH) return [];
  let entries: import('fs').Dirent[];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const found: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      found.push(...walkToolResultFiles(path.join(root, entry.name), rel, depth + 1));
    } else if (entry.isFile()) {
      found.push(rel);
    }
  }
  return found;
}

/**
 * Copy a session's tool-results/ spill files into our content-addressed blob
 * store before Claude Code's cleanupPeriodDays sweep deletes them.
 *
 * Claude Code writes large tool outputs to
 * projects/<project>/<session>/tool-results/<tool_use_id>.txt and leaves only
 * that path in the transcript. We archive the transcript but not the payload,
 * so once the sweep runs (30 days by default) the message survives pointing at
 * a file that no longer exists.
 *
 * Write-once files, so idempotency is a (session, tool_use_id, size) check
 * rather than a byte offset — that keeps repeat passes off the hashing path.
 */
export async function archiveToolResultsForSession(
  db: ReturnType<typeof getDb>,
  projectDirName: string,
  meta: { sessionId: string },
  result: { filesScanned: number },
): Promise<void> {
  const dir = claudePaths.toolResultsDir(projectDirName, meta.sessionId);
  const files = walkToolResultFiles(dir);
  if (files.length === 0) return;

  const attachmentsDir = path.join(UNFIREHOSE_DIR, 'attachments');
  const existing = db.prepare(
    'SELECT size_bytes, mime_type FROM tool_results WHERE session_uuid = ? AND rel_path = ?'
  );
  const insert = db.prepare(
    `INSERT INTO tool_results
       (session_uuid, tool_use_id, rel_path, mime_type, size_bytes, hash, source_path)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_uuid, rel_path) DO UPDATE SET
       tool_use_id = excluded.tool_use_id,
       mime_type = excluded.mime_type,
       size_bytes = excluded.size_bytes,
       hash = excluded.hash,
       archived_at = datetime('now')`
  );

  let madeDir = false;

  for (const relPath of files) {
    const srcPath = path.join(dir, relPath);
    const st = await stat(srcPath).catch(() => null);
    if (!st || !st.isFile()) continue;

    const mimeType = toolResultMime(relPath);

    // Size alone would leave the migration's placeholder mime in place forever,
    // so a stale mime also counts as work to redo.
    const prior = existing.get(meta.sessionId, relPath) as
      { size_bytes: number; mime_type: string } | undefined;
    if (prior && prior.size_bytes === st.size && prior.mime_type === mimeType) continue;

    if (st.size > TOOL_RESULT_MAX_BYTES) continue;

    const buffer = await readFile(srcPath).catch(() => null);
    if (!buffer) continue;

    // First segment names the originating tool call; a nested spill keeps the
    // directory name (pdf-<uuid>) so every page resolves back to one call.
    const [head] = relPath.split(path.sep);
    const toolUseId = head.replace(/\.[^.]+$/, '');

    const hash = createHash('sha256').update(buffer).digest('hex');
    const destPath = path.join(attachmentsDir, hash);

    if (!existsSync(destPath)) {
      if (!madeDir) {
        await mkdir(attachmentsDir, { recursive: true });
        madeDir = true;
      }
      await writeFile(destPath, buffer);
    }

    insert.run(meta.sessionId, toolUseId, relPath, mimeType, st.size, hash, srcPath);
    result.filesScanned++;
  }
}
