import { readdir } from 'fs/promises';
import { createReadStream, readFileSync, readdirSync } from 'fs';
import { createInterface } from 'readline';
import { execFile } from 'child_process';
import path from 'path';
import { homedir } from 'os';
import { getDb } from './schema';
import { claudePaths, decodeProjectName } from '../claude-paths';
// uncloseai: auto-discovered via ~/.uncloseai/unfirehose/ (native unfirehose/1.0)
import { fetchPaths } from '../fetch-paths';
// agnt-paths no longer needed — auto-discovered via ~/.agnt/unfirehose/
import { normalizeClaudeCodeEntry } from '../claude-code-adapter';
import { SessionChainTracker, auditAnchors, auditLanes, backfillWitness } from './provenance-ingest';
import { watchRewrites } from './rewrite-watch';
import { resolveSessionFile } from '../session-paths';
export { recordHarnessRefusal } from './refusals';
export type { HarnessRefusal } from './refusals';
import { generateSessionName } from '../session-name';
import { uuidv7 } from '../uuidv7';
import type { SessionsIndex } from '../types';
import { TOOL_CALL_SQL } from '../block-types';

// ingest.ts is the public entry point (`@unturf/unfirehose/db/ingest`): the
// pass itself lives here, and everything else it was once a single file of
// is re-exported from the module it moved to.
import { fleetHarnesses, knownOffset, setOffsetsSnapshot, snapshotOffsets, statSyncSafe, stmt } from './ingest-cache';
import { autoMergeIdenticalProjects, clearGitIdentityCache, getOrCreateProject } from './ingest-projects';
import {
  extractProvidenceFromSession,
  getOrCreateSession,
  insertContentBlocks,
  insertMessage,
  updateUsageMinutes,
} from './ingest-rows';
import { extractTodosFromEntry } from './ingest-todos';
import { archiveToolResultsForSession, ingestSubagentsForSession } from './ingest-claude-code';
import {
  ingestJsonlSource,
  lastByteIsNewline,
  nativeHarnesses,
  nativeSessionCwd,
  refreshNativeHarnesses,
} from './ingest-harness';
import type { IngestResult } from './ingest-harness';
import { checkThresholds } from './ingest-alerts';
import { getSetting, setSetting } from './ingest-settings';

export { gitConfigPath, readGitRemotes, mergeProjects, autoMergeIdenticalProjects } from './ingest-projects';
export { archiveToolResultsForSession } from './ingest-claude-code';
export { ingestJsonlSource, nativeHarnesses } from './ingest-harness';
export type { IngestResult, NativeHarness } from './ingest-harness';
export {
  getRecentAlerts,
  getAlertsCount,
  getUnacknowledgedAlerts,
  acknowledgeAllAlerts,
  clearAlerts,
  acknowledgeAlert,
  getAlertThresholds,
  updateAlertThreshold,
  acknowledgeAlertsForThreshold,
  calibrateAlertThresholds,
  getAlertDailyCounts,
  getAlertById,
  applyPlanThresholds,
} from './ingest-alerts';
export type { ThresholdCalibration, AlertDailyCount } from './ingest-alerts';
export {
  windowStart,
  getUsageTimeline,
  getUsageByProject,
  getDbStats,
  getProjectActivity,
  getProjectModelActivity,
  getProjectRecentPrompts,
  getProjectModelUsageInWindow,
  getUsageByProjectInWindow,
  getModelBreakdownInWindow,
  getActiveSessionsInWindow,
  getThinkingBlocksInWindow,
  getTimelineInWindow,
  getUserPromptsInWindow,
} from './ingest-queries';
export { getSetting, setSetting, getAllSettings, deleteSetting } from './ingest-settings';
export { createPost, getPosts, getPost, deletePost } from './ingest-posts';
export type { PostRow } from './ingest-posts';

const CANONICAL_ROOT = path.join(homedir(), '.unfirehose', 'canonical');

// Poison pill: when an agent emits UNEOF, the orchestrator culls its deployment
export const AGENT_FINISHED_TOKEN = 'UNEOF';

function tmuxSendKeys(target: string, keys: string): void {
  execFile('tmux', ['send-keys', '-t', target, keys, 'Enter'], { timeout: 3000 }, () => {});
}

function tmuxKillWindow(target: string): void {
  // Delay kill to let /exit propagate, then kill the tmux window/session
  setTimeout(() => {
    execFile('tmux', ['kill-window', '-t', target], { timeout: 3000 }, () => {});
  }, 5000);
}

/**
 * Cull deployments for projects where UNEOF was detected during ingestion.
 * Sends /exit to each deployment's tmux window, then kills it.
 */
function cullUneofDeployments(db: ReturnType<typeof getDb>, projectIds: Set<number>) {
  const deployments = db.prepare(`
    SELECT id, tmux_session, tmux_window, project_id
    FROM agent_deployments
    WHERE status = 'running' AND project_id IN (${[...projectIds].map(() => '?').join(',')})
  `).all(...projectIds) as any[];

  for (const d of deployments) {
    const target = d.tmux_window ? `${d.tmux_session}:${d.tmux_window}` : d.tmux_session;
    console.log(`[uneof] Culling deployment ${d.id} — sending /exit to ${target}`);
    tmuxSendKeys(target, '/exit');
    tmuxKillWindow(target);
    db.prepare(
      "UPDATE agent_deployments SET status = 'completed', stopped_at = datetime('now') WHERE id = ?"
    ).run(d.id);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Settings key holding the ISO time ingestion last completed. */
export const INGEST_HEARTBEAT_KEY = 'last_ingest_at';

/**
 * How long ago ingestion last finished, in minutes, or null if it never has.
 *
 * Null and zero are different answers: a fresh install has never ingested,
 * which is not the same as one whose worker died an hour ago.
 */
export function ingestLagMinutes(): number | null {
  const raw = getSetting(INGEST_HEARTBEAT_KEY);
  if (!raw) return null;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.round((Date.now() - at) / 60_000));
}

/**
 * Options for a pass. `dirs` names project directories (absolute paths, as
 * claudePaths.projectDir / harness.projectDir spell them) and makes the
 * pass targeted: only those directories are read, and the housekeeping a
 * full pass carries — the offsets snapshot, native-harness rediscovery,
 * name and delegation backfills, auto-merge, the witness — is left to the
 * next full pass. The file watcher runs these; it knows which directory
 * changed, and a full pass costs a stat of every journal on the box (~47k,
 * ~4 s measured 2026-09-17) after every two-second lull in a busy session.
 */
export interface IngestOptions {
  dirs?: ReadonlySet<string>;
  /** Force the whole-database housekeeping on or off; default: housekeepingDue. */
  housekeeping?: boolean;
}

// The tail of a full pass is housekeeping over the whole database: name
// and timestamp backfills, delegation linking, auto-merge, the witness
// audit. On a quiet box every query of it finds nothing, and it ran every
// minute — ~0.5 s a pass measured 2026-09-17, a third of a pass that had
// nothing to ingest. It now runs when a pass brought something in, and
// otherwise this often, so a rewrite or a rename is still noticed within
// minutes of an idle hour.
const HOUSEKEEPING_INTERVAL_MS = 10 * 60_000;
let _lastHousekeepingAt = 0;
let _ingestActivityAt = 0;

/** When a pass last read a journal with new bytes. The worker paces its full passes by it. */
export function ingestActivityAt(): number { return _ingestActivityAt; }

export function housekeepingDue(
  result: Pick<IngestResult, 'projectsAdded' | 'sessionsAdded' | 'messagesAdded' | 'filesScanned'>,
  now: number = Date.now(),
  lastAt: number = _lastHousekeepingAt,
): boolean {
  return result.filesScanned > 0 || result.projectsAdded > 0 || result.sessionsAdded > 0 || result.messagesAdded > 0
    || now - lastAt >= HOUSEKEEPING_INTERVAL_MS;
}

export async function ingestAll(opts: IngestOptions = {}): Promise<IngestResult> {
  // One offsets snapshot per pass — see knownOffset. A targeted pass reads
  // a handful of offsets; the snapshot is 80k rows and costs more than it saves.
  setOffsetsSnapshot(opts.dirs ? null : snapshotOffsets(getDb()));
  try {
    return await ingestAllPass(opts);
  } finally {
    setOffsetsSnapshot(null);
  }
}

async function ingestAllPass(opts: IngestOptions = {}): Promise<IngestResult> {
  const only = opts.dirs;
  if (!only) {
    // Re-discover native harness directories (picks up newly created ones)
    refreshNativeHarnesses();

    // Drop git identities past the TTL — repos move, remotes change, paths come and go.
    clearGitIdentityCache();
  }

  const db = getDb();
  const result: IngestResult = {
    projectsAdded: 0,
    sessionsAdded: 0,
    messagesAdded: 0,
    blocksAdded: 0,
    filesScanned: 0,
    alertsTriggered: 0,
    providenceAdded: 0,
  };

  // Track projects where UNEOF was detected — cull after ingestion completes
  const uneofProjects = new Set<number>();

  const enabled = process.env.UNFIREHOSE_HARNESSES?.split(',').map(value => value.trim());
  const projectDirs = !enabled || enabled.includes('claude-code')
    ? await readdir(claudePaths.projects).catch(() => []) : [];

  for (const dir of projectDirs) {
    const projDir = claudePaths.projectDir(dir);
    if (only && !only.has(projDir)) continue;
    const dirStat = statSyncSafe(projDir);
    if (!dirStat?.isDirectory()) continue;

    let projectPath = '';
    let sessionMeta: Array<{
      sessionId: string;
      firstPrompt?: string;
      gitBranch?: string;
      createdAt?: string;
      isSidechain?: boolean;
    }> = [];

    // Read sessions index if available
    try {
      const indexRaw = readFileSync(claudePaths.sessionsIndex(dir), 'utf-8');
      const index: SessionsIndex = JSON.parse(indexRaw);
      projectPath = index.originalPath ?? '';
      sessionMeta = index.entries.map((e) => ({
        sessionId: e.sessionId,
        firstPrompt: e.firstPrompt,
        gitBranch: e.gitBranch,
        createdAt: e.created,
        isSidechain: e.isSidechain,
      }));
    } catch {
      // No index — will scan below
    }

    // Also scan for JSONL files not in the sessions index
    try {
      const indexedIds = new Set(sessionMeta.map((m) => m.sessionId));
      const files = readdirSync(projDir);
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const sid = f.replace('.jsonl', '');
        if (!indexedIds.has(sid)) {
          sessionMeta.push({ sessionId: sid });
        }
      }
    } catch {
      if (sessionMeta.length === 0) continue;
    }

    if (sessionMeta.length === 0) continue;

    // Indexless Claude logs also carry cwd after their initial lifecycle events.
    // Prefer recorded metadata; unknown paths stay unknown rather than invoking
    // exponential dash-split filesystem guessing.
    if (!projectPath) {
      projectPath = await nativeSessionCwd(claudePaths.sessionFile(dir, sessionMeta[0].sessionId)) ?? '';
    }

    const projectId = getOrCreateProject(
      db,
      dir,
      decodeProjectName(dir),
      projectPath || undefined
    );

    // Check if project was new
    const hadSessions = stmt(db, 'SELECT 1 AS x FROM sessions WHERE project_id = ? LIMIT 1').get(projectId);
    if (!hadSessions && sessionMeta.length > 0) result.projectsAdded++;

    for (const meta of sessionMeta) {
      const filePath = claudePaths.sessionFile(dir, meta.sessionId);
      const fstat = statSyncSafe(filePath);
      if (!fstat) continue;

      // Check ingestion offset
      const offset = knownOffset(db, filePath);
      const startByte = offset ?? 0;

      const parentHasNewBytes = fstat.size > startByte;

      // Always probe the subagents/ dir even if the parent file has no new
      // bytes — Claude Code can keep spawning subagents after the parent's
      // last user turn, and we still need to backfill the historical fleet.
      if (!parentHasNewBytes) {
        await ingestSubagentsForSession(db, dir, meta, projectId, result);
        await archiveToolResultsForSession(db, dir, meta, result);
        continue;
      }

      result.filesScanned++;

      const sessionId = getOrCreateSession(db, meta.sessionId, projectId, {
        gitBranch: meta.gitBranch,
        firstPrompt: meta.firstPrompt,
        createdAt: meta.createdAt,
        isSidechain: meta.isSidechain,
        harness: 'claude-code',
      });

      if (offset === undefined) result.sessionsAdded++;

      // A Claude Code transcript is not chained (its writer is not ours),
      // but the witness records every line it reads all the same, so an
      // edit after ingest is caught (see provenance-ingest.ts). A partial
      // last line — the writer mid-flush — is held back and the offset
      // stops before it, the same rule the native loop follows.
      const ccEndsWithNewline = await lastByteIsNewline(filePath, fstat.size);
      let ccPartialTail = '';
      const chain = new SessionChainTracker(db, meta.sessionId, { reset: startByte === 0, filePath });

      // Stream new lines from the file
      const stream = createReadStream(filePath, {
        start: startByte,
        encoding: 'utf-8',
      });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      // Track delegation info discovered during ingestion
      let detectedDelegatedFrom: string | null = null;
      let detectedUneof = false;

      // Batch insert in a transaction for speed
      const batchInsert = db.transaction(
        (lines: string[]) => {
          for (const line of lines) {
            if (!line.trim()) continue;
            chain.feed(line);
            try {
              const entry = JSON.parse(line);

              // Detect delegation: check for UNFIREHOSE_PARENT_SESSION in env or explicit field
              if (!detectedDelegatedFrom) {
                if (entry.delegatedFrom) {
                  detectedDelegatedFrom = entry.delegatedFrom;
                } else if (entry.type === 'user' && entry.message?.content) {
                  // Check if system prompt or first message references parent session
                  const textContent = Array.isArray(entry.message.content)
                    ? entry.message.content.map((b: any) => b.text ?? '').join(' ')
                    : String(entry.message.content);
                  const parentMatch = textContent.match(/UNFIREHOSE_PARENT_SESSION[=: ]+([a-f0-9-]{36})/i);
                  if (parentMatch) {
                    detectedDelegatedFrom = parentMatch[1];
                  }
                }
              }

              // Detect UNEOF poison pill in assistant output
              if (!detectedUneof && entry.type === 'assistant' && entry.message?.content) {
                const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
                for (const b of blocks) {
                  if (b.type === 'text' && typeof b.text === 'string' && b.text.includes(AGENT_FINISHED_TOKEN)) {
                    detectedUneof = true;
                    break;
                  }
                }
              }

              // Transform Claude Code native → unfirehose/1.0
              const normalized = normalizeClaudeCodeEntry(entry);
              if (!normalized) continue;

              normalized.provider ??= 'anthropic';
              const messageId = insertMessage(db, sessionId, normalized);
              if (messageId === null) continue; // skipped (duplicate or non-message type)

              result.messagesAdded++;

              // Insert content blocks (already in unfirehose/1.0 format from normalizer)
              if (Array.isArray(normalized.content)) {
                result.blocksAdded += insertContentBlocks(db, messageId, normalized.content);
              }

              // Update usage minutes for assistant messages with token data
              // Skip usage rollups for delegated sessions (parent already counted)
              const usage = normalized.usage;
              if (usage && normalized.timestamp && !detectedDelegatedFrom) {
                updateUsageMinutes(db, projectId, normalized.timestamp, {
                  inputTokens: usage.inputTokens ?? 0,
                  outputTokens: usage.outputTokens ?? 0,
                  cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
                  cacheCreationTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
                });
              }

              // Extract todos from this entry (pass original for tool_use detection)
              extractTodosFromEntry(db, projectId, sessionId, entry, meta.sessionId);
            } catch {
              // skip malformed lines
            }
          }
        }
      );

      const batch: string[] = [];
      let batchBytes = 0;
      let held: string | null = null;
      for await (const line of rl) {
        if (held !== null) {
          batch.push(held);
          batchBytes += Buffer.byteLength(held);
        }
        held = line;
        if (batch.length >= 500 || batchBytes >= 2 * 1024 * 1024) {
          batchInsert(batch.splice(0));
          batchBytes = 0;
        }
      }
      if (held !== null) {
        if (ccEndsWithNewline) batch.push(held);
        else ccPartialTail = held;
      }
      if (batch.length > 0) {
        batchInsert(batch);
      }
      db.transaction(() => chain.flush())();

      // Link delegation if detected during ingestion
      if (detectedDelegatedFrom) {
        db.prepare(
          'UPDATE sessions SET delegated_from = ?, is_sidechain = 1 WHERE session_uuid = ? AND delegated_from IS NULL'
        ).run(detectedDelegatedFrom, meta.sessionId);
      }

      // UNEOF: agent signalled completion — queue cull for this project
      if (detectedUneof) {
        uneofProjects.add(projectId);
      }

      // Update ingestion offset — to the end of the last complete line.
      db.prepare(
        `INSERT INTO ingest_offsets (file_path, byte_offset, last_ingested)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(file_path) DO UPDATE SET
           byte_offset = excluded.byte_offset,
           last_ingested = excluded.last_ingested`
      ).run(filePath, fstat.size - Buffer.byteLength(ccPartialTail));

      // Update session modified timestamp
      db.prepare(
        'UPDATE sessions SET updated_at = ? WHERE session_uuid = ?'
      ).run(new Date().toISOString(), meta.sessionId);

      // Extract Q&A providence records from this session
      result.providenceAdded += extractProvidenceFromSession(db, sessionId, projectPath || decodeProjectName(dir), 'claude-code');

      // Subagent JSONLs live in <dir>/<sessionId>/subagents/agent-*.jsonl.
      await ingestSubagentsForSession(db, dir, meta, projectId, result);

      // Spilled tool outputs live in <dir>/<sessionId>/tool-results/ and age
      // out on the same sweep as the transcript — copy them while they exist.
      await archiveToolResultsForSession(db, dir, meta, result);
    }
  }

  // uncloseai: handled by native harness auto-discovery

  // Ingest Fetch sessions (if FETCH_JSONL_DIR is configured)
  if (fetchPaths.root && (!enabled || enabled.includes('fetch'))) {
    const fetchResult = await ingestJsonlSource(db, {
      name: 'fetch',
      root: fetchPaths.root,
      projectDir: (slug) => fetchPaths.projectDir(slug),
      // Fetch writes Claude Code's format, not ours.
      toMessage: (entry) => normalizeClaudeCodeEntry(entry),
    }, only);
    result.projectsAdded += fetchResult.projectsAdded;
    result.sessionsAdded += fetchResult.sessionsAdded;
    result.messagesAdded += fetchResult.messagesAdded;
    result.blocksAdded += fetchResult.blocksAdded;
    result.filesScanned += fetchResult.filesScanned;
    result.providenceAdded += fetchResult.providenceAdded;
  }

  // Ingest all native unfirehose/1.0 harnesses (agnt, orcestra, codex, etc.),
  // then the same harnesses under every fleet worker's private HOME
  // (fleet-roots.ts) — found each pass, never fs-watched.
  const fleet = (!enabled || enabled.includes('fleet')) ? fleetHarnesses() : [];
  for (const harness of [...nativeHarnesses, ...fleet]) {
    if (enabled && !enabled.includes(harness.name)) continue;
    const hResult = await ingestJsonlSource(db, {
      name: harness.name,
      root: harness.root,
      projectDir: (slug) => path.join(harness.root, slug),
      // unfirehose/1.0: a message says so.
      toMessage: (entry) => (entry.type === 'message' ? entry : null),
    }, only);
    result.projectsAdded += hResult.projectsAdded;
    result.sessionsAdded += hResult.sessionsAdded;
    result.messagesAdded += hResult.messagesAdded;
    result.blocksAdded += hResult.blocksAdded;
    result.filesScanned += hResult.filesScanned;
    result.providenceAdded += hResult.providenceAdded;
  }

  // A targeted pass ends here: the rows it read are in, an alert that
  // crossed a threshold fires now, and the heartbeat says a read happened.
  // Everything below is a sweep over the whole database, and belongs to
  // the pass that also swept the whole filesystem.
  if (result.filesScanned > 0) _ingestActivityAt = Date.now();
  if (only) {
    result.alertsTriggered = checkThresholds(db);
    if (uneofProjects.size > 0) cullUneofDeployments(db, uneofProjects);
    setSetting(INGEST_HEARTBEAT_KEY, new Date().toISOString());
    return result;
  }

  const housekeeping = opts.housekeeping ?? housekeepingDue(result);
  if (housekeeping) {
    _lastHousekeepingAt = Date.now();
  }
  if (housekeeping) {
    // Backfill display_name for sessions without one OR with preamble names
    const needsName = db.prepare(
      `SELECT id, first_prompt, session_uuid FROM sessions
       WHERE display_name IS NULL
          OR display_name = '(blackops session)'
          OR display_name LIKE 'Agent Blackops%'
          OR display_name LIKE '[Request interrupted%'`
    ).all() as Array<{ id: number; first_prompt: string | null; session_uuid: string }>;
    if (needsName.length > 0) {
      const updateName = db.prepare('UPDATE sessions SET display_name = ? WHERE id = ?');
      // Try to find a real user prompt if first_prompt is a preamble
      const findRealPrompt = db.prepare(`
        SELECT cb.text_content FROM messages m
        JOIN content_blocks cb ON cb.message_id = m.id AND cb.block_type = 'text'
        WHERE m.session_id = ? AND m.type = 'user'
          AND cb.text_content NOT LIKE '%blackops%'
          AND cb.text_content NOT LIKE '%Request interrupted%'
          AND cb.text_content NOT LIKE '%shadow clone%'
          AND LENGTH(cb.text_content) > 15
        ORDER BY m.timestamp
        LIMIT 1
      `);
      const backfill = db.transaction(() => {
        for (const row of needsName) {
          let name = generateSessionName(row.first_prompt, row.session_uuid);
          // If name fell back to UUID, try finding a real prompt from content_blocks
          if (name === row.session_uuid.slice(0, 8)) {
            const real = findRealPrompt.get(row.id) as { text_content: string } | undefined;
            if (real?.text_content) {
              name = generateSessionName(real.text_content, row.session_uuid);
            }
          }
          updateName.run(name, row.id);
        }
      });
      backfill();
    }


    // Backfill UUIDv7 for existing todos that don't have one
    const nullUuids = db.prepare('SELECT id, created_at FROM todos WHERE uuid IS NULL').all() as Array<{ id: number; created_at: string }>;
    if (nullUuids.length > 0) {
      const updateUuid = db.prepare('UPDATE todos SET uuid = ? WHERE id = ?');
      const uuidBackfill = db.transaction(() => {
        for (const row of nullUuids) {
          const ts = row.created_at ? new Date(row.created_at).getTime() : Date.now();
          updateUuid.run(uuidv7(ts), row.id);
        }
      });
      uuidBackfill();
      console.log(`[backfill] Assigned UUIDv7 to ${nullUuids.length} todos`);
    }

    // Backfill last_message_at from actual message timestamps
    const nullLastMsg = db.prepare(`
      SELECT s.id FROM sessions s WHERE s.last_message_at IS NULL
      AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.timestamp IS NOT NULL)
    `).all() as Array<{ id: number }>;
    if (nullLastMsg.length > 0) {
      const updateLastMsg = db.prepare(`
        UPDATE sessions SET last_message_at = (
          SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = ?
        ) WHERE id = ?
      `);
      const backfillLastMsg = db.transaction(() => {
        for (const row of nullLastMsg) {
          updateLastMsg.run(row.id, row.id);
        }
      });
      backfillLastMsg();
      console.log(`[backfill] Set last_message_at for ${nullLastMsg.length} sessions`);
    }

    // Heuristic delegation detection: find sessions spawned by Agent tool calls
    // in other sessions (same project, child started within 30s of Agent tool_use)
    const unlinkedSessions = db.prepare(`
      SELECT s.id, s.session_uuid, s.project_id, s.created_at, s.first_prompt
      FROM sessions s
      WHERE s.delegated_from IS NULL
        AND s.harness = 'claude-code'
        AND s.created_at IS NOT NULL
    `).all() as Array<{ id: number; session_uuid: string; project_id: number; created_at: string; first_prompt: string | null }>;

    if (unlinkedSessions.length > 0) {
      const findParentAgent = db.prepare(`
        SELECT s.session_uuid
        FROM content_blocks cb
        JOIN messages m ON cb.message_id = m.id
        JOIN sessions s ON m.session_id = s.id
        WHERE cb.block_type ${TOOL_CALL_SQL}
          AND cb.tool_name = 'Agent'
          AND s.project_id = ?
          AND s.session_uuid != ?
          AND m.timestamp BETWEEN datetime(?, '-30 seconds') AND datetime(?, '+30 seconds')
        LIMIT 1
      `);

      const linkDelegation = db.transaction(() => {
        for (const sess of unlinkedSessions) {
          if (!sess.created_at) continue;
          const parent = findParentAgent.get(
            sess.project_id, sess.session_uuid, sess.created_at, sess.created_at
          ) as { session_uuid: string } | undefined;
          if (parent) {
            db.prepare(
              'UPDATE sessions SET delegated_from = ? WHERE id = ? AND delegated_from IS NULL'
            ).run(parent.session_uuid, sess.id);
          }
        }
      });
      linkDelegation();
    }

    // Backfill harness for sessions without one
    db.prepare(`
      UPDATE sessions SET harness = 'claude-code'
      WHERE harness IS NULL
        AND session_uuid IN (SELECT REPLACE(file_path, '.jsonl', '') FROM ingest_offsets WHERE file_path LIKE '%/.claude/projects/%')
    `).run();

  }

  // Check alert thresholds
  result.alertsTriggered = checkThresholds(db);

  // Fire UNEOF cull for any projects where agent signalled completion
  if (uneofProjects.size > 0) {
    cullUneofDeployments(db, uneofProjects);
  }

  // Auto-merge project rows that share git identity within one harness slot.
  // The winner is the most-recently-active row; loser's stats are summed in,
  // sessions/todos re-pointed, loser row dropped. See docs/architecture/project-identity.md.
  if (housekeeping) {
    const merged = autoMergeIdenticalProjects(db);
    if (merged > 0) console.log(`[ingest] auto-merged ${merged} duplicate project row(s)`);
  }

  // When we last read the harnesses, so a dashboard can say how old what it
  // is showing might be.
  //
  // Every failure mode of ingestion looks the same from a page: no new
  // rows. A harness nobody ran, a worker that died overnight, a watcher
  // that never saw a new directory — all of them render as a quiet
  // dashboard. This is the one fact that separates them, and it is
  // recorded here rather than in the worker because a manual run through
  // /api/ingest counts too.
  // The witness pass: a bounded number of journals re-read from byte 0
  // against the leaves recorded when they were first ingested. A file
  // its writer re-hashed still verifies; it does not still agree with
  // what this process saw before the rewrite.
  //
  // The rewrite watch is the witness's opposite number: it keeps a live
  // shadow of the unchained files the witness will not touch yet, and
  // records before/after when a writer changes a line it already saw
  // (rewrite-watch.ts). A diagnostic, never evidence.
  if (housekeeping) {
    try {
      backfillWitness(db, 50, resolveSessionFile);
      auditAnchors(db, 25, resolveSessionFile);
      auditLanes(db, 25);
      watchRewrites(db, { limit: 25 });
    } catch { /* the witness is evidence, never a dependency of ingest */ }
  }

  setSetting(INGEST_HEARTBEAT_KEY, new Date().toISOString());

  return result;
}

export interface CloudIngestResult {
  accepted: number;
  errors: number;
}

export function ingestJsonlLines(
  db: ReturnType<typeof getDb>,
  lines: string[],
  projectName: string,
  sessionUuid: string
): CloudIngestResult {
  const result: CloudIngestResult = { accepted: 0, errors: 0 };

  const projectId = getOrCreateProject(db, projectName, projectName);
  const sessionId = getOrCreateSession(db, sessionUuid, projectId, {
    harness: 'cloud-ingest',
  });
  // Batches arrive with no offset; the chain continues from what the
  // previous batch for this session left persisted.
  const chain = new SessionChainTracker(db, sessionUuid, { reset: false, headKnown: true });

  const batchInsert = db.transaction((batch: string[]) => {
    for (const line of batch) {
      if (!line.trim()) continue;
      const rowHash = chain.feed(line);
      try {
        const raw = JSON.parse(line);
        // Auto-detect format: unfirehose/1.0 has type:"message" + role, Claude Code has type:"user"|"assistant"
        const entry = (raw.type === 'message' && raw.role) ? raw : normalizeClaudeCodeEntry(raw);
        if (!entry) {
          result.errors++;
          continue;
        }

        const messageId = insertMessage(db, sessionId, entry);
        if (messageId === null) {
          result.errors++;
          continue;
        }
        result.accepted++;
        if (rowHash) db.prepare('UPDATE messages SET row_hash = ? WHERE id = ?').run(rowHash, messageId);

        if (Array.isArray(entry.content)) {
          insertContentBlocks(db, messageId, entry.content);
        }

        const usage = entry.usage;
        if (usage && entry.timestamp) {
          updateUsageMinutes(db, projectId, entry.timestamp, {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
            cacheCreationTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
          });
        }

        extractTodosFromEntry(db, projectId, sessionId, raw, sessionUuid);
      } catch {
        result.errors++;
      }
    }
  });

  batchInsert(lines);
  db.transaction(() => chain.flush())();
  return result;
}
