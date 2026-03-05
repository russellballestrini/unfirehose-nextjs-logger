import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unfirehose/core/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const projectFilter = url.searchParams.get('project');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '200'), 5000);
  const offset = parseInt(url.searchParams.get('offset') ?? '0');
  const search = url.searchParams.get('search')?.trim();
  const dateFrom = url.searchParams.get('from');
  const dateTo = url.searchParams.get('to');

  try {
    const db = getDb();
    const params: any[] = [];

    let where = "cb.block_type = 'thinking' AND cb.text_content IS NOT NULL AND cb.text_content != ''";

    if (projectFilter) {
      where += ' AND p.name = ?';
      params.push(projectFilter);
    }
    if (dateFrom) {
      where += ' AND m.timestamp >= ?';
      params.push(dateFrom);
    }
    if (dateTo) {
      where += ' AND m.timestamp <= ?';
      params.push(dateTo + 'T23:59:59');
    }
    if (search) {
      where += ' AND cb.text_content LIKE ?';
      params.push(`%${search}%`);
    }

    const query = `
      SELECT cb.text_content as thinking, cb.message_id,
             m.timestamp, m.model, m.session_id,
             s.session_uuid, s.display_name as session_display,
             p.name as project_name, p.display_name as project_display
      FROM content_blocks cb
      JOIN messages m ON cb.message_id = m.id
      JOIN sessions s ON m.session_id = s.id
      JOIN projects p ON s.project_id = p.id
      WHERE ${where}
      ORDER BY m.timestamp DESC
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    const rows = db.prepare(query).all(...params) as any[];

    // Batch: get the latest user prompt BEFORE each thinking block's message
    // Group by session to reduce queries — one per unique session
    const sessionMessages = new Map<number, { msgId: number; ts: string }[]>();
    for (const row of rows) {
      if (!sessionMessages.has(row.session_id)) sessionMessages.set(row.session_id, []);
      sessionMessages.get(row.session_id)!.push({ msgId: row.message_id, ts: row.timestamp });
    }

    // For each session, get all user text blocks ordered by time (single query per session)
    const promptCache = new Map<number, string>(); // message_id -> preceding prompt
    const userPromptStmt = db.prepare(`
      SELECT m.id, m.timestamp, SUBSTR(cb.text_content, 1, 300) as prompt
      FROM messages m
      JOIN content_blocks cb ON cb.message_id = m.id AND cb.block_type = 'text'
      WHERE m.session_id = ? AND m.type = 'user'
      ORDER BY m.timestamp
    `);

    for (const [sessionId, msgs] of sessionMessages) {
      const userPrompts = userPromptStmt.all(sessionId) as any[];
      for (const msg of msgs) {
        // Find the latest user prompt before this message's timestamp
        let best = '';
        for (const up of userPrompts) {
          if (up.timestamp <= msg.ts) best = up.prompt;
          else break;
        }
        promptCache.set(msg.msgId, best);
      }
    }

    const entries = rows.map(row => ({
      sessionId: row.session_uuid,
      sessionDisplay: row.session_display,
      project: row.project_name,
      projectDisplay: row.project_display,
      timestamp: row.timestamp,
      thinking: row.thinking,
      precedingPrompt: promptCache.get(row.message_id) ?? '',
      model: row.model,
      charCount: row.thinking?.length ?? 0,
    }));

    // Total count — fast path when no filters
    let total: number;
    if (!projectFilter && !dateFrom && !dateTo && !search) {
      total = (db.prepare(
        "SELECT COUNT(*) as total FROM content_blocks WHERE block_type = 'thinking' AND text_content IS NOT NULL AND text_content != ''"
      ).get() as any).total;
    } else {
      const countParams: any[] = [];
      let countWhere = "cb.block_type = 'thinking' AND cb.text_content IS NOT NULL AND cb.text_content != ''";
      if (projectFilter) { countWhere += ' AND p.name = ?'; countParams.push(projectFilter); }
      if (dateFrom) { countWhere += ' AND m.timestamp >= ?'; countParams.push(dateFrom); }
      if (dateTo) { countWhere += ' AND m.timestamp <= ?'; countParams.push(dateTo + 'T23:59:59'); }
      if (search) { countWhere += ' AND cb.text_content LIKE ?'; countParams.push(`%${search}%`); }

      total = (db.prepare(`
        SELECT COUNT(*) as total
        FROM content_blocks cb
        JOIN messages m ON cb.message_id = m.id
        JOIN sessions s ON m.session_id = s.id
        JOIN projects p ON s.project_id = p.id
        WHERE ${countWhere}
      `).get(...countParams) as any).total;
    }

    return NextResponse.json({ entries, total, limit, offset });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Failed to query thinking', detail: err.message },
      { status: 500 }
    );
  }
}
