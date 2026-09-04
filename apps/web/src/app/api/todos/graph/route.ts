import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { execSync } from 'child_process';
import { resolveEdges, buildDot, type TodoRow } from '@/lib/todo-graph';

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const projectFilter = url.searchParams.get('project');
    const statusFilter = url.searchParams.get('status');
    const layout = url.searchParams.get('layout') === 'LR' ? 'LR' : 'TB';

    const db = getDb();

    let where = 'WHERE 1=1';
    const params: string[] = [];

    if (projectFilter) {
      where += ' AND p.name = ?';
      params.push(projectFilter);
    }
    if (statusFilter) {
      const statuses = statusFilter.split(',').map(s => s.trim());
      where += ` AND t.status IN (${statuses.map(() => '?').join(',')})`;
      params.push(...statuses);
    }

    const rows = db.prepare(`
      SELECT t.id, t.uuid, t.external_id, t.content, t.status, t.blocked_by, p.name as project_name, p.display_name as project_display
      FROM todos t
      JOIN projects p ON t.project_id = p.id
      ${where}
      ORDER BY t.id
    `).all(...params) as TodoRow[];

    if (rows.length === 0) {
      const emptySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">
        <text x="200" y="50" text-anchor="middle" fill="#71717a" font-family="monospace" font-size="14">No todos found</text>
      </svg>`;
      return NextResponse.json({ svg: emptySvg, nodeCount: 0, edgeCount: 0, dot: '' });
    }

    const edges = resolveEdges(rows);
    const dot = buildDot(rows, edges, layout);

    // Render SVG via graphviz
    let svg: string;
    try {
      svg = execSync('dot -Tsvg', {
        input: dot,
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (e) {
      return NextResponse.json(
        { error: 'Graphviz rendering failed', detail: String(e), dot },
        { status: 500 }
      );
    }

    return NextResponse.json({
      svg,
      nodeCount: rows.length,
      edgeCount: edges.length,
      dot,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Graph generation failed', detail: String(err) },
      { status: 500 }
    );
  }
}
