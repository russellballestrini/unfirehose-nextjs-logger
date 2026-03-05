import { NextResponse } from 'next/server';
import { getDb } from '@unfirehose/core/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function GET() {
  try {
    const db = getDb();

    // Sessions with activity in the last 10 minutes
    const sessions = db.prepare(`
      SELECT
        s.id,
        s.session_uuid,
        s.display_name,
        s.first_prompt,
        s.git_branch,
        s.updated_at,
        s.created_at,
        p.name as project_name,
        p.display_name as project_display,
        p.path as project_path,
        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as message_count,
        (SELECT SUM(m.input_tokens + m.output_tokens) FROM messages m WHERE m.session_id = s.id AND m.timestamp >= datetime('now', '-10 minutes')) as recent_tokens,
        (SELECT m.model FROM messages m WHERE m.session_id = s.id AND m.model IS NOT NULL ORDER BY m.timestamp DESC LIMIT 1) as last_model
      FROM sessions s
      JOIN projects p ON s.project_id = p.id
      WHERE s.updated_at >= datetime('now', '-10 minutes')
        AND (s.status IS NULL OR s.status = 'active')
      ORDER BY s.updated_at DESC
    `).all() as any[];

    return NextResponse.json({
      sessions: sessions.map(s => ({
        id: s.id,
        sessionUuid: s.session_uuid,
        displayName: s.display_name ?? s.first_prompt ?? s.session_uuid?.slice(0, 8),
        gitBranch: s.git_branch,
        updatedAt: s.updated_at,
        createdAt: s.created_at,
        projectName: s.project_name,
        projectDisplay: s.project_display,
        projectPath: s.project_path,
        messageCount: s.message_count ?? 0,
        recentTokens: s.recent_tokens ?? 0,
        lastModel: s.last_model,
      })),
      count: sessions.length,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
