import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { execSync } from 'child_process';

/* eslint-disable @typescript-eslint/no-explicit-any */

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Session Constellation: projects as clusters, sessions as nodes,
 * sized by message count, colored by model, delegation edges.
 */
function buildSessionGraph(db: ReturnType<typeof getDb>, project?: string, layout = 'TB'): { dot: string; nodes: number; edges: number } {
  let where = '';
  const params: any[] = [];
  if (project) {
    where = 'AND p.name = ?';
    params.push(project);
  }

  const sessions = db.prepare(`
    SELECT s.id, s.session_uuid, s.display_name, s.is_sidechain, s.delegated_from,
           p.name as project_name, p.display_name as project_display,
           COUNT(m.id) as msg_count,
           SUM(m.input_tokens + m.output_tokens) as total_tokens,
           MAX(m.model) as model
    FROM sessions s
    JOIN projects p ON s.project_id = p.id
    LEFT JOIN messages m ON m.session_id = s.id
    WHERE 1=1 ${where}
    GROUP BY s.id
    HAVING msg_count > 0
    ORDER BY total_tokens DESC
    LIMIT 200
  `).all(...params) as any[];

  // Find Agent tool calls that spawned sessions (heuristic: Agent tool_use → session start within 30s)
  const agentEdges = db.prepare(`
    SELECT DISTINCT s1.session_uuid as parent, s2.session_uuid as child
    FROM content_blocks cb
    JOIN messages m ON cb.message_id = m.id
    JOIN sessions s1 ON m.session_id = s1.id
    JOIN sessions s2 ON s2.project_id = s1.project_id
      AND s2.session_uuid != s1.session_uuid
      AND s2.created_at BETWEEN datetime(m.timestamp, '-10 seconds') AND datetime(m.timestamp, '+60 seconds')
    WHERE cb.block_type = 'tool_use' AND cb.tool_name = 'Agent'
    LIMIT 500
  `).all() as any[];

  // Also include explicit delegated_from links
  const delegationEdges = db.prepare(`
    SELECT delegated_from as parent, session_uuid as child
    FROM sessions WHERE delegated_from IS NOT NULL
  `).all() as any[];

  const sessionSet = new Set(sessions.map((s: any) => s.session_uuid));
  const allEdges = [...agentEdges, ...delegationEdges]
    .filter((e: any) => sessionSet.has(e.parent) && sessionSet.has(e.child));

  // Dedup edges
  const edgeSet = new Set(allEdges.map((e: any) => `${e.parent}→${e.child}`));
  const edges = [...edgeSet].map(k => {
    const [parent, child] = k.split('→');
    return { parent, child };
  });

  // Group by project
  const byProject = new Map<string, { display: string; sessions: any[] }>();
  for (const s of sessions) {
    if (!byProject.has(s.project_name)) {
      byProject.set(s.project_name, { display: s.project_display, sessions: [] });
    }
    byProject.get(s.project_name)!.sessions.push(s);
  }

  const maxTokens = Math.max(...sessions.map((s: any) => s.total_tokens || 1));

  const modelColors: Record<string, string> = {
    'claude-opus-4-7':            '#f0abfc',
    'claude-opus-4-6':            '#e879f9',
    'claude-opus-4-5-20251101':   '#a78bfa',
    'claude-sonnet-4-6':          '#60a5fa',
    'claude-sonnet-4-5-20250514': '#38bdf8',
    'claude-haiku-4-5-20251001':  '#34d399',
    'hermes-3-8b':                '#fb923c',
  };

  const lines: string[] = [
    'digraph sessions {',
    `  rankdir=${layout};`,
    '  bgcolor="transparent";',
    '  node [shape=ellipse, style=filled, fontname="monospace", fontsize=9, margin="0.15,0.08"];',
    '  edge [color="#71717a88", arrowsize=0.6, penwidth=1.2];',
    '  overlap=prism;',
    '  splines=curved;',
    '',
  ];

  for (const [proj, group] of byProject) {
    const cid = sanitize(proj);
    lines.push(`  subgraph cluster_${cid} {`);
    lines.push(`    label="${esc(group.display)}";`);
    lines.push('    color="#3f3f4688";');
    lines.push('    fontcolor="#a1a1aa";');
    lines.push('    fontsize=11;');
    lines.push('    style="rounded,dashed";');
    lines.push('    penwidth=1;');
    lines.push('');

    for (const s of group.sessions) {
      const size = 0.3 + (Math.sqrt(s.total_tokens || 0) / Math.sqrt(maxTokens)) * 0.8;
      const model = s.model || '';
      const color = Object.entries(modelColors).find(([k]) => model.includes(k))?.[1] ?? '#71717a';
      const name = s.display_name || s.session_uuid.slice(0, 8);
      const label = esc(name.length > 30 ? name.slice(0, 29) + '…' : name);
      const sidechain = s.is_sidechain ? ', peripheries=2' : '';
      lines.push(`    "s_${s.session_uuid}" [label="${label}\\n${(s.msg_count || 0)} msgs", width=${size.toFixed(2)}, height=${(size * 0.6).toFixed(2)}, fillcolor="${color}90", fontcolor="#e4e4e7"${sidechain}];`);
    }

    lines.push('  }');
    lines.push('');
  }

  for (const edge of edges) {
    lines.push(`  "s_${edge.parent}" -> "s_${edge.child}" [style=bold, color="#f472b6aa"];`);
  }

  lines.push('}');

  return { dot: lines.join('\n'), nodes: sessions.length, edges: edges.length };
}

/**
 * Tool Flow: directed graph of tool-to-tool transitions within sessions.
 * Edge weight = how often tool B follows tool A in the same turn.
 */
function buildToolGraph(db: ReturnType<typeof getDb>, layout = 'LR'): { dot: string; nodes: number; edges: number } {
  // Get sequential tool uses per session
  const toolSeqs = db.prepare(`
    SELECT cb.tool_name, m.session_id, m.id as msg_id, cb.position
    FROM content_blocks cb
    JOIN messages m ON cb.message_id = m.id
    WHERE cb.block_type = 'tool_use' AND cb.tool_name IS NOT NULL
    ORDER BY m.session_id, m.timestamp, cb.position
  `).all() as any[];

  // Count transitions
  const transitions = new Map<string, number>();
  const toolCounts = new Map<string, number>();
  let prevTool: string | null = null;
  let prevSession: number | null = null;

  for (const row of toolSeqs) {
    const tool = row.tool_name;
    toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);

    if (prevSession === row.session_id && prevTool && prevTool !== tool) {
      const key = `${prevTool}→${tool}`;
      transitions.set(key, (transitions.get(key) || 0) + 1);
    }
    prevTool = tool;
    prevSession = row.session_id;
  }

  // Filter to significant transitions (> 10 occurrences)
  const significantEdges = [...transitions.entries()]
    .filter(([, count]) => count > 10)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 80);

  // Collect tools that appear in edges
  const activeTtools = new Set<string>();
  for (const [key] of significantEdges) {
    const [from, to] = key.split('→');
    activeTtools.add(from);
    activeTtools.add(to);
  }

  const maxCount = Math.max(...[...toolCounts.values()]);
  const maxEdge = significantEdges.length > 0 ? significantEdges[0][1] : 1;

  const toolColors: Record<string, string> = {
    Bash: '#f97316',
    Read: '#60a5fa',
    Edit: '#a78bfa',
    Write: '#e879f9',
    Grep: '#34d399',
    Glob: '#2dd4bf',
    Agent: '#f472b6',
    WebFetch: '#fbbf24',
    WebSearch: '#fb923c',
    TaskCreate: '#818cf8',
    TaskUpdate: '#6366f1',
    TodoWrite: '#8b5cf6',
  };

  const lines: string[] = [
    'digraph tools {',
    `  rankdir=${layout};`,
    '  bgcolor="transparent";',
    '  node [shape=box, style="filled,rounded", fontname="monospace", fontsize=11, margin="0.2,0.1"];',
    '  edge [fontname="monospace", fontsize=8, fontcolor="#a1a1aa"];',
    '  concentrate=true;',
    '',
  ];

  for (const tool of activeTtools) {
    const count = toolCounts.get(tool) || 0;
    const size = 0.4 + (Math.sqrt(count) / Math.sqrt(maxCount)) * 1.2;
    const color = toolColors[tool] ?? '#71717a';
    lines.push(`  "${tool}" [label="${tool}\\n${count.toLocaleString()}", width=${size.toFixed(2)}, fillcolor="${color}40", fontcolor="#e4e4e7", color="${color}"];`);
  }
  lines.push('');

  for (const [key, count] of significantEdges) {
    const [from, to] = key.split('→');
    const penwidth = 0.5 + (count / maxEdge) * 4;
    const alpha = Math.round(40 + (count / maxEdge) * 180).toString(16).padStart(2, '0');
    lines.push(`  "${from}" -> "${to}" [penwidth=${penwidth.toFixed(1)}, color="#e4e4e7${alpha}", label="${count}"];`);
  }

  lines.push('}');

  return { dot: lines.join('\n'), nodes: activeTtools.size, edges: significantEdges.length };
}

/**
 * Project Galaxy: projects as nodes, sized by cost, connected by
 * tool usage similarity (cosine similarity of tool vectors).
 */
function buildProjectGraph(db: ReturnType<typeof getDb>, layout = 'TB'): { dot: string; nodes: number; edges: number } {
  const projects = db.prepare(`
    SELECT p.id, p.name, p.display_name,
           COUNT(DISTINCT s.id) as session_count,
           SUM(m.input_tokens + m.output_tokens) as total_tokens,
           COUNT(m.id) as msg_count
    FROM projects p
    JOIN sessions s ON s.project_id = p.id
    JOIN messages m ON m.session_id = s.id
    GROUP BY p.id
    HAVING msg_count > 5
    ORDER BY total_tokens DESC
    LIMIT 40
  `).all() as any[];

  // Get tool vectors per project
  const toolVectors = new Map<number, Map<string, number>>();
  for (const proj of projects) {
    const tools = db.prepare(`
      SELECT cb.tool_name, COUNT(*) as cnt
      FROM content_blocks cb
      JOIN messages m ON cb.message_id = m.id
      JOIN sessions s ON m.session_id = s.id
      WHERE s.project_id = ? AND cb.block_type = 'tool_use' AND cb.tool_name IS NOT NULL
      GROUP BY cb.tool_name
    `).all(proj.id) as any[];
    const vec = new Map<string, number>();
    for (const t of tools) vec.set(t.tool_name, t.cnt);
    toolVectors.set(proj.id, vec);
  }

  // Compute cosine similarity between projects
  const edges: { from: number; to: number; sim: number }[] = [];
  for (let i = 0; i < projects.length; i++) {
    for (let j = i + 1; j < projects.length; j++) {
      const v1 = toolVectors.get(projects[i].id)!;
      const v2 = toolVectors.get(projects[j].id)!;
      const allTools = new Set([...v1.keys(), ...v2.keys()]);
      let dot = 0, mag1 = 0, mag2 = 0;
      for (const t of allTools) {
        const a = v1.get(t) || 0;
        const b = v2.get(t) || 0;
        dot += a * b;
        mag1 += a * a;
        mag2 += b * b;
      }
      const sim = mag1 && mag2 ? dot / (Math.sqrt(mag1) * Math.sqrt(mag2)) : 0;
      if (sim > 0.97) {
        edges.push({ from: projects[i].id, to: projects[j].id, sim });
      }
    }
  }

  const maxTokens = Math.max(...projects.map((p: any) => p.total_tokens || 1));

  // Color gradient based on session count
  const maxSessions = Math.max(...projects.map((p: any) => p.session_count));

  const lines: string[] = [
    'digraph projects {',
    `  rankdir=${layout};`,
    '  bgcolor="transparent";',
    '  node [shape=circle, style=filled, fontname="monospace", fontsize=9];',
    '  edge [dir=none, color="#71717a44", style=dashed];',
    '  overlap=prism;',
    '  splines=curved;',
    '',
  ];

  for (const p of projects) {
    const size = 0.4 + (Math.sqrt(p.total_tokens) / Math.sqrt(maxTokens)) * 1.5;
    const heat = p.session_count / maxSessions;
    // Interpolate from cool blue to hot orange
    const r = Math.round(96 + heat * 152);
    const g = Math.round(165 - heat * 100);
    const b = Math.round(250 - heat * 180);
    const color = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    const name = p.display_name || p.name;
    const label = name.length > 20 ? name.slice(0, 19) + '…' : name;
    lines.push(`  "p_${p.id}" [label="${esc(label)}\\n${p.session_count} sess", width=${size.toFixed(2)}, height=${size.toFixed(2)}, fillcolor="${color}80", fontcolor="#e4e4e7"];`);
  }
  lines.push('');

  for (const edge of edges) {
    const penwidth = 0.5 + edge.sim * 3;
    lines.push(`  "p_${edge.from}" -> "p_${edge.to}" [penwidth=${penwidth.toFixed(1)}];`);
  }

  lines.push('}');

  return { dot: lines.join('\n'), nodes: projects.length, edges: edges.length };
}

/**
 * Activity Timeline: sessions plotted on a timeline with vertical lanes per project.
 */
function buildTimelineGraph(db: ReturnType<typeof getDb>, layout = 'LR'): { dot: string; nodes: number; edges: number } {
  const sessions = db.prepare(`
    SELECT s.session_uuid, s.display_name, s.created_at, s.is_sidechain,
           p.name as project_name, p.display_name as project_display,
           COUNT(m.id) as msg_count,
           SUM(m.output_tokens) as output_tokens,
           MIN(m.timestamp) as first_msg, MAX(m.timestamp) as last_msg
    FROM sessions s
    JOIN projects p ON s.project_id = p.id
    JOIN messages m ON m.session_id = s.id
    WHERE s.created_at IS NOT NULL AND m.timestamp IS NOT NULL
    GROUP BY s.id
    HAVING msg_count > 2
    ORDER BY s.created_at DESC
    LIMIT 150
  `).all() as any[];

  // Group sessions by day
  const byDay = new Map<string, any[]>();
  for (const s of sessions) {
    const day = (s.created_at || s.first_msg || '').slice(0, 10);
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(s);
  }

  const sortedDays = [...byDay.keys()].sort().slice(-21); // Last 21 days
  const maxOutput = Math.max(...sessions.map((s: any) => s.output_tokens || 1));

  const lines: string[] = [
    'digraph timeline {',
    `  rankdir=${layout};`,
    '  bgcolor="transparent";',
    '  node [shape=box, style="filled,rounded", fontname="monospace", fontsize=8, margin="0.12,0.06"];',
    '  edge [style=invis];',
    '  newrank=true;',
    '',
  ];

  // Day nodes for timeline anchoring
  lines.push('  // Timeline anchors');
  for (let i = 0; i < sortedDays.length; i++) {
    const day = sortedDays[i];
    const weekday = new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short' });
    lines.push(`  "day_${day}" [label="${day.slice(5)}\\n${weekday}", shape=plaintext, fontsize=10, fontcolor="#a1a1aa"];`);
  }
  // Chain days
  if (sortedDays.length > 1) {
    lines.push(`  ${sortedDays.map(d => `"day_${d}"`).join(' -> ')};`);
  }
  lines.push('');

  let nodeCount = 0;
  for (const day of sortedDays) {
    const daySessions = byDay.get(day) || [];
    if (daySessions.length === 0) continue;

    lines.push(`  // ${day}`);
    lines.push(`  { rank=same; "day_${day}";`);
    for (const s of daySessions) {
      const intensity = Math.min(1, (s.output_tokens || 0) / maxOutput);
      const r = Math.round(99 + intensity * 150);
      const g = Math.round(102 + intensity * 30);
      const b = Math.round(241 - intensity * 100);
      const color = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
      const name = (s.display_name || s.session_uuid.slice(0, 8));
      const label = name.length > 25 ? name.slice(0, 24) + '…' : name;
      const proj = (s.project_display || s.project_name || '').slice(0, 15);
      lines.push(`    "s_${s.session_uuid}" [label="${esc(label)}\\n${esc(proj)} · ${s.msg_count}m", fillcolor="${color}70", fontcolor="#e4e4e7"];`);
      nodeCount++;
    }
    lines.push('  }');
    lines.push('');
  }

  lines.push('}');

  return { dot: lines.join('\n'), nodes: nodeCount, edges: 0 };
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const view = url.searchParams.get('view') || 'sessions';
    const project = url.searchParams.get('project') || undefined;
    const layout = url.searchParams.get('layout') === 'LR' ? 'LR' : 'TB';
    const format = url.searchParams.get('format'); // 'dot' or 'svg' for raw output

    const db = getDb();

    let result: { dot: string; nodes: number; edges: number };

    switch (view) {
      case 'tools':
        result = buildToolGraph(db, layout === 'TB' ? 'LR' : layout);
        break;
      case 'projects':
        result = buildProjectGraph(db, layout);
        break;
      case 'timeline':
        result = buildTimelineGraph(db, 'LR');
        break;
      case 'sessions':
      default:
        result = buildSessionGraph(db, project, layout);
        break;
    }

    // Return raw DOT source
    if (format === 'dot') {
      return new NextResponse(result.dot, {
        headers: {
          'Content-Type': 'text/vnd.graphviz',
          'Content-Disposition': `attachment; filename="${view}-graph.dot"`,
        },
      });
    }

    // Render SVG via graphviz
    let svg: string;
    const engine = view === 'projects' ? 'neato' : 'dot';
    try {
      svg = execSync(`${engine} -Tsvg`, {
        input: result.dot,
        encoding: 'utf-8',
        timeout: 15000,
        maxBuffer: 20 * 1024 * 1024,
      });
    } catch (e: any) {
      return NextResponse.json(
        { error: 'Graphviz rendering failed', detail: e.stderr || String(e), dot: result.dot },
        { status: 500 }
      );
    }

    // Return raw SVG
    if (format === 'svg') {
      return new NextResponse(svg, {
        headers: { 'Content-Type': 'image/svg+xml' },
      });
    }

    return NextResponse.json({
      svg,
      nodeCount: result.nodes,
      edgeCount: result.edges,
      dot: result.dot,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Graph generation failed', detail: String(err) },
      { status: 500 }
    );
  }
}
