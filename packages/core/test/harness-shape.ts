/**
 * The rows a harness's session leaves, as a shape two harnesses can be
 * compared by: every user and assistant block in order, with which columns
 * it fills. A foreign reader is right when its fixture lands the same shape
 * as the Claude Code fixture of the same turn (test/fixtures/harnesses/):
 * a prompt, reasoning, a reply, a tool call, its result, a final reply.
 */
import { readFileSync } from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';

export const FIXTURES = path.join(__dirname, 'fixtures', 'harnesses');
export const CLAUDE_FIXTURE_SESSION = '7d1f0c2e-5a4b-4c3d-9e8f-1a2b3c4d5e6f';

export interface BlockShape {
  message: string;
  block: string;
  text: boolean;
  toolName: boolean;
  toolInput: boolean;
  toolUseId: boolean;
}

export function blockShape(db: Database.Database, sessionUuid: string): BlockShape[] {
  const rows = db.prepare(
    `SELECT m.type, cb.block_type, cb.text_content, cb.tool_name, cb.tool_input, cb.tool_use_id
       FROM messages m JOIN sessions s ON s.id = m.session_id JOIN content_blocks cb ON cb.message_id = m.id
      WHERE s.session_uuid = ? AND m.type IN ('user', 'assistant')
      ORDER BY m.timestamp, m.id, cb.position`,
  ).all(sessionUuid) as Array<{ type: string; block_type: string; text_content: string | null; tool_name: string | null; tool_input: string | null; tool_use_id: string | null }>;
  return rows.map((r) => ({
    message: r.type, block: r.block_type, text: r.text_content !== null, toolName: r.tool_name !== null,
    toolInput: r.tool_input !== null, toolUseId: r.tool_use_id !== null,
  }));
}

/** The texts of a session's user/assistant text and reasoning blocks, in order. */
export function sessionTexts(db: Database.Database, sessionUuid: string): string[] {
  return (db.prepare(
    `SELECT cb.text_content AS t FROM messages m JOIN sessions s ON s.id = m.session_id JOIN content_blocks cb ON cb.message_id = m.id
      WHERE s.session_uuid = ? AND m.type IN ('user', 'assistant') AND cb.block_type IN ('text', 'reasoning')
      ORDER BY m.timestamp, m.id, cb.position`,
  ).all(sessionUuid) as Array<{ t: string }>).map((r) => r.t);
}

/** Token totals booked to a session, as the dashboards sum them. */
export function sessionTokens(db: Database.Database, sessionUuid: string) {
  return db.prepare(
    `SELECT SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cacheRead
       FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.session_uuid = ?`,
  ).get(sessionUuid) as { input: number; output: number; cacheRead: number };
}

export function claudeFixtureLines(): string[] {
  return readFileSync(path.join(FIXTURES, 'claude-code', `${CLAUDE_FIXTURE_SESSION}.jsonl`), 'utf8').trim().split('\n');
}
