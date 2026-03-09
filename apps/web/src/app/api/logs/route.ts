import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const projectFilter = url.searchParams.get('project');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100'), 500);
  const offset = parseInt(url.searchParams.get('offset') ?? '0');
  const typesParam = url.searchParams.get('types');
  const types = typesParam?.split(',') ?? ['user', 'assistant', 'system'];
  const search = url.searchParams.get('search')?.trim();
  const dateFrom = url.searchParams.get('from');
  const dateTo = url.searchParams.get('to');
  const session = url.searchParams.get('session');

  try {
    const db = getDb();
    const params: any[] = [];

    const allTypes = types.length === 3 && types.includes('user') && types.includes('assistant') && types.includes('system');
    let where = allTypes ? '1=1' : `m.type IN (${types.map(() => '?').join(',')})`;
    if (!allTypes) params.push(...types);

    if (projectFilter) {
      where += ' AND p.name = ?';
      params.push(projectFilter);
    }
    if (session) {
      where += ' AND s.session_uuid = ?';
      params.push(session);
    }
    if (dateFrom) {
      where += ' AND m.timestamp >= ?';
      params.push(dateFrom);
    }
    if (dateTo) {
      where += ' AND m.timestamp <= ?';
      params.push(dateTo + 'T23:59:59');
    }

    // When searching, join content_blocks to filter by text
    const searchJoin = search
      ? "JOIN content_blocks cb_search ON cb_search.message_id = m.id AND cb_search.block_type IN ('text', 'thinking')"
      : '';
    if (search) {
      where += ' AND cb_search.text_content LIKE ?';
      params.push(`%${search}%`);
    }

    const needsDistinct = !!search;
    const query = `
      SELECT ${needsDistinct ? 'DISTINCT' : ''} m.id, m.type, m.subtype, m.timestamp, m.model,
             m.input_tokens, m.output_tokens,
             s.session_uuid, s.display_name as session_display,
             p.name as project_name, p.display_name as project_display
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      JOIN projects p ON s.project_id = p.id
      ${searchJoin}
      WHERE ${where}
      ORDER BY m.timestamp DESC
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    const messages = db.prepare(query).all(...params) as any[];

    if (messages.length === 0) {
      return NextResponse.json({ entries: [], total: 0, limit, offset });
    }

    // Batch fetch previews for all messages in one query
    const msgIds = messages.map(m => m.id);
    const previewRows = db.prepare(`
      SELECT message_id, text_content, block_type, tool_name
      FROM content_blocks
      WHERE message_id IN (${msgIds.map(() => '?').join(',')})
        AND block_type IN ('text', 'thinking', 'tool_use')
      ORDER BY message_id, position
    `).all(...msgIds) as any[];

    // Group previews by message_id
    const previewMap = new Map<number, any[]>();
    for (const row of previewRows) {
      if (!previewMap.has(row.message_id)) previewMap.set(row.message_id, []);
      previewMap.get(row.message_id)!.push(row);
    }

    const entries = messages.map(msg => {
      const blocks = (previewMap.get(msg.id) ?? []).slice(0, 5);
      let preview = '';
      for (const b of blocks) {
        if (b.block_type === 'text' && b.text_content) {
          preview += (preview ? ' ' : '') + b.text_content;
        } else if (b.block_type === 'thinking' && b.text_content) {
          preview += (preview ? ' ' : '') + '[thinking] ' + b.text_content.slice(0, 200);
        } else if (b.block_type === 'tool_use' && b.tool_name) {
          preview += (preview ? ' ' : '') + `[${b.tool_name}]`;
        }
      }

      return {
        id: msg.id,
        type: msg.type,
        subtype: msg.subtype,
        timestamp: msg.timestamp,
        model: msg.model,
        sessionUuid: msg.session_uuid,
        sessionDisplay: msg.session_display,
        projectName: msg.project_name,
        projectDisplay: msg.project_display,
        preview: preview.slice(0, 500),
        inputTokens: msg.input_tokens,
        outputTokens: msg.output_tokens,
      };
    });

    // Total count for pagination — skip expensive count when not paginating
    let total = 0;
    if (messages.length === limit || offset > 0) {
      const countParams: any[] = [];
      let countWhere = allTypes ? '1=1' : `m.type IN (${types.map(() => '?').join(',')})`;
      if (!allTypes) countParams.push(...types);
      if (projectFilter) { countWhere += ' AND p.name = ?'; countParams.push(projectFilter); }
      if (session) { countWhere += ' AND s.session_uuid = ?'; countParams.push(session); }
      if (dateFrom) { countWhere += ' AND m.timestamp >= ?'; countParams.push(dateFrom); }
      if (dateTo) { countWhere += ' AND m.timestamp <= ?'; countParams.push(dateTo + 'T23:59:59'); }
      if (search) { countWhere += ' AND cb_search.text_content LIKE ?'; countParams.push(`%${search}%`); }

      const countQuery = `
        SELECT ${needsDistinct ? 'COUNT(DISTINCT m.id)' : 'COUNT(*)'} as total
        FROM messages m
        JOIN sessions s ON m.session_id = s.id
        JOIN projects p ON s.project_id = p.id
        ${searchJoin}
        WHERE ${countWhere}
      `;
      total = (db.prepare(countQuery).get(...countParams) as { total: number }).total;
    } else {
      total = offset + messages.length;
    }

    return NextResponse.json({ entries, total, limit, offset });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Failed to query logs', detail: err.message },
      { status: 500 }
    );
  }
}
