# 3019: Graph Explorer Redesign

**Status:** open
**Project:** unfirehose
**Estimated:** 2-4h

## Context

The `/todos/graph` page was removed from nav — the existing graph visualization was not useful enough to justify its sidebar real estate. The page still exists but is hidden.

## Goals

Rebuild the graph explorer with better diagrams that actually provide insight:

1. **Project dependency graph** — show relationships between projects based on shared sessions, todo cross-references, and import paths
2. **Session timeline graph** — Gantt-style view of sessions over time, grouped by project, showing concurrency and gaps
3. **Todo flow diagram** — Sankey or flow diagram showing todo lifecycle: created → in_progress → completed/obsolete, grouped by source harness
4. **Agent deployment graph** — when mega-deploy runs, show which agents worked on which todos and their outcomes

## Technical Notes

- Current implementation uses a basic force-directed graph (likely react-force-graph or similar)
- Consider Recharts treemap, Sankey, or a proper DAG library
- D3.js is available if needed for custom visualizations
- Keep it server-data-driven — all data comes from existing SQLite tables

## Acceptance Criteria

- At least 2 of the 4 diagram types implemented
- Each diagram provides actionable insight (not just pretty)
- Responsive, dark-themed, consistent with rest of dashboard
- Re-add to sidebar nav once ready
