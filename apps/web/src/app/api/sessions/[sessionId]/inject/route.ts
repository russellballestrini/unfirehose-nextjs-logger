import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@sexy-logger/core/db/schema';
import { claudePaths } from '@sexy-logger/core/claude-paths';
import { appendFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST /api/sessions/[sessionId]/inject
 *
 * Inject a TodoWrite tool call into a session's JSONL file.
 * This allows the UI to push tasks into running or completed sessions
 * so they appear as native tool calls when re-ingested.
 *
 * Body: { todos: Array<{ content: string; status?: string }>, project?: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await params;
    const db = getDb();
    const body = await request.json();
    const { todos } = body;

    if (!todos || !Array.isArray(todos) || todos.length === 0) {
      return NextResponse.json({ error: 'todos array required' }, { status: 400 });
    }

    // Find session in DB to get project name
    const session = db.prepare(`
      SELECT s.id, s.session_uuid, p.name as project_name, p.id as project_id
      FROM sessions s
      JOIN projects p ON s.project_id = p.id
      WHERE s.session_uuid = ?
    `).get(sessionId) as any;

    if (!session) {
      return NextResponse.json({ error: 'session not found' }, { status: 404 });
    }

    // Construct JSONL file path
    const filePath = claudePaths.sessionFile(session.project_name, sessionId);
    if (!existsSync(filePath)) {
      return NextResponse.json({ error: 'session file not found on disk' }, { status: 404 });
    }

    // Build a TodoWrite tool_use + tool_result JSONL entry pair
    const toolUseId = `toolu_inject_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const now = new Date().toISOString();

    const todoItems = todos.map((t: any) => ({
      content: t.content?.trim(),
      status: t.status ?? 'pending',
    })).filter((t: any) => t.content);

    if (todoItems.length === 0) {
      return NextResponse.json({ error: 'no valid todos' }, { status: 400 });
    }

    // Assistant message with tool_use block (TodoWrite)
    const assistantEntry = {
      type: 'assistant',
      message: {
        id: `msg_inject_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: toolUseId,
          name: 'TodoWrite',
          input: { todos: todoItems },
        }],
        model: 'injected',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      timestamp: now,
    };

    // Tool result confirming the write
    const resultEntry = {
      type: 'result',
      subtype: 'tool_result',
      tool_use_id: toolUseId,
      content: `Injected ${todoItems.length} todo(s) via session inject API`,
      is_error: false,
      timestamp: now,
    };

    // Append both entries to the JSONL file
    const lines = '\n' + JSON.stringify(assistantEntry) + '\n' + JSON.stringify(resultEntry);
    appendFileSync(filePath, lines, 'utf-8');

    // Also insert directly into todos table for immediate visibility
    const upsert = db.prepare(`
      INSERT INTO todos (project_id, session_id, content, status, source, source_session_uuid, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'manual', ?, ?, ?)
    `);
    const event = db.prepare(
      'INSERT INTO todo_events (todo_id, old_status, new_status, event_at) VALUES (?, NULL, ?, ?)'
    );

    const ids: number[] = [];
    for (const todo of todoItems) {
      const r = upsert.run(session.project_id, session.id, todo.content, todo.status, sessionId, now, now);
      event.run(r.lastInsertRowid, todo.status, now);
      ids.push(Number(r.lastInsertRowid));
    }

    return NextResponse.json({
      ok: true,
      injected: todoItems.length,
      ids,
      file: filePath,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
