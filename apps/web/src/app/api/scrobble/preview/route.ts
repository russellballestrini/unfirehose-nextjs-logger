import { parseRemoteForCheck } from '@/lib/forges';
import { NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { readProjectList } from '@unturf/unfirehose/projects-list';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/* eslint-disable @typescript-eslint/no-explicit-any */

let previewCache: { data: any; ts: number } | null = null;
const PREVIEW_CACHE_TTL = 300_000; // 5 minutes

/** Max unchecked projects to re-probe per request to bound response time */
const MAX_RECHECK_BATCH = 7;

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
  if (previewCache && Date.now() - previewCache.ts < PREVIEW_CACHE_TTL) {
    return NextResponse.json(previewCache.data);
  }

  try {
    const db = getDb();

    // The folded project list our worker already keeps — about a hundred
    // real projects. This used to run a GROUP BY across every row in
    // `projects` joined through sessions to messages: 9,455 rows out, most
    // of them agent scratch directories, serialised to 4.3MB and rendered
    // one by one into the DOM. The Projects page had solved this months
    // ago; the preview was the last caller still doing it the long way.
    const folded = readProjectList()?.payload ?? [];
    const names = folded.map((p) => p.name);
    const visByName = new Map<string, { id: number; path: string | null; visibility: string; auto_detected: string | null; vis_updated_at: string | null }>();
    if (names.length) {
      const rows = db.prepare(`
        SELECT p.id, p.name, p.path,
               COALESCE(pv.visibility, 'private') AS visibility,
               pv.auto_detected, pv.updated_at AS vis_updated_at
        FROM projects p
        LEFT JOIN project_visibility pv ON pv.project_id = p.id
        WHERE p.name IN (${names.map(() => '?').join(',')})
      `).all(...names) as any[];
      for (const r of rows) visByName.set(r.name, r);
    }
    const projects = folded.map((f) => {
      const v = visByName.get(f.name);
      return {
        id: v?.id ?? null,
        name: f.name,
        display_name: f.displayName,
        path: v?.path ?? f.path ?? null,
        visibility: v?.visibility ?? 'private',
        auto_detected: v?.auto_detected ?? null,
        vis_updated_at: v?.vis_updated_at ?? null,
        session_count: f.sessionCount,
        message_count: f.totalMessages,
        total_input: f.tokens?.input ?? 0,
        total_output: f.tokens?.output ?? 0,
      };
    });

    // Re-check projects with no auto_detected, or where detection is >24h stale
    // Limit batch size so the request stays fast; remaining projects get checked on subsequent requests.
    const staleThreshold = new Date(Date.now() - 24 * 3600000).toISOString();
    const unchecked = projects
      .filter(p => p.id != null && p.path && (!p.auto_detected || (p.vis_updated_at && p.vis_updated_at < staleThreshold)))
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

    const result = {
      projects: projects.map((p: any) => ({
        name: p.name,
        displayName: p.display_name,
        visibility: p.visibility,
        autoDetected: p.auto_detected,
        sessionCount: p.session_count ?? 0,
        messageCount: p.message_count ?? 0,
        totalInput: p.total_input ?? 0,
        totalOutput: p.total_output ?? 0,
      })),
      included,
      excluded,
    };

    previewCache = { data: result, ts: Date.now() };

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
