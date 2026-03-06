import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unfirehose/core/db/schema';
import { execFile } from 'child_process';

/* eslint-disable @typescript-eslint/no-explicit-any */

function execAsync(cmd: string, args: string[], opts: { timeout: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

/**
 * POST /api/boot/finished
 * Called by agent when it's done working. Sends /exit to its tmux window
 * and marks the deployment completed.
 *
 * Body: { tmuxSession, tmuxWindow } or { projectName }
 */
export async function POST(request: NextRequest) {
  try {
    const db = getDb();
    const body = await request.json();
    const { tmuxSession, tmuxWindow, projectName } = body;

    const exited: string[] = [];

    if (tmuxSession) {
      // Find specific deployment by tmux session + window
      const query = tmuxWindow
        ? `SELECT id, tmux_session, tmux_window FROM agent_deployments WHERE status = 'running' AND tmux_session = ? AND tmux_window = ?`
        : `SELECT id, tmux_session, tmux_window FROM agent_deployments WHERE status = 'running' AND tmux_session = ?`;
      const params = tmuxWindow ? [tmuxSession, tmuxWindow] : [tmuxSession];
      const deployments = db.prepare(query).all(...params) as any[];

      for (const d of deployments) {
        db.prepare(
          "UPDATE agent_deployments SET status = 'completed', stopped_at = datetime('now') WHERE id = ?"
        ).run(d.id);

        const target = d.tmux_window ? `${d.tmux_session}:${d.tmux_window}` : d.tmux_session;
        execAsync('tmux', ['send-keys', '-t', target, '/exit', 'Enter'], { timeout: 3000 })
          .catch(() => {});
        exited.push(target);
      }
    } else if (projectName) {
      // Find all running deployments for this project
      const proj = db.prepare('SELECT id FROM projects WHERE name = ?').get(projectName) as any;
      if (!proj) {
        return NextResponse.json({ error: 'Unknown project' }, { status: 404 });
      }

      const deployments = db.prepare(`
        SELECT id, tmux_session, tmux_window
        FROM agent_deployments
        WHERE status = 'running' AND project_id = ?
      `).all(proj.id) as any[];

      for (const d of deployments) {
        db.prepare(
          "UPDATE agent_deployments SET status = 'completed', stopped_at = datetime('now') WHERE id = ?"
        ).run(d.id);

        const target = d.tmux_window ? `${d.tmux_session}:${d.tmux_window}` : d.tmux_session;
        execAsync('tmux', ['send-keys', '-t', target, '/exit', 'Enter'], { timeout: 3000 })
          .catch(() => {});
        exited.push(target);
      }
    } else {
      return NextResponse.json({ error: 'Provide tmuxSession or projectName' }, { status: 400 });
    }

    return NextResponse.json({ ok: true, exited });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
