import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unfirehose/core/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-4-6':            { input: 5,  output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-5-20251101':   { input: 5,  output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-sonnet-4-5-20250929': { input: 3,  output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-6':          { input: 3,  output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-haiku-4-5-20251001':  { input: 1,   output: 5,  cacheRead: 0.10, cacheWrite: 1.25 },
};

function calcCost(model: string, input: number, output: number, cacheRead: number, cacheWrite: number): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (input / 1e6) * p.input + (output / 1e6) * p.output + (cacheRead / 1e6) * p.cacheRead + (cacheWrite / 1e6) * p.cacheWrite;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ project: string }> }
) {
  const { project: projectEncoded } = await params;
  const projectName = decodeURIComponent(projectEncoded);

  try {
    const db = getDb();

    const proj = db.prepare('SELECT * FROM projects WHERE name = ?').get(projectName) as any;
    if (!proj) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Stats
    const stats = db.prepare(`
      SELECT
        COUNT(DISTINCT s.id) as session_count,
        COUNT(m.id) as message_count,
        SUM(m.input_tokens) as total_input,
        SUM(m.output_tokens) as total_output,
        SUM(m.cache_read_tokens) as total_cache_read,
        SUM(m.cache_creation_tokens) as total_cache_write,
        MIN(m.timestamp) as first_activity,
        MAX(m.timestamp) as last_activity,
        COUNT(DISTINCT DATE(m.timestamp)) as active_days
      FROM sessions s
      JOIN messages m ON m.session_id = s.id
      WHERE s.project_id = ?
    `).get(proj.id) as any;

    // Cost by model
    const modelBreakdown = db.prepare(`
      SELECT model, SUM(input_tokens) as input, SUM(output_tokens) as output,
             SUM(cache_read_tokens) as cache_read, SUM(cache_creation_tokens) as cache_write,
             COUNT(*) as messages
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE s.project_id = ? AND m.model IS NOT NULL
      GROUP BY model ORDER BY output DESC
    `).all(proj.id) as any[];

    let totalCost = 0;
    for (const m of modelBreakdown) {
      m.cost = calcCost(m.model, m.input, m.output, m.cache_read, m.cache_write);
      totalCost += m.cost;
    }

    // Contributors (from recent commits — extracted from git log via metadata)
    // We store commit author in content_blocks from tool results; use a simpler approach:
    // count distinct models used as a proxy, and list top user prompts
    const topModels = modelBreakdown.slice(0, 5).map((m: any) => ({
      model: m.model,
      messages: m.messages,
      cost: m.cost,
    }));

    // Open todos
    const todos = db.prepare(`
      SELECT t.*, s.session_uuid, s.display_name as session_display
      FROM todos t
      LEFT JOIN sessions s ON t.session_id = s.id
      WHERE t.project_id = ? AND t.status IN ('pending', 'in_progress')
      ORDER BY t.updated_at DESC LIMIT 20
    `).all(proj.id) as any[];

    // Recent prompts (last 10 user messages that aren't system/synthetic)
    const prompts = db.prepare(`
      SELECT m.timestamp, cb.text_content, s.session_uuid, s.display_name as session_display, m.model
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      JOIN content_blocks cb ON cb.message_id = m.id AND cb.block_type = 'text'
      WHERE s.project_id = ? AND m.type = 'user'
        AND cb.text_content NOT LIKE '%[Request interrupted%'
        AND cb.text_content NOT LIKE '%<system%'
        AND cb.text_content NOT LIKE '%{"type"%'
        AND length(cb.text_content) > 10
      ORDER BY m.timestamp DESC LIMIT 10
    `).all(proj.id) as any[];

    // Tool usage summary
    const toolUsage = db.prepare(`
      SELECT cb.tool_name, COUNT(*) as count
      FROM content_blocks cb
      JOIN messages m ON cb.message_id = m.id
      JOIN sessions s ON m.session_id = s.id
      WHERE s.project_id = ? AND cb.block_type = 'tool_use' AND cb.tool_name IS NOT NULL
      GROUP BY cb.tool_name ORDER BY count DESC LIMIT 10
    `).all(proj.id) as any[];

    // Visibility
    const vis = db.prepare('SELECT visibility, auto_detected FROM project_visibility WHERE project_id = ?').get(proj.id) as any;

    return NextResponse.json({
      visibility: vis?.visibility ?? 'private',
      project: {
        name: proj.name,
        displayName: proj.display_name,
        path: proj.path,
        firstSeen: proj.first_seen,
      },
      stats: {
        sessionCount: stats.session_count ?? 0,
        messageCount: stats.message_count ?? 0,
        totalInput: stats.total_input ?? 0,
        totalOutput: stats.total_output ?? 0,
        totalCacheRead: stats.total_cache_read ?? 0,
        totalCacheWrite: stats.total_cache_write ?? 0,
        totalCost,
        firstActivity: stats.first_activity,
        lastActivity: stats.last_activity,
        activeDays: stats.active_days ?? 0,
      },
      models: topModels,
      todos: todos.map((t: any) => ({
        id: t.id,
        content: t.content,
        status: t.status,
        activeForm: t.active_form,
        source: t.source,
        sessionUuid: t.session_uuid,
        sessionDisplay: t.session_display,
        updatedAt: t.updated_at,
      })),
      prompts: prompts.map((p: any) => ({
        text: p.text_content?.slice(0, 200),
        timestamp: p.timestamp,
        sessionUuid: p.session_uuid,
        sessionDisplay: p.session_display,
        model: p.model,
      })),
      toolUsage,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
