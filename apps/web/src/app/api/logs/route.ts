import { buildWhere, inClause } from '@/lib/sql-filters';
import { summarise } from '@/lib/log-preview';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { isToolCall } from '@unturf/unfirehose/block-types';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Every message type we store. Asking for all of them is asking for no filter. */
const MESSAGE_TYPES = ['user', 'assistant', 'system'] as const;

/**
 * `?sidechain=` — subagent messages only, top-level only, or (by default,
 * and for anything unrecognised) both. A table rather than a chain of
 * comparisons, so an unknown value falls through to "no filter" by having
 * no entry rather than by reaching the end of an else.
 */
const SIDECHAIN_CLAUSES: Record<string, string | undefined> = {
  true: '(m.is_sidechain = 1 OR s.is_sidechain = 1)',
  1: '(m.is_sidechain = 1 OR s.is_sidechain = 1)',
  false: '(m.is_sidechain IS NULL OR m.is_sidechain = 0) AND (s.is_sidechain IS NULL OR s.is_sidechain = 0)',
  0: '(m.is_sidechain IS NULL OR m.is_sidechain = 0) AND (s.is_sidechain IS NULL OR s.is_sidechain = 0)',
};

/**
 * `?has_thinking=true` — messages owning at least one non-empty reasoning
 * block. 'thinking' is the pre-rename spelling; legacy rows are never
 * rewritten, so both are matched forever.
 */
const HAS_REASONING =
  "EXISTS (SELECT 1 FROM content_blocks cb_t WHERE cb_t.message_id = m.id" +
  " AND cb_t.block_type IN ('thinking', 'reasoning')" +
  " AND cb_t.text_content IS NOT NULL AND cb_t.text_content != '')";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const projectFilter = url.searchParams.get('project');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100'), 500);
  const offset = parseInt(url.searchParams.get('offset') ?? '0');
  const typesParam = url.searchParams.get('types');
  const types = typesParam?.split(',') ?? [...MESSAGE_TYPES];
  const search = url.searchParams.get('search')?.trim();
  const dateFrom = url.searchParams.get('from');
  const dateTo = url.searchParams.get('to');
  const session = url.searchParams.get('session');
  // sidechain: 'all' (default), 'true' (subagent messages only), 'false' (top-level only)
  const sidechainParam = (url.searchParams.get('sidechain') ?? 'all').toLowerCase();
  // has_thinking=true filters to messages that contain a reasoning/thinking block.
  const hasThinking = url.searchParams.get('has_thinking') === 'true';

  try {
    const db = getDb();

    // Every filter this route supports, in one list. The clause and the
    // value that fills it sit together, and whether a filter applies is
    // decided by its value — so a filter cannot be added to the clause and
    // forgotten in the parameters, which binds the wrong value to the wrong
    // placeholder and answers plausibly rather than failing.
    const { where, params } = buildWhere('1=1', [
      MESSAGE_TYPES.every((t) => types.includes(t)) ? null : inClause('m.type', types),
      ['p.name = ?', projectFilter],
      ['s.session_uuid = ?', session],
      ['m.timestamp >= ?', dateFrom],
      // A date with no time means the whole of that day.
      ['m.timestamp <= ?', dateTo && `${dateTo}T23:59:59`],
      SIDECHAIN_CLAUSES[sidechainParam],
      search ? ['(cb_search.text_content LIKE ? OR cb_search.tool_input LIKE ?)', `%${search}%`, `%${search}%`] : null,
      hasThinking ? HAS_REASONING : null,
    ]);

    // Searching needs content_blocks in the query at all, which multiplies a
    // message by its blocks — hence the DISTINCT below. Every block type is
    // searched, and a tool call is searched by its input: the row shows the
    // command and the result, so a search for either has to find them. It
    // used to search text and reasoning only, so "src/b.ts" found nothing
    // while a result naming that file sat on the page.
    const searchJoin = search
      ? 'JOIN content_blocks cb_search ON cb_search.message_id = m.id'
      : '';

    const needsDistinct = !!search;
    const query = `
      SELECT ${needsDistinct ? 'DISTINCT' : ''} m.id, m.type, m.subtype, m.timestamp, m.model, m.duration_ms,
             m.input_tokens, m.output_tokens, m.is_sidechain,
             s.session_uuid, s.display_name as session_display, s.is_sidechain as session_is_sidechain,
             p.name as project_name, p.display_name as project_display
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      JOIN projects p ON s.project_id = p.id
      ${searchJoin}
      WHERE ${where}
      ORDER BY m.timestamp DESC
      LIMIT ? OFFSET ?
    `;
    const messages = db.prepare(query).all(...params, limit, offset) as any[];

    if (messages.length === 0) {
      return NextResponse.json({ entries: [], total: 0, limit, offset });
    }

    // Every block that can say something about a message, in one query.
    // Tool results were left out of this for a long time, which is why every
    // USR row that was a tool result showed as blank: 607 of the last 2,000
    // messages' blocks were results the page never saw.
    const msgIds = messages.map(m => m.id);
    const previewRows = db.prepare(`
      SELECT message_id, text_content, block_type, tool_name, tool_input, tool_use_id, is_error
      FROM content_blocks
      WHERE message_id IN (${msgIds.map(() => '?').join(',')})
        AND block_type IN ('text', 'thinking', 'reasoning', 'tool-call', 'tool_use', 'tool-result', 'tool_result')
      ORDER BY message_id, position
    `).all(...msgIds) as any[];

    const previewMap = new Map<number, any[]>();
    for (const row of previewRows) {
      if (!previewMap.has(row.message_id)) previewMap.set(row.message_id, []);
      previewMap.get(row.message_id)!.push(row);
    }

    // A result names its call by tool_use_id; the call is another message.
    // Usually the one just before it, so the batch resolves most; the few at
    // a page boundary are looked up separately rather than left unnamed.
    const toolByUseId = new Map<string, string>();
    const unresolved = new Set<string>();
    for (const row of previewRows) {
      if (isToolCall(row.block_type) && row.tool_use_id && row.tool_name) toolByUseId.set(row.tool_use_id, row.tool_name);
      else if (!isToolCall(row.block_type) && row.tool_use_id && !row.tool_name) unresolved.add(row.tool_use_id);
    }
    const missing = [...unresolved].filter((id) => !toolByUseId.has(id));
    if (missing.length) {
      const rows = db.prepare(`
        SELECT tool_use_id, tool_name FROM content_blocks
        WHERE tool_use_id IN (${missing.map(() => '?').join(',')}) AND tool_name IS NOT NULL
      `).all(...missing) as any[];
      for (const r of rows) toolByUseId.set(r.tool_use_id, r.tool_name);
    }

    const entries = messages.map(msg => {
      const blocks = (previewMap.get(msg.id) ?? []).slice(0, 8);
      const summary = summarise(blocks, {
        type: msg.type, subtype: msg.subtype, durationMs: msg.duration_ms,
        toolNameFor: (id) => toolByUseId.get(id) ?? null,
      });

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
        preview: summary.preview,
        kind: summary.kind,
        tool: summary.tool,
        toolArg: summary.toolArg,
        isError: summary.isError,
        hasReasoning: summary.hasReasoning,
        durationMs: msg.duration_ms ?? null,
        inputTokens: msg.input_tokens,
        outputTokens: msg.output_tokens,
        isSidechain: !!(msg.is_sidechain || msg.session_is_sidechain),
      };
    });

    // Total count for pagination — skip expensive count when not paginating
    let total = 0;
    if (messages.length === limit || offset > 0) {
      // The same clause the rows were selected with. This used to be a
      // second, hand-kept copy: two WHERE clauses that must produce
      // identical results, or the count under the pager describes a
      // different set of messages than the ones on screen.
      const countQuery = `
        SELECT ${needsDistinct ? 'COUNT(DISTINCT m.id)' : 'COUNT(*)'} as total
        FROM messages m
        JOIN sessions s ON m.session_id = s.id
        JOIN projects p ON s.project_id = p.id
        ${searchJoin}
        WHERE ${where}
      `;
      total = (db.prepare(countQuery).get(...params) as { total: number }).total;
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
