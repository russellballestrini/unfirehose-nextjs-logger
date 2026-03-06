import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unfirehose/core/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    const minutes = Math.max(1, parseInt(request.nextUrl.searchParams.get('minutes') ?? '10'));
    // Generate cutoff as ISO string to match DB timestamp format
    const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();

    const sessions = db.prepare(`
      SELECT
        s.id,
        s.session_uuid,
        s.display_name,
        s.first_prompt,
        s.git_branch,
        (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id) as updated_at,
        s.created_at,
        p.name as project_name,
        p.display_name as project_display,
        p.path as project_path,
        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as message_count,
        (SELECT SUM(m.input_tokens + m.output_tokens) FROM messages m WHERE m.session_id = s.id AND m.timestamp >= ?) as recent_tokens,
        (SELECT m.model FROM messages m WHERE m.session_id = s.id AND m.model IS NOT NULL ORDER BY m.timestamp DESC LIMIT 1) as last_model
      FROM sessions s
      JOIN projects p ON s.project_id = p.id
      WHERE (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id) >= ?
        AND (s.status IS NULL OR s.status = 'active')
      ORDER BY updated_at DESC
    `).all(cutoff, cutoff) as any[];

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
