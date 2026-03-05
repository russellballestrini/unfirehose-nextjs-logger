import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/schema';
import { execSync } from 'child_process';

/* eslint-disable @typescript-eslint/no-explicit-any */

const PUBLIC_FORGES = [
  'github.com',
  'gitlab.com',
  'codeberg.org',
  'sr.ht',
  'bitbucket.org',
  'sourceforge.net',
  'git.sr.ht',
];

/** Check if a project path has git remotes pointing to public forges */
function detectPublicRemotes(projectPath: string | null): { isPublic: boolean; remotes: string[] } {
  if (!projectPath) return { isPublic: false, remotes: [] };

  try {
    const output = execSync('git remote -v', {
      cwd: projectPath,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const remotes = [...new Set(
      output
        .split('\n')
        .filter(line => line.includes('(fetch)'))
        .map(line => line.split(/\s+/)[1])
        .filter(Boolean)
    )];

    const isPublic = remotes.some(url =>
      PUBLIC_FORGES.some(forge => url.includes(forge))
    );

    return { isPublic, remotes };
  } catch {
    return { isPublic: false, remotes: [] };
  }
}

export async function GET() {
  try {
    const db = getDb();

    // Get all projects with their visibility
    const projects = db.prepare(`
      SELECT p.id, p.name, p.display_name, p.path,
             COALESCE(pv.visibility, 'private') as visibility,
             pv.auto_detected,
             COUNT(DISTINCT s.id) as session_count,
             COUNT(m.id) as message_count,
             SUM(m.input_tokens) as total_input,
             SUM(m.output_tokens) as total_output,
             MIN(m.timestamp) as first_activity,
             MAX(m.timestamp) as last_activity
      FROM projects p
      LEFT JOIN project_visibility pv ON pv.project_id = p.id
      LEFT JOIN sessions s ON s.project_id = p.id
      LEFT JOIN messages m ON m.session_id = s.id
      GROUP BY p.id
      ORDER BY p.display_name
    `).all() as any[];

    // Auto-detect public repos by git remotes
    const upsertVis = db.prepare(`
      INSERT INTO project_visibility (project_id, visibility, auto_detected, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(project_id) DO UPDATE SET
        auto_detected = excluded.auto_detected,
        updated_at = excluded.updated_at
      WHERE project_visibility.auto_detected IS NULL
        OR project_visibility.auto_detected != excluded.auto_detected
    `);

    // Only auto-set visibility if user hasn't manually changed it
    const autoSetVis = db.prepare(`
      UPDATE project_visibility
      SET visibility = 'public', updated_at = datetime('now')
      WHERE project_id = ? AND visibility = 'private' AND auto_detected = 'public_remote'
    `);

    for (const p of projects) {
      if (!p.path) continue;
      const { isPublic, remotes } = detectPublicRemotes(p.path);
      if (remotes.length > 0) {
        const detection = isPublic ? 'public_remote' : 'private_remote';
        const remoteStr = remotes.join(', ');
        upsertVis.run(p.id, p.visibility ?? 'private', `${detection}:${remoteStr}`);
        if (isPublic && p.visibility === 'private' && !p.auto_detected) {
          autoSetVis.run(p.id);
          p.visibility = 'public';
          p.auto_detected = `${detection}:${remoteStr}`;
        }
      }
    }

    // Re-query to get updated visibility after auto-detection
    const updatedProjects = db.prepare(`
      SELECT p.id, p.name, p.display_name, p.path,
             COALESCE(pv.visibility, 'private') as visibility,
             pv.auto_detected,
             COUNT(DISTINCT s.id) as session_count,
             COUNT(m.id) as message_count,
             SUM(m.input_tokens) as total_input,
             SUM(m.output_tokens) as total_output,
             MIN(m.timestamp) as first_activity,
             MAX(m.timestamp) as last_activity
      FROM projects p
      LEFT JOIN project_visibility pv ON pv.project_id = p.id
      LEFT JOIN sessions s ON s.project_id = p.id
      LEFT JOIN messages m ON m.session_id = s.id
      GROUP BY p.id
      ORDER BY p.display_name
    `).all() as any[];

    // Model usage summary (no per-message detail)
    const modelSummary = db.prepare(`
      SELECT model, COUNT(*) as messages,
             SUM(input_tokens) as input, SUM(output_tokens) as output
      FROM messages WHERE model IS NOT NULL
      GROUP BY model ORDER BY messages DESC
    `).all() as any[];

    // Tool usage summary (names and counts only)
    const toolSummary = db.prepare(`
      SELECT tool_name, COUNT(*) as count
      FROM content_blocks
      WHERE block_type = 'tool_use' AND tool_name IS NOT NULL
      GROUP BY tool_name ORDER BY count DESC LIMIT 20
    `).all() as any[];

    // What's included vs excluded
    const included = [
      'Project names and display names',
      'Session counts and date ranges',
      'Model usage (which models, message counts)',
      'Token totals per project (input, output)',
      'Tool call frequencies (tool names + counts)',
      'Project visibility status',
    ];

    const excluded = [
      'Prompt text and user messages',
      'Assistant response content',
      'Thinking blocks',
      'Tool call arguments and results',
      'File paths and file contents',
      'Git commit messages and diffs',
      'CLAUDE.md contents',
      'Any PII (already sanitized at ingest)',
    ];

    return NextResponse.json({
      projects: updatedProjects.map((p: any) => ({
        name: p.name,
        displayName: p.display_name,
        visibility: p.visibility,
        autoDetected: p.auto_detected,
        sessionCount: p.session_count ?? 0,
        messageCount: p.message_count ?? 0,
        totalInput: p.total_input ?? 0,
        totalOutput: p.total_output ?? 0,
        firstActivity: p.first_activity,
        lastActivity: p.last_activity,
      })),
      modelSummary,
      toolSummary,
      included,
      excluded,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
