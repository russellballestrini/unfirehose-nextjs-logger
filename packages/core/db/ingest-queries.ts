// Read-side usage and activity queries over the ingested tables.
// Extracted from ingest.ts.
import { getDb } from './schema';
import { REASONING_SQL } from '../block-types';

/**
 * The start of a rolling window, as a `usage_minutes.minute` key.
 *
 * Null means "no window" — a lifetime query, which takes no parameter at
 * all rather than one far enough back to include everything. Sliced to
 * minute precision because that is the column's own granularity; a longer
 * string compares as greater than every row for the same minute.
 */
export function windowStart(minutes: number): string | null {
  if (minutes <= 0) return null;
  return new Date(Date.now() - minutes * 60 * 1000).toISOString().slice(0, 16);
}

export function getUsageTimeline(minutes = 60) {
  const db = getDb();

  // Bucket size: per-minute for <=24h, per-hour for <=14d, per-day for 28d+/lifetime
  // substr(minute, 1, 16) = per-minute (2025-03-03T12:34)
  // substr(minute, 1, 13) = per-hour   (2025-03-03T12)
  // substr(minute, 1, 10) = per-day    (2025-03-03)
  const bucket = minutes <= 1440 ? 16 : minutes <= 20160 ? 13 : 10;

  const query = `SELECT substr(minute, 1, ${bucket}) as minute,
              SUM(input_tokens) as input_tokens,
              SUM(output_tokens) as output_tokens,
              SUM(cache_read_tokens) as cache_read_tokens,
              SUM(cache_creation_tokens) as cache_creation_tokens,
              SUM(message_count) as message_count
       FROM usage_minutes
       ${minutes > 0 ? 'WHERE minute >= ?' : ''}
       GROUP BY substr(minute, 1, ${bucket})
       ORDER BY minute`;

  const start = windowStart(minutes);
  return start === null ? db.prepare(query).all() : db.prepare(query).all(start);
}

export function getUsageByProject(minutes = 60) {
  const db = getDb();

  // One query with an optional window, the way getUsageTimeline above does
  // it. This was written out twice — once with the WHERE and once without —
  // so the two copies of the SUM list had to agree about every column that
  // is ever added to usage_minutes.
  const query = `SELECT p.name, p.display_name,
                SUM(um.input_tokens) as input_tokens,
                SUM(um.output_tokens) as output_tokens,
                SUM(um.cache_read_tokens) as cache_read_tokens,
                SUM(um.message_count) as message_count
         FROM usage_minutes um
         JOIN projects p ON p.id = um.project_id
         ${minutes > 0 ? 'WHERE um.minute >= ?' : ''}
         GROUP BY p.id
         ORDER BY SUM(um.input_tokens + um.output_tokens) DESC`;

  const start = windowStart(minutes);
  return start === null ? db.prepare(query).all() : db.prepare(query).all(start);
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
    .prepare(`SELECT COUNT(*) as c FROM content_blocks WHERE block_type ${REASONING_SQL}`)
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
      COALESCE(p.path, p.last_cwd_seen) as path,
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

/**
 * Per-project, per-model token sums over the same window as getProjectActivity.
 *
 * Callers price these with the model catalog rather than a blended average.
 * A single blended rate reports a project that ran entirely on ox-alpha and a
 * local Qwen at Opus rates — measured 2026-08-25, riseallships showed $14
 * against an actual $0.70.
 *
 * Split by day so each day prices at the rate then in force (ticket 4008).
 */
export function getProjectModelActivity(days = 30) {
  const db = getDb();
  return db.prepare(`
    SELECT
      p.name                            AS name,
      COALESCE(m.model, '')             AS model,
      m.provider                        AS provider,
      m.endpoint                        AS endpoint,
      substr(m.timestamp, 1, 10)        AS day,
      SUM(m.input_tokens)               AS input,
      SUM(m.output_tokens)              AS output,
      SUM(m.cache_read_tokens)          AS cache_read,
      SUM(m.cache_creation_tokens)      AS cache_write
    FROM messages m
    JOIN sessions s ON m.session_id = s.id
    JOIN projects p ON s.project_id = p.id
    WHERE m.timestamp > datetime('now', '-' || ? || ' days')
      AND m.model IS NOT NULL AND m.model != ''
    GROUP BY p.id, m.model, m.provider, m.endpoint, day
  `).all(days) as Array<{
    name: string;
    model: string;
    provider: string | null;
    endpoint: string | null;
    /** YYYY-MM-DD — callers book each day at the price in force that day. */
    day: string;
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
  }>;
}

export function getProjectRecentPrompts(projectName: string, limit = 5) {
  const db = getDb();
  return db.prepare(`
    SELECT
      cb.text_content as prompt,
      m.timestamp,
      s.session_uuid,
      (
        SELECT cb2.text_content
        FROM messages m2
        JOIN content_blocks cb2 ON cb2.message_id = m2.id
        WHERE m2.session_id = m.session_id
          AND m2.type = 'assistant'
          AND m2.id = (
            SELECT MIN(m3.id) FROM messages m3
            WHERE m3.session_id = m.session_id
              AND m3.type = 'assistant'
              AND m3.id > m.id
          )
          AND cb2.block_type = 'text'
          AND cb2.text_content IS NOT NULL
        ORDER BY cb2.position ASC
        LIMIT 1
      ) as response
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
      AND cb.text_content NOT LIKE '%Shadow Clone Activation%'
      AND cb.text_content NOT LIKE '%Agent Blackops%'
      AND cb.text_content NOT LIKE '%blackops%'
      AND cb.text_content NOT LIKE '%You operate as agent%'
      AND cb.text_content NOT LIKE '%DEFINES your identity%'
      AND cb.text_content NOT LIKE '%<local-command-%'
      AND cb.text_content NOT LIKE '%<command-name>%'
      AND cb.text_content NOT LIKE '%Caveat:%The messages below%'
      AND cb.text_content NOT LIKE '%DO NOT respond to these messages%'
      AND cb.text_content NOT LIKE '%<available-deferred-tools>%'
      AND m.timestamp > datetime('now', '-30 days')
    ORDER BY m.timestamp DESC
    LIMIT ?
  `).all(projectName, limit) as Array<{ prompt: string; timestamp: string; session_uuid: string; response: string | null }>;
}

/**
 * Per-project, per-model usage in a window, straight from `messages`.
 *
 * `getUsageByProjectInWindow` reads `usage_minutes`, which is pre-aggregated
 * and carries no model column — so anything built on it can only apply one
 * blended rate to every project, which is exactly the defect that made the
 * same tokens cost $14 on one page and $0.70 on another. Cost callers use
 * this and price each model against the catalog.
 */
export function getProjectModelUsageInWindow(windowStart: string, windowEnd: string) {
  const db = getDb();
  return db.prepare(`
    SELECT p.name                       AS name,
           p.display_name               AS display_name,
           COALESCE(m.model, '')        AS model,
           m.provider                   AS provider,
           m.endpoint                   AS endpoint,
           SUM(m.input_tokens)          AS input_tokens,
           SUM(m.output_tokens)         AS output_tokens,
           SUM(m.cache_read_tokens)     AS cache_read_tokens,
           SUM(m.cache_creation_tokens) AS cache_creation_tokens,
           COUNT(*)                     AS message_count
    FROM messages m
    JOIN sessions s ON m.session_id = s.id
    JOIN projects p ON s.project_id = p.id
    WHERE m.timestamp >= ? AND m.timestamp <= ?
    GROUP BY p.id, m.model, m.provider, m.endpoint
  `).all(windowStart, windowEnd) as Array<{
    name: string;
    display_name: string;
    model: string;
    provider: string | null;
    endpoint: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    message_count: number;
  }>;
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
           SUM(m.cache_creation_tokens) as cache_creation_tokens,
           -- Who served it. The alert detail page has always asked for these
           -- to decide self-hosted vs bought, and the query never returned
           -- them, so that decision fell back to guessing from the model
           -- name. MAX picks one non-null value per model, which is what a
           -- model served by one route has anyway.
           MAX(m.provider) as provider,
           MAX(m.endpoint) as endpoint
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
    provider: string | null;
    endpoint: string | null;
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
    WHERE cb.block_type ${REASONING_SQL}
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
