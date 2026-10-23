import type Database from 'better-sqlite3';

/**
 * What the database holds per harness: sessions and the last message any of
 * them carried. Reads the sessions table only — tens of thousands of rows,
 * not the millions in messages — so Settings and the wizard can ask often.
 * Sessions from before harnesses were recorded are Claude Code's.
 */
export interface HarnessSessionStats {
  harness: string;
  sessions: number;
  lastMessageAt: string | null;
}

export function harnessSessionStats(db: Database.Database): HarnessSessionStats[] {
  return db.prepare(`
    SELECT COALESCE(harness, 'claude-code') AS harness,
           COUNT(*) AS sessions,
           MAX(COALESCE(last_message_at, updated_at, created_at)) AS lastMessageAt
      FROM sessions
     GROUP BY 1
     ORDER BY sessions DESC
  `).all() as HarnessSessionStats[];
}
