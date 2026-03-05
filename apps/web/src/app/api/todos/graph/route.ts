import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unfirehose/core/db/schema';
import { execSync } from 'child_process';

const STATUS_COLORS: Record<string, string> = {
  pending: '#fbbf24',
  in_progress: '#60a5fa',
  completed: '#10b981',
  obsolete: '#71717a',
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function escapeLabel(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function sanitizeClusterId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_');
}

interface TodoRow {
  id: number;
  uuid: string | null;
  external_id: string | null;
  content: string;
  status: string;
  blocked_by: string | null;
  project_name: string;
  project_display: string | null;
}

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

    // Build lookup: id/uuid/external_id → todo
    const byId = new Map<number, TodoRow>();
    const byUuid = new Map<string, TodoRow>();
    const byExtId = new Map<string, TodoRow>();
    for (const row of rows) {
      byId.set(row.id, row);
      if (row.uuid) byUuid.set(row.uuid, row);
      if (row.external_id) byExtId.set(row.external_id, row);
    }

    // Parse edges
    const edges: Array<{ from: number; to: number }> = [];
    for (const row of rows) {
      if (!row.blocked_by) continue;
      let blockers: string[];
      try {
        blockers = JSON.parse(row.blocked_by);
      } catch {
        continue;
      }
      if (!Array.isArray(blockers)) continue;

      for (const ref of blockers) {
        // Try to resolve reference: could be uuid, external_id, or numeric id
        const refStr = String(ref).replace(/^todo:/, '');
        const blocker = byUuid.get(refStr) ?? byExtId.get(refStr) ?? byId.get(Number(refStr));
        if (blocker) {
          edges.push({ from: blocker.id, to: row.id });
        }
      }
    }

    // Group by project
    const byProject = new Map<string, { display: string; todos: TodoRow[] }>();
    for (const row of rows) {
      const proj = row.project_name;
      if (!byProject.has(proj)) byProject.set(proj, { display: row.project_display || proj, todos: [] });
      byProject.get(proj)!.todos.push(row);
    }

    // Build DOT
    const lines: string[] = [
      'digraph todos {',
      `  rankdir=${layout};`,
      '  bgcolor="transparent";',
      '  node [shape=box, style="filled,rounded", fontname="monospace", fontsize=10, margin="0.2,0.1"];',
      '  edge [color="#71717a"];',
      '',
    ];

    for (const [proj, group] of byProject) {
      const clusterId = sanitizeClusterId(proj);
      lines.push(`  subgraph cluster_${clusterId} {`);
      lines.push(`    label="${escapeLabel(group.display)}";`);
      lines.push('    color="#3f3f46";');
      lines.push('    fontcolor="#a1a1aa";');
      lines.push('    style=dashed;');
      lines.push('');

      // Collect node IDs that have no edges (isolated) for chaining
      const clusterNodeIds: number[] = [];
      for (const todo of group.todos) {
        const color = STATUS_COLORS[todo.status] || '#71717a';
        const content = truncate(todo.content.replace(/\n/g, ' '), 40);
        const nodeLabel = `${escapeLabel(content)}\\n[${todo.status}]`;
        lines.push(`    "t_${todo.id}" [label="${nodeLabel}" fillcolor="${color}" fontcolor="#000"];`);
        clusterNodeIds.push(todo.id);
      }

      // Chain isolated nodes with invisible edges to enforce ordering
      if (clusterNodeIds.length > 1) {
        const chain = clusterNodeIds.map(id => `"t_${id}"`).join(' -> ');
        lines.push(`    ${chain} [style=invis];`);
      }

      lines.push('  }');
      lines.push('');
    }

    for (const edge of edges) {
      lines.push(`  "t_${edge.from}" -> "t_${edge.to}";`);
    }

    lines.push('}');
    const dot = lines.join('\n');

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
