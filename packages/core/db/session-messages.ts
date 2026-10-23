/**
 * A session read back from our rows as unfirehose/1.0 messages.
 *
 * The session viewer streams a harness's own JSONL when it has one laid out
 * by session. A harness in a format of its own (Codex rollouts, Gemini CLI
 * recordings, Continue sessions; `stored` adapters in session-paths.ts) has
 * none, so the viewer reads what ingest stored instead: the messages and
 * content_blocks rows, which are the same rows for every harness.
 */
import type { getDb } from './schema';
import type { UfMessage } from '../session-paths';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Db = ReturnType<typeof getDb>;

function block(row: any): any {
  switch (row.block_type) {
    case 'text':
    case 'reasoning':
      return { type: row.block_type, text: row.text_content ?? '' };
    case 'tool-call': {
      let input: unknown = row.tool_input;
      try { input = row.tool_input ? JSON.parse(row.tool_input) : {}; } catch { /* keep the stored text */ }
      return { type: 'tool-call', toolCallId: row.tool_use_id, toolName: row.tool_name, input };
    }
    case 'tool-result':
      return { type: 'tool-result', toolCallId: row.tool_use_id, output: row.text_content ?? '', isError: !!row.is_error };
    default: {
      try { return JSON.parse(row.text_content); } catch { return { type: row.block_type, text: row.text_content }; }
    }
  }
}

/** Every message of a session, oldest first, with its blocks in order. */
export function storedSessionMessages(db: Db, sessionUuid: string): UfMessage[] {
  const session = db.prepare('SELECT id, harness FROM sessions WHERE session_uuid = ?').get(sessionUuid) as { id: number; harness: string | null } | undefined;
  if (!session) return [];
  const rows = db.prepare(
    `SELECT m.id, m.message_uuid, m.parent_uuid, m.type, m.subtype, m.timestamp, m.model, m.is_sidechain,
            m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_creation_tokens,
            cb.block_type, cb.text_content, cb.tool_name, cb.tool_input, cb.tool_use_id, cb.is_error
       FROM messages m LEFT JOIN content_blocks cb ON cb.message_id = m.id
      WHERE m.session_id = ?
      ORDER BY m.timestamp, m.id, cb.position`,
  ).all(session.id) as any[];
  const out: UfMessage[] = [];
  let current: UfMessage | null = null;
  let currentId = -1;
  for (const r of rows) {
    if (r.id !== currentId) {
      currentId = r.id;
      const usage = r.input_tokens || r.output_tokens || r.cache_read_tokens || r.cache_creation_tokens ? {
        inputTokens: r.input_tokens, outputTokens: r.output_tokens,
        inputTokenDetails: { cacheReadTokens: r.cache_read_tokens, cacheWriteTokens: r.cache_creation_tokens },
      } : undefined;
      current = {
        $schema: 'unfirehose/1.0', type: 'message', role: r.type, id: r.message_uuid, parentId: r.parent_uuid,
        sessionId: sessionUuid, timestamp: r.timestamp, model: r.model, subtype: r.subtype,
        sidechain: !!r.is_sidechain, content: [], ...(usage ? { usage } : {}),
        ...(session.harness ? { harness: session.harness } : {}),
      };
      out.push(current);
    }
    if (r.block_type) current!.content.push(block(r));
  }
  return out;
}

/** A stored project's sessions, as the session list wants them. */
export function storedProjectSessions(db: Db, projectName: string): Array<{
  sessionId: string; messageCount: number; gitBranch?: string; firstPrompt?: string; modified?: string; created?: string;
}> {
  const rows = db.prepare(
    `SELECT s.session_uuid, s.git_branch, s.first_prompt, s.created_at,
            COALESCE(s.last_message_at, MAX(m.timestamp), s.updated_at) AS modified, COUNT(m.id) AS message_count
       FROM sessions s JOIN projects p ON p.id = s.project_id
       LEFT JOIN messages m ON m.session_id = s.id
      WHERE p.name = ?
      GROUP BY s.id`,
  ).all(projectName) as Array<{ session_uuid: string; git_branch: string | null; first_prompt: string | null; created_at: string | null; modified: string | null; message_count: number }>;
  return rows.map((r) => ({
    sessionId: r.session_uuid,
    messageCount: r.message_count,
    gitBranch: r.git_branch ?? undefined,
    firstPrompt: r.first_prompt ?? undefined,
    modified: r.modified ?? undefined,
    created: r.created_at ?? undefined,
  }));
}
