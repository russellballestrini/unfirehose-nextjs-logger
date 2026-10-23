// Every harness that writes JSONL under a directory: native unfirehose/1.0
// harness discovery and the one reader they (and Fetch) share.
// Extracted from ingest.ts; ingest.ts re-exports the public symbols.
import { readdir, open } from 'fs/promises';
import { createReadStream, readdirSync, statSync } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import { homedir } from 'os';
import type { getDb } from './schema';
import { decodeProjectName, resolveProjectPath } from '../claude-paths';
import { recordHarnessRefusal } from './refusals';
import { SessionChainTracker } from './provenance-ingest';
import { sanitizePII } from '../pii';
import { generateSessionName } from '../session-name';
import { jsonlListing, knownOffset, statSyncSafe, stmt } from './ingest-cache';
import { getOrCreateProject } from './ingest-projects';
import {
  extractProvidenceFromSession,
  getOrCreateSession,
  insertContentBlocks,
  insertMessage,
  updateUsageMinutes,
} from './ingest-rows';
import { extractTodosFromEntry } from './ingest-todos';
import { NOT_NATIVE_DIRS } from '../harness-registry';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface IngestResult {
  projectsAdded: number;
  sessionsAdded: number;
  messagesAdded: number;
  blocksAdded: number;
  filesScanned: number;
  alertsTriggered: number;
  providenceAdded: number;
}

// ── Native harness auto-discovery ────────────────────────────────────────────
// Any directory matching ~/.{name}/unfirehose/ is treated as a native harness
// that writes unfirehose/1.0 JSONL to {root}/{project-slug}/{session-uuid}.jsonl.
// No registration needed — just create the directory and start writing.
// Excluded: .unfirehose (our own data dir), .claude/.fetch/.uncloseai (custom adapters).
export interface NativeHarness {
  name: string;
  root: string;
}

// Ours, or harnesses with their own reader: one list, in the registry.
const EXCLUDED_HARNESS_DIRS = NOT_NATIVE_DIRS;

function discoverNativeHarnesses(): NativeHarness[] {
  const home = homedir();
  const harnesses: NativeHarness[] = [];

  try {
    const entries = readdirSync(home);
    for (const entry of entries) {
      // Only dot-directories
      if (!entry.startsWith('.')) continue;
      const name = entry.slice(1); // strip leading dot
      if (!name || EXCLUDED_HARNESS_DIRS.has(name)) continue;

      const ufDir = path.join(home, entry, 'unfirehose');
      try {
        const s = statSync(ufDir);
        if (s.isDirectory()) {
          harnesses.push({ name, root: ufDir });
        }
      } catch {
        // no unfirehose subdir — skip
      }
    }
  } catch {
    // can't read homedir — shouldn't happen
  }

  return harnesses;
}

// Exported so the watcher can discover directories to watch
export let nativeHarnesses = discoverNativeHarnesses();

// Re-discover before each ingest cycle (picks up newly created harness dirs)
export function refreshNativeHarnesses() {
  nativeHarnesses = discoverNativeHarnesses();
}

/**
 * Generic ingestion for any harness that writes unfirehose/1.0 JSONL.
 * Directory structure: {root}/{project-slug}/{session-uuid}.jsonl
 */
/**
 * One reader for every harness that writes JSONL under a directory.
 *
 * Fetch and the native harnesses had a reader each, and they were the
 * same two hundred lines twice: walk the project directories, resume each
 * file from its stored byte offset, insert messages, extract todos,
 * update usage minutes. Only two things genuinely differed — where the
 * directories are, and what format the lines are in — so those are what
 * a source names. Everything else was duplication waiting to drift, and
 * had already started to: only one of the two closed a session on a
 * session_end record.
 */
export interface JsonlSource {
  /** Harness name, which prefixes every project this source creates. */
  name: string;
  root: string;
  projectDir(slug: string): string;
  /**
   * One line, as a message we can insert — or null for a line that is
   * not a message at all. unfirehose/1.0 says so with a type; Claude
   * Code format has to be translated.
   */
  toMessage(entry: any): any | null;
}

// Native session headers carry the authoritative cwd. Reading one bounded
// header avoids exponential dash-split probing for long or deleted paths.
export async function nativeSessionCwd(file: string): Promise<string | null> {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    if (end < 0) return null;
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, -1)) {
      try {
        const header = JSON.parse(line);
        if (typeof header.cwd === 'string' && path.isAbsolute(header.cwd)) return header.cwd;
      } catch { /* incomplete or non-record line */ }
    }
    return null;
  } catch { return null; }
  finally { await handle.close(); }
}

/** True when the file's last byte is `\n` — i.e. its final line is complete. */
export async function lastByteIsNewline(file: string, size: number): Promise<boolean> {
  if (size <= 0) return true;
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return true;
  try {
    const one = Buffer.alloc(1);
    const { bytesRead } = await handle.read(one, 0, 1, size - 1);
    return bytesRead === 1 && one[0] === 10;
  } catch { return true; }
  finally { await handle.close(); }
}

/**
 * One harness root → every project dir → every session file, resumed
 * from each file's byte offset. Exported for the ingest tests, which
 * point it at a temp root; production reaches it through `ingestAll`.
 */
export async function ingestJsonlSource(
  db: ReturnType<typeof getDb>,
  harness: JsonlSource,
  only?: ReadonlySet<string>,
): Promise<Omit<IngestResult, 'alertsTriggered'>> {
  const result = {
    projectsAdded: 0,
    sessionsAdded: 0,
    messagesAdded: 0,
    blocksAdded: 0,
    filesScanned: 0,
    providenceAdded: 0,
  };

  if (!harness.root) return result;

  const projectDirs = await readdir(harness.root).catch(() => []);
  if (projectDirs.length === 0) return result;

  for (const slug of projectDirs) {
    const projDir = harness.projectDir(slug);
    if (only && !only.has(projDir)) continue;
    const dirStat = statSyncSafe(projDir);
    if (!dirStat?.isDirectory()) continue;

    const projectName = `${harness.name}:${slug}`;
    const displayName = `[${harness.name}] ${decodeProjectName(slug)}`;

    const files = jsonlListing(projDir, dirStat.mtimeMs);
    if (files.length === 0) continue;

    // resolveProjectPath falls back to a filesystem DFS that probes every way
    // the encoded name could split into directories. Running it per project
    // per cycle did not scale: ~6,400 uncloseai project dirs turned one pass
    // into minutes, so the single-flight guard kept skipping the next cycle
    // and native-harness ingest effectively stopped — measured 2026-08-25,
    // uncloseai ran 80 minutes behind while Claude Code stayed current, and a
    // brand new project (~/git/contra, 9 sessions) never landed at all.
    //
    // A project we already know needs no probing. The DFS stays as the last
    // resort for a project we have never seen.
    // Files first, project second. A project whose journals hold no new
    // bytes needs nothing from the database — not its row, not its git
    // identity, not a session count — and on a quiet pass that is every
    // project: ~24k of them, three queries each, 4 s of the pass measured
    // 2026-09-17. Stat the files, and only a project with something to
    // ingest goes any further.
    const pending: Array<{ sessionUuid: string; filePath: string; size: number; offset: number | undefined }> = [];
    for (const file of files) {
      const sessionUuid = file.replace('.jsonl', '');
      const filePath = path.join(harness.root, slug, `${sessionUuid}.jsonl`);
      const fstat = statSyncSafe(filePath);
      if (!fstat) continue;
      const offset = knownOffset(db, filePath);
      if (fstat.size <= (offset ?? 0)) continue;
      pending.push({ sessionUuid, filePath, size: fstat.size, offset });
    }
    if (pending.length === 0) continue;

    const knownProj = stmt(db, 'SELECT COALESCE(path, last_cwd_seen) AS p FROM projects WHERE name = ?')
      .get(projectName) as { p: string | null } | undefined;
    const slugCwd = knownProj?.p
      ?? await nativeSessionCwd(path.join(projDir, files[0]))
      ?? (await resolveProjectPath(slug).catch(() => null));
    const projectId = getOrCreateProject(db, projectName, displayName, slugCwd ?? undefined);

    const hadSessions = stmt(db, 'SELECT 1 AS x FROM sessions WHERE project_id = ? LIMIT 1').get(projectId);
    if (!hadSessions) result.projectsAdded++;

    for (const { sessionUuid, filePath, size, offset } of pending) {
      const fstat = { size };
      const startByte = offset ?? 0;

      result.filesScanned++;

      const sessionId = getOrCreateSession(db, sessionUuid, projectId, {
        cliVersion: harness.name,
        harness: harness.name,
      });

      if (offset === undefined) result.sessionsAdded++;

      // A writer can be mid-line when we read: the file's last byte is
      // then not a newline and readline still hands us the partial
      // tail. It is neither a message nor a chain break — it is not
      // written yet — so it is held back and the offset stops BEFORE
      // it, to be read whole next pass. Until 2026-09-15 the offset
      // jumped to the file size and the rest of that line arrived
      // next pass as an unparseable fragment: one lost message per race.
      const endsWithNewline = await lastByteIsNewline(filePath, fstat.size);
      let partialTail = '';

      // Chain verification rides the same read (docs: LANE-PROVENANCE
      // in uncloseai-cli; packages/schema/docs/sessions.md § Chain).
      const chain = new SessionChainTracker(db, sessionUuid, { reset: startByte === 0, filePath });

      const stream = createReadStream(filePath, {
        start: startByte,
        encoding: 'utf-8',
      });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      const batchInsert = db.transaction((lines: string[]) => {
        for (const line of lines) {
          if (!line.trim()) continue;
          const rowHash = chain.feed(line);
          try {
            const entry = JSON.parse(line);

            // Native unfirehose/1.0 session header (line 1 of every
            // file). Carries firstPrompt / gitBranch / sidechain that
            // the session row needs but didn't have at creation time
            // (we only had the UUID + harness from the filename).
            // Backfill via UPDATE; session_uuid is the key.
            if (entry.type === 'session') {
              const updates: string[] = [];
              const params: (string | number)[] = [];
              if (typeof entry.firstPrompt === 'string' && entry.firstPrompt) {
                const sanitized = sanitizePII(entry.firstPrompt).sanitized;
                updates.push('first_prompt = ?');
                params.push(sanitized);
                // Also refresh display_name now that we have a prompt.
                updates.push('display_name = ?');
                params.push(generateSessionName(sanitized, sessionUuid));
              }
              if (typeof entry.gitBranch === 'string' && entry.gitBranch) {
                updates.push('git_branch = ?');
                params.push(entry.gitBranch);
              }
              if (typeof entry.sidechain === 'boolean') {
                updates.push('is_sidechain = ?');
                params.push(entry.sidechain ? 1 : 0);
              }
              if (typeof entry.createdAt === 'string' && entry.createdAt) {
                updates.push('created_at = ?');
                params.push(entry.createdAt);
              }
              if (updates.length > 0) {
                params.push(sessionUuid);
                db.prepare(
                  `UPDATE sessions SET ${updates.join(', ')} WHERE session_uuid = ?`
                ).run(...params);
              }
              continue;
            }

            // unfirehose/1.0 throttle record — a provider refused a call.
            // Its own type because a throttled call produces no message, so
            // there is nothing to hang it off. Recorded directly rather than
            // waiting for the text scanner: this one already names the
            // upstream, which is the thing the scanner can never recover from
            // an error string. See packages/schema/docs/throttling.md.
            if (entry.type === 'throttle') {
              const sessRow = db.prepare(
                'SELECT id FROM sessions WHERE session_uuid = ?'
              ).get(sessionUuid) as { id: number } | undefined;
              recordHarnessRefusal(db, {
                sessionId: sessRow?.id ?? null,
                timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
                kind: typeof entry.kind === 'string' ? entry.kind : 'rate_limit',
                provider: typeof entry.harness === 'string' ? entry.harness : harness.name,
                upstream: typeof entry.upstream === 'string' ? entry.upstream : null,
                operation: typeof entry.operation === 'string' ? entry.operation : null,
                model: typeof entry.model === 'string' ? entry.model : null,
                httpStatus: typeof entry.httpStatus === 'number' ? entry.httpStatus : null,
                retryAfterSeconds: typeof entry.retryAfterSeconds === 'number' ? entry.retryAfterSeconds : null,
                detail: typeof entry.message === 'string' ? entry.message : null,
              });
              continue;
            }

            // unfirehose/1.0 entries are already messages; Claude Code
            // format has to be translated first, and a line that is
            // neither is not ours to insert.
            const message = harness.toMessage(entry);
            if (!message) continue;

            // session_end system message — terminal signal that the
            // harness emitted to mark the session closed. Run BEFORE
            // the dedupe-skip (insertMessage returning null on
            // re-ingest of the same row) so the status flip is
            // idempotent across re-ingests AND survives the case
            // where the session_end message is a duplicate. Sticky:
            // don't reopen on a later message — the WHERE guards
            // against status downgrades.
            if (
              message.role === 'system' &&
              message.subtype === 'session_end'
            ) {
              const closedAt =
                (typeof message.timestamp === 'string' && message.timestamp) ||
                new Date().toISOString();
              db.prepare(
                `UPDATE sessions
                   SET status = 'closed',
                       closed_at = ?
                 WHERE session_uuid = ?
                   AND (status IS NULL OR status != 'closed')`
              ).run(closedAt, sessionUuid);
            }

            const messageId = insertMessage(db, sessionId, message);
            if (messageId === null) continue;

            result.messagesAdded++;
            if (rowHash) db.prepare('UPDATE messages SET row_hash = ? WHERE id = ?').run(rowHash, messageId);

            if (Array.isArray(message.content)) {
              result.blocksAdded += insertContentBlocks(db, messageId, message.content);
            }

            extractTodosFromEntry(db, projectId, sessionId, entry, sessionUuid);

            const usage = message.usage;
            if (usage && message.timestamp) {
              updateUsageMinutes(db, projectId, message.timestamp, {
                inputTokens: usage.inputTokens ?? 0,
                outputTokens: usage.outputTokens ?? 0,
                cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
                cacheCreationTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
              });
            }
          } catch {
            // skip malformed lines
          }
        }
      });

      const batch: string[] = [];
      let batchBytes = 0;
      let held: string | null = null;      // the most recent line, not yet committed to a batch
      for await (const line of rl) {
        if (held !== null) {
          batch.push(held);
          batchBytes += Buffer.byteLength(held);
        }
        held = line;
        // Tool results can be megabytes each. A row-count-only batch can
        // pin gigabytes in one transaction and stall live ingestion on I/O.
        if (batch.length >= 500 || batchBytes >= 2 * 1024 * 1024) {
          batchInsert(batch.splice(0));
          batchBytes = 0;
        }
      }
      if (held !== null) {
        if (endsWithNewline) batch.push(held);
        else partialTail = held;
      }
      if (batch.length > 0) {
        batchInsert(batch);
      }
      db.transaction(() => chain.flush())();

      db.prepare(
        `INSERT INTO ingest_offsets (file_path, byte_offset, last_ingested)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(file_path) DO UPDATE SET
           byte_offset = excluded.byte_offset,
           last_ingested = excluded.last_ingested`
      ).run(filePath, fstat.size - Buffer.byteLength(partialTail));

      db.prepare(
        'UPDATE sessions SET updated_at = ? WHERE session_uuid = ?'
      ).run(new Date().toISOString(), sessionUuid);

      // Extract Q&A providence records from this session
      result.providenceAdded += extractProvidenceFromSession(db, sessionId, decodeProjectName(slug), harness.name);
    }
  }

  return result;
}
