/**
 * Todos and what blocks them, as a graph.
 *
 * The interesting part is edge resolution. A todo records its blockers as a
 * JSON array of references, and those references are whatever the harness
 * that wrote them had to hand: a uuid, an external id, a numeric row id, any
 * of them possibly prefixed `todo:`. Resolving that was inline in a route
 * handler, so the one rule that decides whether the graph has any edges at
 * all could only be checked by rendering an SVG and looking at it.
 */

export interface TodoRow {
  id: number;
  uuid: string | null;
  external_id: string | null;
  content: string;
  status: string;
  blocked_by: string | null;
  project_name: string;
  project_display: string | null;
}

export interface Edge {
  /** The blocker. */
  from: number;
  /** The todo waiting on it. */
  to: number;
}

const STATUS_COLORS: Record<string, string> = {
  pending: '#fbbf24',
  in_progress: '#60a5fa',
  completed: '#10b981',
  obsolete: '#71717a',
};

const truncate = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/** Graphviz reads a quoted string, so quotes and backslashes have to survive. */
export const escapeLabel = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** A cluster id is an identifier, not a string — a project name is neither. */
export const sanitizeClusterId = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '_');

/**
 * Every blocking relationship both ends of which we actually have.
 *
 * A reference to a todo outside this result — filtered out by project or
 * status, or deleted — is dropped rather than drawn as a dangling edge to a
 * node that is not on the page.
 */
export function resolveEdges(rows: TodoRow[]): Edge[] {
  const byId = new Map<number, TodoRow>();
  const byUuid = new Map<string, TodoRow>();
  const byExternalId = new Map<string, TodoRow>();

  for (const row of rows) {
    byId.set(row.id, row);
    if (row.uuid) byUuid.set(row.uuid, row);
    if (row.external_id) byExternalId.set(row.external_id, row);
  }

  const edges: Edge[] = [];

  for (const row of rows) {
    if (!row.blocked_by) continue;

    let blockers: unknown;
    try {
      blockers = JSON.parse(row.blocked_by);
    } catch {
      // A malformed field is one todo's problem, not the whole graph's.
      continue;
    }
    if (!Array.isArray(blockers)) continue;

    for (const ref of blockers) {
      const key = String(ref).replace(/^todo:/, '');
      const blocker = byUuid.get(key) ?? byExternalId.get(key) ?? byId.get(Number(key));
      if (blocker) edges.push({ from: blocker.id, to: row.id });
    }
  }

  return edges;
}

/** Todos grouped under the project they belong to, for the DOT clusters. */
export function groupByProject(rows: TodoRow[]): Map<string, { display: string; todos: TodoRow[] }> {
  const byProject = new Map<string, { display: string; todos: TodoRow[] }>();
  for (const row of rows) {
    let group = byProject.get(row.project_name);
    if (!group) {
      group = { display: row.project_display || row.project_name, todos: [] };
      byProject.set(row.project_name, group);
    }
    group.todos.push(row);
  }
  return byProject;
}

/** The graph as DOT, one cluster per project. */
export function buildDot(rows: TodoRow[], edges: Edge[], layout: 'TB' | 'LR'): string {
  const lines: string[] = [
    'digraph todos {',
    `  rankdir=${layout};`,
    '  bgcolor="transparent";',
    '  node [shape=box, style="filled,rounded", fontname="monospace", fontsize=10, margin="0.2,0.1"];',
    '  edge [color="#71717a"];',
    '',
  ];

  for (const [project, group] of groupByProject(rows)) {
    lines.push(`  subgraph cluster_${sanitizeClusterId(project)} {`);
    lines.push(`    label="${escapeLabel(group.display)}";`);
    lines.push('    color="#3f3f46";');
    lines.push('    fontcolor="#a1a1aa";');
    lines.push('    style=dashed;');
    lines.push('');

    const ids: number[] = [];
    for (const todo of group.todos) {
      const color = STATUS_COLORS[todo.status] || '#71717a';
      const label = `${escapeLabel(truncate(todo.content.replace(/\n/g, ' '), 40))}\\n[${todo.status}]`;
      lines.push(`    "t_${todo.id}" [label="${label}" fillcolor="${color}" fontcolor="#000"];`);
      ids.push(todo.id);
    }

    // Invisible edges chain the nodes so a cluster of unrelated todos keeps a
    // stable order instead of being rearranged on every render.
    if (ids.length > 1) {
      lines.push(`    ${ids.map((id) => `"t_${id}"`).join(' -> ')} [style=invis];`);
    }

    lines.push('  }');
    lines.push('');
  }

  for (const edge of edges) {
    lines.push(`  "t_${edge.from}" -> "t_${edge.to}";`);
  }

  lines.push('}');
  return lines.join('\n');
}
