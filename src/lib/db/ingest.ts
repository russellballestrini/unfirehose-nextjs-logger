import { readdir, readFile, stat } from 'fs/promises';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import { getDb } from './schema';
import { claudePaths, decodeProjectName } from '../claude-paths';
import type { SessionsIndex } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface IngestResult {
  projectsAdded: number;
  sessionsAdded: number;
  messagesAdded: number;
  blocksAdded: number;
  filesScanned: number;
  alertsTriggered: number;
}

function getOrCreateProject(
  db: ReturnType<typeof getDb>,
  name: string,
  displayName: string,
  projectPath?: string
): number {
  const existing = db
    .prepare('SELECT id FROM projects WHERE name = ?')
    .get(name) as { id: number } | undefined;
  if (existing) return existing.id;

  const result = db
    .prepare(
      'INSERT INTO projects (name, display_name, path) VALUES (?, ?, ?)'
    )
    .run(name, displayName, projectPath ?? '');
  return result.lastInsertRowid as number;
}

function getOrCreateSession(
  db: ReturnType<typeof getDb>,
  sessionUuid: string,
  projectId: number,
  meta: {
    gitBranch?: string;
    firstPrompt?: string;
    cliVersion?: string;
    createdAt?: string;
    isSidechain?: boolean;
  }
): number {
  const existing = db
    .prepare('SELECT id FROM sessions WHERE session_uuid = ?')
    .get(sessionUuid) as { id: number } | undefined;
  if (existing) return existing.id;

  const result = db
    .prepare(
      `INSERT INTO sessions (session_uuid, project_id, git_branch, first_prompt, cli_version, created_at, is_sidechain)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessionUuid,
      projectId,
      meta.gitBranch ?? null,
      meta.firstPrompt ?? null,
      meta.cliVersion ?? null,
      meta.createdAt ?? null,
      meta.isSidechain ? 1 : 0
    );
  return result.lastInsertRowid as number;
}

function insertMessage(
  db: ReturnType<typeof getDb>,
  sessionId: number,
  entry: any
): number | null {
  const type = entry.type;
  if (!['user', 'assistant', 'system'].includes(type)) return null;

  const usage = entry.message?.usage;

  // Use INSERT OR IGNORE — the unique index on message_uuid handles dedup at DB level.
  // For entries without uuid, we still insert (null uuid doesn't trigger the unique constraint).
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO messages (
        session_id, message_uuid, parent_uuid, type, subtype, timestamp,
        model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        duration_ms, is_sidechain
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessionId,
      entry.uuid ?? null,
      entry.parentUuid ?? null,
      type,
      entry.subtype ?? null,
      entry.timestamp ?? null,
      entry.message?.model ?? null,
      usage?.input_tokens ?? 0,
      usage?.output_tokens ?? 0,
      usage?.cache_read_input_tokens ?? 0,
      usage?.cache_creation_input_tokens ?? 0,
      entry.durationMs ?? null,
      entry.isSidechain ? 1 : 0
    );

  // changes === 0 means the row was ignored (duplicate uuid)
  if (result.changes === 0) return null;
  return result.lastInsertRowid as number;
}

function insertContentBlocks(
  db: ReturnType<typeof getDb>,
  messageId: number,
  content: any[]
) {
  if (!Array.isArray(content)) return 0;

  const stmt = db.prepare(
    `INSERT INTO content_blocks (message_id, position, block_type, text_content, tool_name, tool_input, tool_use_id, is_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let count = 0;
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!block?.type) continue;

    let textContent: string | null = null;
    let toolName: string | null = null;
    let toolInput: string | null = null;
    let toolUseId: string | null = null;
    let isError = 0;

    switch (block.type) {
      case 'text':
        textContent = block.text ?? null;
        break;
      case 'thinking':
        textContent = block.thinking ?? null;
        break;
      case 'tool_use':
        toolName = block.name ?? null;
        toolInput = block.input ? JSON.stringify(block.input) : null;
        toolUseId = block.id ?? null;
        break;
      case 'tool_result':
        textContent =
          typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
        toolUseId = block.tool_use_id ?? null;
        isError = block.is_error ? 1 : 0;
        break;
      default:
        textContent = JSON.stringify(block);
        break;
    }

    stmt.run(messageId, i, block.type, textContent, toolName, toolInput, toolUseId, isError);
    count++;
  }
  return count;
}

function updateUsageMinutes(
  db: ReturnType<typeof getDb>,
  projectId: number,
  timestamp: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }
) {
  if (!timestamp) return;
  // Truncate to minute: "2026-03-03T14:30:45.123Z" -> "2026-03-03T14:30"
  const minute = timestamp.slice(0, 16);

  db.prepare(
    `INSERT INTO usage_minutes (minute, project_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, message_count)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(minute, project_id) DO UPDATE SET
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
       cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
       message_count = message_count + 1`
  ).run(
    minute,
    projectId,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheCreationTokens
  );
}

function checkThresholds(db: ReturnType<typeof getDb>): number {
  const thresholds = db
    .prepare('SELECT * FROM alert_thresholds WHERE enabled = 1')
    .all() as Array<{
    id: number;
    window_minutes: number;
    metric: string;
    threshold_value: number;
  }>;

  let triggered = 0;
  const now = new Date();

  for (const t of thresholds) {
    const windowStart = new Date(now.getTime() - t.window_minutes * 60 * 1000);
    const windowStartStr = windowStart.toISOString().slice(0, 16);

    let actual = 0;
    if (t.metric === 'total_tokens') {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) as total
           FROM usage_minutes WHERE minute >= ?`
        )
        .get(windowStartStr) as { total: number };
      actual = row.total;
    } else {
      const col = t.metric; // input_tokens, output_tokens
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(${col}), 0) as total FROM usage_minutes WHERE minute >= ?`
        )
        .get(windowStartStr) as { total: number };
      actual = row.total;
    }

    if (actual > t.threshold_value) {
      // Check if we already alerted in this window (don't spam)
      const recentAlert = db
        .prepare(
          `SELECT id FROM alerts
           WHERE alert_type = 'threshold_breach' AND window_minutes = ? AND metric = ?
           AND triggered_at >= datetime('now', '-' || ? || ' minutes')`
        )
        .get(t.window_minutes, t.metric, t.window_minutes) as
        | { id: number }
        | undefined;

      if (!recentAlert) {
        db.prepare(
          `INSERT INTO alerts (alert_type, window_minutes, metric, threshold_value, actual_value, details)
           VALUES ('threshold_breach', ?, ?, ?, ?, ?)`
        ).run(
          t.window_minutes,
          t.metric,
          t.threshold_value,
          actual,
          JSON.stringify({
            windowStart: windowStartStr,
            ratio: (actual / t.threshold_value).toFixed(2),
          })
        );
        triggered++;
      }
    }
  }

  return triggered;
}

export async function ingestAll(): Promise<IngestResult> {
  const db = getDb();
  const result: IngestResult = {
    projectsAdded: 0,
    sessionsAdded: 0,
    messagesAdded: 0,
    blocksAdded: 0,
    filesScanned: 0,
    alertsTriggered: 0,
  };

  const projectDirs = await readdir(claudePaths.projects).catch(() => []);

  for (const dir of projectDirs) {
    const projDir = claudePaths.projectDir(dir);
    const dirStat = await stat(projDir).catch(() => null);
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
      const indexRaw = await readFile(claudePaths.sessionsIndex(dir), 'utf-8');
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
      // Scan for JSONL files directly
      try {
        const files = await readdir(projDir);
        sessionMeta = files
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => ({ sessionId: f.replace('.jsonl', '') }));
      } catch {
        continue;
      }
    }

    if (sessionMeta.length === 0) continue;

    const projectId = getOrCreateProject(
      db,
      dir,
      decodeProjectName(dir),
      projectPath
    );

    // Check if project was new
    const prevCount = db
      .prepare('SELECT COUNT(*) as c FROM sessions WHERE project_id = ?')
      .get(projectId) as { c: number };
    if (prevCount.c === 0 && sessionMeta.length > 0) result.projectsAdded++;

    for (const meta of sessionMeta) {
      const filePath = claudePaths.sessionFile(dir, meta.sessionId);
      const fstat = await stat(filePath).catch(() => null);
      if (!fstat) continue;

      // Check ingestion offset
      const offset = db
        .prepare('SELECT byte_offset FROM ingest_offsets WHERE file_path = ?')
        .get(filePath) as { byte_offset: number } | undefined;
      const startByte = offset?.byte_offset ?? 0;

      if (fstat.size <= startByte) continue; // nothing new

      result.filesScanned++;

      const sessionId = getOrCreateSession(db, meta.sessionId, projectId, {
        gitBranch: meta.gitBranch,
        firstPrompt: meta.firstPrompt,
        createdAt: meta.createdAt,
        isSidechain: meta.isSidechain,
      });

      if (!offset) result.sessionsAdded++;

      // Stream new lines from the file
      const stream = createReadStream(filePath, {
        start: startByte,
        encoding: 'utf-8',
      });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      // Batch insert in a transaction for speed
      const batchInsert = db.transaction(
        (lines: string[]) => {
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              const messageId = insertMessage(db, sessionId, entry);
              if (messageId === null) continue; // skipped (duplicate or non-message type)

              result.messagesAdded++;

              // Insert content blocks
              const content =
                entry.message?.content ??
                (entry.type === 'user' && typeof entry.message?.content === 'string'
                  ? [{ type: 'text', text: entry.message.content }]
                  : []);
              if (Array.isArray(content)) {
                result.blocksAdded += insertContentBlocks(db, messageId, content);
              }

              // Update usage minutes for assistant messages with token data
              const usage = entry.message?.usage;
              if (usage && entry.timestamp) {
                updateUsageMinutes(db, projectId, entry.timestamp, {
                  inputTokens: usage.input_tokens ?? 0,
                  outputTokens: usage.output_tokens ?? 0,
                  cacheReadTokens: usage.cache_read_input_tokens ?? 0,
                  cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
                });
              }
            } catch {
              // skip malformed lines
            }
          }
        }
      );

      const batch: string[] = [];
      for await (const line of rl) {
        batch.push(line);
        if (batch.length >= 500) {
          batchInsert(batch.splice(0));
        }
      }
      if (batch.length > 0) {
        batchInsert(batch);
      }

      // Update ingestion offset
      db.prepare(
        `INSERT INTO ingest_offsets (file_path, byte_offset, last_ingested)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(file_path) DO UPDATE SET
           byte_offset = excluded.byte_offset,
           last_ingested = excluded.last_ingested`
      ).run(filePath, fstat.size);

      // Update session modified timestamp
      db.prepare(
        'UPDATE sessions SET updated_at = ? WHERE session_uuid = ?'
      ).run(new Date().toISOString(), meta.sessionId);
    }
  }

  // Check alert thresholds
  result.alertsTriggered = checkThresholds(db);

  return result;
}

export function getRecentAlerts(limit = 20) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM alerts ORDER BY triggered_at DESC LIMIT ?`
    )
    .all(limit);
}

export function getUnacknowledgedAlerts() {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM alerts WHERE acknowledged = 0 ORDER BY triggered_at DESC`
    )
    .all();
}

export function acknowledgeAlert(id: number) {
  const db = getDb();
  db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').run(id);
}

export function getUsageTimeline(minutes = 60) {
  const db = getDb();

  if (minutes === 0) {
    return db
      .prepare(
        `SELECT minute,
                SUM(input_tokens) as input_tokens,
                SUM(output_tokens) as output_tokens,
                SUM(cache_read_tokens) as cache_read_tokens,
                SUM(cache_creation_tokens) as cache_creation_tokens,
                SUM(message_count) as message_count
         FROM usage_minutes
         GROUP BY minute
         ORDER BY minute`
      )
      .all();
  }

  const windowStart = new Date(Date.now() - minutes * 60 * 1000)
    .toISOString()
    .slice(0, 16);

  return db
    .prepare(
      `SELECT minute,
              SUM(input_tokens) as input_tokens,
              SUM(output_tokens) as output_tokens,
              SUM(cache_read_tokens) as cache_read_tokens,
              SUM(cache_creation_tokens) as cache_creation_tokens,
              SUM(message_count) as message_count
       FROM usage_minutes
       WHERE minute >= ?
       GROUP BY minute
       ORDER BY minute`
    )
    .all(windowStart);
}

export function getUsageByProject(minutes = 60) {
  const db = getDb();

  if (minutes === 0) {
    return db
      .prepare(
        `SELECT p.name, p.display_name,
                SUM(um.input_tokens) as input_tokens,
                SUM(um.output_tokens) as output_tokens,
                SUM(um.cache_read_tokens) as cache_read_tokens,
                SUM(um.message_count) as message_count
         FROM usage_minutes um
         JOIN projects p ON p.id = um.project_id
         GROUP BY p.id
         ORDER BY SUM(um.input_tokens + um.output_tokens) DESC`
      )
      .all();
  }

  const windowStart = new Date(Date.now() - minutes * 60 * 1000)
    .toISOString()
    .slice(0, 16);

  return db
    .prepare(
      `SELECT p.name, p.display_name,
              SUM(um.input_tokens) as input_tokens,
              SUM(um.output_tokens) as output_tokens,
              SUM(um.cache_read_tokens) as cache_read_tokens,
              SUM(um.message_count) as message_count
       FROM usage_minutes um
       JOIN projects p ON p.id = um.project_id
       WHERE um.minute >= ?
       GROUP BY p.id
       ORDER BY SUM(um.input_tokens + um.output_tokens) DESC`
    )
    .all(windowStart);
}

export function getDbStats() {
  const db = getDb();
  const projects = db
    .prepare('SELECT COUNT(*) as c FROM projects')
    .get() as { c: number };
  const sessions = db
    .prepare('SELECT COUNT(*) as c FROM sessions')
    .get() as { c: number };
  const messages = db
    .prepare('SELECT COUNT(*) as c FROM messages')
    .get() as { c: number };
  const blocks = db
    .prepare('SELECT COUNT(*) as c FROM content_blocks')
    .get() as { c: number };
  const thinkingBlocks = db
    .prepare("SELECT COUNT(*) as c FROM content_blocks WHERE block_type = 'thinking'")
    .get() as { c: number };
  const totalTokens = db
    .prepare(
      'SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) as total FROM messages'
    )
    .get() as { total: number };
  const alerts = db
    .prepare('SELECT COUNT(*) as c FROM alerts')
    .get() as { c: number };

  return {
    projects: projects.c,
    sessions: sessions.c,
    messages: messages.c,
    contentBlocks: blocks.c,
    thinkingBlocks: thinkingBlocks.c,
    totalTokensStored: totalTokens.total,
    alerts: alerts.c,
  };
}

export function getProjectActivity(days = 30) {
  const db = getDb();
  return db.prepare(`
    SELECT
      p.name,
      p.display_name,
      COUNT(CASE WHEN m.type = 'user' THEN 1 END) as user_messages,
      COUNT(CASE WHEN m.type = 'assistant' THEN 1 END) as assistant_messages,
      COUNT(DISTINCT s.session_uuid) as session_count,
      COUNT(DISTINCT DATE(m.timestamp)) as active_days,
      MAX(m.timestamp) as last_activity,
      SUM(m.input_tokens) as total_input,
      SUM(m.output_tokens) as total_output,
      SUM(m.cache_read_tokens) as total_cache_read,
      SUM(m.cache_creation_tokens) as total_cache_write
    FROM messages m
    JOIN sessions s ON m.session_id = s.id
    JOIN projects p ON s.project_id = p.id
    WHERE m.timestamp > datetime('now', '-' || ? || ' days')
    GROUP BY p.id
    ORDER BY MAX(m.timestamp) DESC
  `).all(days);
}

export function getProjectRecentPrompts(projectName: string, limit = 5) {
  const db = getDb();
  return db.prepare(`
    SELECT
      cb.text_content as prompt,
      m.timestamp,
      s.session_uuid
    FROM content_blocks cb
    JOIN messages m ON cb.message_id = m.id
    JOIN sessions s ON m.session_id = s.id
    JOIN projects p ON s.project_id = p.id
    WHERE p.name = ?
      AND m.type = 'user'
      AND cb.block_type = 'text'
      AND cb.text_content IS NOT NULL
      AND LENGTH(cb.text_content) > 20
      AND cb.text_content NOT LIKE '%[Request interrupted%'
      AND cb.text_content NOT LIKE '%<system%'
      AND cb.text_content NOT LIKE '{"type"%'
      AND cb.text_content NOT LIKE '[Image:%'
      AND cb.text_content NOT LIKE 'Continue from where you left off%'
      AND m.timestamp > datetime('now', '-30 days')
    ORDER BY m.timestamp DESC
    LIMIT ?
  `).all(projectName, limit) as Array<{ prompt: string; timestamp: string; session_uuid: string }>;
}

export function getAlertThresholds() {
  const db = getDb();
  return db.prepare('SELECT * FROM alert_thresholds ORDER BY window_minutes, metric').all();
}

export function updateAlertThreshold(
  id: number,
  value: number,
  enabled: boolean
) {
  const db = getDb();
  db.prepare(
    'UPDATE alert_thresholds SET threshold_value = ?, enabled = ? WHERE id = ?'
  ).run(value, enabled ? 1 : 0, id);
}

// === Alert Detail Queries ===

export function getAlertById(id: number) {
  const db = getDb();
  return db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as {
    id: number;
    triggered_at: string;
    alert_type: string;
    window_minutes: number;
    metric: string;
    threshold_value: number;
    actual_value: number;
    project_name: string | null;
    details: string | null;
    acknowledged: number;
  } | undefined;
}

export function getUsageByProjectInWindow(windowStart: string, windowEnd: string) {
  const db = getDb();
  return db.prepare(`
    SELECT p.name, p.display_name,
           SUM(um.input_tokens) as input_tokens,
           SUM(um.output_tokens) as output_tokens,
           SUM(um.cache_read_tokens) as cache_read_tokens,
           SUM(um.cache_creation_tokens) as cache_creation_tokens,
           SUM(um.message_count) as message_count
    FROM usage_minutes um
    JOIN projects p ON p.id = um.project_id
    WHERE um.minute >= ? AND um.minute <= ?
    GROUP BY p.id
    ORDER BY SUM(um.input_tokens + um.output_tokens) DESC
  `).all(windowStart, windowEnd) as Array<{
    name: string;
    display_name: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    message_count: number;
  }>;
}

export function getModelBreakdownInWindow(windowStart: string, windowEnd: string) {
  const db = getDb();
  return db.prepare(`
    SELECT m.model,
           COUNT(*) as message_count,
           SUM(m.input_tokens) as input_tokens,
           SUM(m.output_tokens) as output_tokens,
           SUM(m.cache_read_tokens) as cache_read_tokens,
           SUM(m.cache_creation_tokens) as cache_creation_tokens
    FROM messages m
    WHERE m.timestamp >= ? AND m.timestamp <= ?
      AND m.type = 'assistant'
    GROUP BY m.model
    ORDER BY SUM(m.input_tokens + m.output_tokens) DESC
  `).all(windowStart, windowEnd) as Array<{
    model: string | null;
    message_count: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
  }>;
}

export function getActiveSessionsInWindow(windowStart: string, windowEnd: string) {
  const db = getDb();
  return db.prepare(`
    SELECT s.session_uuid, p.name as project_name, p.display_name,
           s.git_branch, s.first_prompt,
           COUNT(m.id) as message_count,
           SUM(m.input_tokens) as input_tokens,
           SUM(m.output_tokens) as output_tokens
    FROM messages m
    JOIN sessions s ON m.session_id = s.id
    JOIN projects p ON s.project_id = p.id
    WHERE m.timestamp >= ? AND m.timestamp <= ?
    GROUP BY s.id
    ORDER BY SUM(m.input_tokens + m.output_tokens) DESC
  `).all(windowStart, windowEnd) as Array<{
    session_uuid: string;
    project_name: string;
    display_name: string;
    git_branch: string | null;
    first_prompt: string | null;
    message_count: number;
    input_tokens: number;
    output_tokens: number;
  }>;
}

export function getThinkingBlocksInWindow(windowStart: string, windowEnd: string) {
  const db = getDb();
  return db.prepare(`
    SELECT cb.text_content, LENGTH(cb.text_content) as char_count,
           m.id as message_id, m.timestamp, m.model,
           s.session_uuid, p.name as project_name, p.display_name
    FROM content_blocks cb
    JOIN messages m ON cb.message_id = m.id
    JOIN sessions s ON m.session_id = s.id
    JOIN projects p ON s.project_id = p.id
    WHERE cb.block_type = 'thinking'
      AND m.timestamp >= ? AND m.timestamp <= ?
    ORDER BY m.timestamp DESC
  `).all(windowStart, windowEnd) as Array<{
    text_content: string;
    char_count: number;
    message_id: number;
    timestamp: string;
    model: string | null;
    session_uuid: string;
    project_name: string;
    display_name: string;
  }>;
}

export function getTimelineInWindow(windowStart: string, windowEnd: string) {
  const db = getDb();
  return db.prepare(`
    SELECT minute,
           SUM(input_tokens) as input_tokens,
           SUM(output_tokens) as output_tokens,
           SUM(cache_read_tokens) as cache_read_tokens,
           SUM(cache_creation_tokens) as cache_creation_tokens,
           SUM(message_count) as message_count
    FROM usage_minutes
    WHERE minute >= ? AND minute <= ?
    GROUP BY minute
    ORDER BY minute
  `).all(windowStart, windowEnd) as Array<{
    minute: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    message_count: number;
  }>;
}

// === Settings ===

export function getSetting(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const result: Record<string, string> = {};
  for (const r of rows) result[r.key] = r.value;
  return result;
}

export function deleteSetting(key: string) {
  const db = getDb();
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

// Plan-based threshold multipliers
const PLAN_THRESHOLDS: Record<string, Record<string, number>> = {
  // Free: conservative, single-agent light usage
  free:    { '1:output_tokens': 50000,  '1:input_tokens': 500000,   '5:output_tokens': 200000,  '5:input_tokens': 2000000,   '5:total_tokens': 2500000,   '15:total_tokens': 5000000,   '60:total_tokens': 15000000  },
  // Starter $14/mo: individual, a few agents
  starter: { '1:output_tokens': 100000, '1:input_tokens': 1000000,  '5:output_tokens': 400000,  '5:input_tokens': 4000000,   '5:total_tokens': 5000000,   '15:total_tokens': 10000000,  '60:total_tokens': 30000000  },
  // Pro $69/mo: power user, multiple concurrent agents
  pro:     { '1:output_tokens': 175000, '1:input_tokens': 1750000,  '5:output_tokens': 700000,  '5:input_tokens': 7000000,   '5:total_tokens': 8750000,   '15:total_tokens': 17500000,  '60:total_tokens': 52500000  },
  // Max $200/mo: heavy multi-agent, 20+ concurrent
  max:     { '1:output_tokens': 250000, '1:input_tokens': 2500000,  '5:output_tokens': 1000000, '5:input_tokens': 10000000,  '5:total_tokens': 12500000,  '15:total_tokens': 25000000,  '60:total_tokens': 75000000  },
  // Ultra $420/mo: maximum capacity, fleet operations
  ultra:   { '1:output_tokens': 500000, '1:input_tokens': 5000000,  '5:output_tokens': 2000000, '5:input_tokens': 20000000,  '5:total_tokens': 25000000,  '15:total_tokens': 50000000,  '60:total_tokens': 150000000 },
};

export function applyPlanThresholds(plan: string) {
  const db = getDb();
  const thresholds = PLAN_THRESHOLDS[plan];
  if (!thresholds) return;

  const update = db.prepare(
    'UPDATE alert_thresholds SET threshold_value = ? WHERE window_minutes = ? AND metric = ?'
  );

  db.transaction(() => {
    for (const [key, value] of Object.entries(thresholds)) {
      const [win, metric] = key.split(':');
      update.run(value, Number(win), metric);
    }
  })();

  setSetting('anthropic_plan', plan);
}

// === Posts (jsonblog.org schema) ===

export function createPost(opts: {
  title: string;
  description?: string;
  source?: string;
  content?: string;
  url?: string;
}): number {
  const db = getDb();
  const uuid = crypto.randomUUID();
  const result = db.prepare(
    `INSERT INTO posts (post_uuid, title, description, source, content, url)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    uuid,
    opts.title,
    opts.description ?? null,
    opts.source ?? null,
    opts.content ?? null,
    opts.url ?? null,
  );
  return result.lastInsertRowid as number;
}

export function getPosts(limit = 50, offset = 0) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM posts ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset) as PostRow[];
}

export function getPost(id: number) {
  const db = getDb();
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as PostRow | undefined;
}

export function deletePost(id: number) {
  const db = getDb();
  db.prepare('DELETE FROM posts WHERE id = ?').run(id);
}

export interface PostRow {
  id: number;
  post_uuid: string;
  title: string;
  description: string | null;
  source: string | null;
  content: string | null;
  url: string | null;
  created_at: string;
  updated_at: string;
}

export function getUserPromptsInWindow(windowStart: string, windowEnd: string) {
  const db = getDb();
  return db.prepare(`
    SELECT cb.text_content as prompt,
           m.timestamp,
           s.session_uuid,
           p.name as project_name,
           p.display_name
    FROM content_blocks cb
    JOIN messages m ON cb.message_id = m.id
    JOIN sessions s ON m.session_id = s.id
    JOIN projects p ON s.project_id = p.id
    WHERE m.type = 'user'
      AND cb.block_type = 'text'
      AND cb.text_content IS NOT NULL
      AND LENGTH(cb.text_content) > 10
      AND cb.text_content NOT LIKE '%<system%'
      AND cb.text_content NOT LIKE '{"type"%'
      AND m.timestamp >= ? AND m.timestamp <= ?
    ORDER BY m.timestamp DESC
  `).all(windowStart, windowEnd) as Array<{
    prompt: string;
    timestamp: string;
    session_uuid: string;
    project_name: string;
    display_name: string;
  }>;
}
