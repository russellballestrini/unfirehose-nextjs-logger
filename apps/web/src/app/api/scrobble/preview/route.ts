import { NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Max unchecked projects to re-probe per request to bound response time */
const MAX_RECHECK_BATCH = 5;

/** Parse a remote URL into a forge API check. Returns null if unsupported. */
function parseRemoteForCheck(url: string): { apiUrl: string; webUrl: string } | null {
  // GitHub ssh: git@github.com:owner/repo.git
  let m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (m) return {
    apiUrl: `https://api.github.com/repos/${m[1]}`,
    webUrl: `https://github.com/${m[1]}`,
  };

  // GitLab (git.unturf.com) ssh: ssh://git@git.unturf.com:2222/path/to/repo.git
  m = url.match(/git\.unturf\.com(?::\d+)?\/(.+?)(?:\.git)?$/);
  if (m) {
    const encoded = encodeURIComponent(m[1]);
    return {
      apiUrl: `https://git.unturf.com/api/v4/projects/${encoded}`,
      webUrl: `https://git.unturf.com/${m[1]}`,
    };
  }

  // Codeberg ssh/https
  m = url.match(/codeberg\.org[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (m) return {
    apiUrl: `https://codeberg.org/api/v1/repos/${m[1]}`,
    webUrl: `https://codeberg.org/${m[1]}`,
  };

  return null;
}

/** Check if a project has any truly public remotes by hitting forge APIs (unauthenticated = public) */
async function detectPublicRemotes(projectPath: string | null): Promise<{ isPublic: boolean; remotes: string[]; publicRepo: string | null }> {
  if (!projectPath) return { isPublic: false, remotes: [], publicRepo: null };

  try {
    const { stdout: output } = await execAsync('git remote -v', {
      cwd: projectPath,
      encoding: 'utf-8',
      timeout: 3000,
    });

    const remotes = [...new Set(
      output
        .split('\n')
        .filter(line => line.includes('(fetch)'))
        .map(line => line.split(/\s+/)[1])
        .filter(Boolean)
    )];

    // Build all forge API checks, then run them in parallel
    const checks = remotes
      .map(url => parseRemoteForCheck(url))
      .filter((c): c is NonNullable<typeof c> => c !== null);

    if (checks.length === 0) return { isPublic: false, remotes, publicRepo: null };

    const results = await Promise.allSettled(
      checks.map(async (check) => {
        const { stdout } = await execAsync(
          `curl -s -o /dev/null -w '%{http_code}' --max-time 2 '${check.apiUrl}'`,
          { encoding: 'utf-8', timeout: 3000 }
        );
        return { code: stdout.trim(), webUrl: check.webUrl };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.code === '200') {
        return { isPublic: true, remotes, publicRepo: r.value.webUrl };
      }
    }

    return { isPublic: false, remotes, publicRepo: null };
  } catch {
    return { isPublic: false, remotes: [], publicRepo: null };
  }
}

export async function GET() {
  try {
    const db = getDb();

    // Get all projects with their visibility in one query
    const projects = db.prepare(`
      SELECT p.id, p.name, p.display_name, p.path,
             COALESCE(pv.visibility, 'private') as visibility,
             pv.auto_detected,
             pv.updated_at as vis_updated_at,
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

    // Re-check projects with no auto_detected, or where detection is >24h stale
    // Limit batch size so the request stays fast; remaining projects get checked on subsequent requests.
    const staleThreshold = new Date(Date.now() - 24 * 3600000).toISOString();
    const unchecked = projects
      .filter(p => p.path && (!p.auto_detected || (p.vis_updated_at && p.vis_updated_at < staleThreshold)))
      .slice(0, MAX_RECHECK_BATCH);

    if (unchecked.length > 0) {
      const upsertVis = db.prepare(`
        INSERT INTO project_visibility (project_id, visibility, auto_detected, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(project_id) DO UPDATE SET
          auto_detected = excluded.auto_detected,
          updated_at = excluded.updated_at
        WHERE project_visibility.auto_detected IS NULL
          OR project_visibility.auto_detected != excluded.auto_detected
      `);

      const autoSetVis = db.prepare(`
        UPDATE project_visibility
        SET visibility = 'public', updated_at = datetime('now')
        WHERE project_id = ? AND visibility = 'private' AND auto_detected LIKE 'public_repo:%'
      `);

      // Run all project remote detections in parallel
      const detections = await Promise.all(
        unchecked.map(async (p) => ({
          project: p,
          result: await detectPublicRemotes(p.path),
        }))
      );

      for (const { project: p, result: { isPublic, remotes, publicRepo } } of detections) {
        if (remotes.length > 0) {
          const detection = isPublic ? `public_repo:${publicRepo}` : 'private_remote';
          upsertVis.run(p.id, p.visibility ?? 'private', detection);
          if (isPublic && p.visibility === 'private') {
            autoSetVis.run(p.id);
            p.visibility = 'public';
            p.auto_detected = detection;
          }
        } else {
          // No remotes — mark as checked so we don't re-scan
          upsertVis.run(p.id, p.visibility ?? 'private', 'no_remotes');
          p.auto_detected = 'no_remotes';
        }
      }
    }

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
      projects: projects.map((p: any) => ({
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
      included,
      excluded,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
