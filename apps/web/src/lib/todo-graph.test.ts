import { describe, it, expect } from 'vitest';
import { resolveEdges, buildDot, escapeLabel, sanitizeClusterId, type TodoRow } from './todo-graph';

const todo = (over: Partial<TodoRow> & { id: number }): TodoRow => ({
  uuid: null, external_id: null, content: `todo ${over.id}`, status: 'pending',
  blocked_by: null, project_name: 'proj', project_display: 'proj', ...over,
});

describe('resolveEdges', () => {
  it('resolves a blocker by every kind of reference a harness writes', () => {
    // Different harnesses record whatever identifier they had, so all three
    // forms appear in the same table.
    const rows = [
      todo({ id: 1, uuid: 'u-one' }),
      todo({ id: 2, external_id: '42' }),
      todo({ id: 3 }),
      todo({ id: 9, blocked_by: JSON.stringify(['u-one', '42', '3']) }),
    ];
    expect(resolveEdges(rows).sort((a, b) => a.from - b.from)).toEqual([
      { from: 1, to: 9 }, { from: 2, to: 9 }, { from: 3, to: 9 },
    ]);
  });

  it('strips a todo: prefix before resolving', () => {
    const rows = [todo({ id: 1, uuid: 'u-one' }), todo({ id: 2, blocked_by: '["todo:u-one"]' })];
    expect(resolveEdges(rows)).toEqual([{ from: 1, to: 2 }]);
  });

  it('points from the blocker to what it blocks', () => {
    // Direction is the whole meaning of the arrow: 1 must finish before 2.
    const rows = [todo({ id: 1 }), todo({ id: 2, blocked_by: '["1"]' })];
    expect(resolveEdges(rows)).toEqual([{ from: 1, to: 2 }]);
  });

  it('drops a reference to a todo that is not on the page', () => {
    // Filtered out by project or status, or deleted. Drawing it would be an
    // arrow to a node nobody can see.
    const rows = [todo({ id: 2, blocked_by: '["999"]' })];
    expect(resolveEdges(rows)).toEqual([]);
  });

  it('lets one malformed field spoil only its own todo', () => {
    const rows = [
      todo({ id: 1 }),
      todo({ id: 2, blocked_by: '{ truncated' }),
      todo({ id: 3, blocked_by: '["1"]' }),
    ];
    expect(resolveEdges(rows)).toEqual([{ from: 1, to: 3 }]);
  });

  it('ignores a blocked_by that is not a list', () => {
    expect(resolveEdges([todo({ id: 1 }), todo({ id: 2, blocked_by: '"1"' })])).toEqual([]);
  });
});

describe('buildDot', () => {
  it('puts each project in its own cluster', () => {
    const dot = buildDot([
      todo({ id: 1, project_name: 'alpha', project_display: 'Alpha' }),
      todo({ id: 2, project_name: 'beta', project_display: 'Beta' }),
    ], [], 'TB');
    expect(dot).toContain('subgraph cluster_alpha');
    expect(dot).toContain('subgraph cluster_beta');
    expect(dot).toContain('label="Alpha"');
  });

  it('draws the edges it was given', () => {
    const dot = buildDot([todo({ id: 1 }), todo({ id: 2 })], [{ from: 1, to: 2 }], 'TB');
    expect(dot).toContain('"t_1" -> "t_2";');
  });

  it('honours the layout direction', () => {
    expect(buildDot([todo({ id: 1 })], [], 'LR')).toContain('rankdir=LR');
  });

  it('holds a cluster of unrelated todos in a stable order', () => {
    // Invisible edges, or graphviz rearranges the cluster on every render and
    // the same data draws differently each time.
    const dot = buildDot([todo({ id: 1 }), todo({ id: 2 })], [], 'TB');
    expect(dot).toContain('"t_1" -> "t_2" [style=invis];');
  });

  it('shortens a long todo rather than letting it set the node width', () => {
    const dot = buildDot([todo({ id: 1, content: 'x'.repeat(100) })], [], 'TB');
    expect(dot).toContain('…');
    expect(dot).not.toContain('x'.repeat(50));
  });

  it('flattens a multi-line todo into its label', () => {
    const dot = buildDot([todo({ id: 1, content: 'first\nsecond' })], [], 'TB');
    expect(dot).toContain('first second');
  });
});

describe('escaping', () => {
  it('keeps a quote from ending the label early', () => {
    // A todo saying `fix the "cache"` would otherwise produce invalid DOT and
    // graphviz would fail the whole render.
    expect(escapeLabel('fix the "cache"')).toBe('fix the \\"cache\\"');
    expect(escapeLabel('a\\b')).toBe('a\\\\b');
  });

  it('reduces a project name to something that can be an identifier', () => {
    expect(sanitizeClusterId('-home-fox-git-unfirehose.com')).toBe('_home_fox_git_unfirehose_com');
  });
});
