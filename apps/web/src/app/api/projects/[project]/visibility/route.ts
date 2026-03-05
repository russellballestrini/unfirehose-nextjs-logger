import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@sexy-logger/core/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ project: string }> }
) {
  const { project } = await params;
  const projectName = decodeURIComponent(project);

  try {
    const db = getDb();
    const proj = db.prepare('SELECT id FROM projects WHERE name = ?').get(projectName) as any;
    if (!proj) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    const vis = db.prepare('SELECT * FROM project_visibility WHERE project_id = ?').get(proj.id) as any;

    return NextResponse.json({
      projectId: proj.id,
      visibility: vis?.visibility ?? 'private',
      autoDetected: vis?.auto_detected ?? null,
      updatedAt: vis?.updated_at ?? null,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ project: string }> }
) {
  const { project } = await params;
  const projectName = decodeURIComponent(project);
  const body = await request.json();
  const visibility = body.visibility;

  if (!['public', 'unlisted', 'private'].includes(visibility)) {
    return NextResponse.json({ error: 'Invalid visibility' }, { status: 400 });
  }

  try {
    const db = getDb();
    const proj = db.prepare('SELECT id FROM projects WHERE name = ?').get(projectName) as any;
    if (!proj) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    db.prepare(`
      INSERT INTO project_visibility (project_id, visibility, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(project_id) DO UPDATE SET
        visibility = excluded.visibility,
        updated_at = excluded.updated_at
    `).run(proj.id, visibility);

    return NextResponse.json({ success: true, visibility });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
