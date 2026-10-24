import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createTestDb } from './test/db-helper';

const db = createTestDb();
vi.mock('./db/schema', () => ({ getDb: () => db }));
// The project list also walks ~/.claude/projects; the demo is the whole
// fixture here, so the disk side is empty.
vi.mock('./claude-paths', async (importOriginal) => {
  const real = await importOriginal<typeof import('./claude-paths')>();
  return { ...real, claudePaths: { ...real.claudePaths, projects: '/nonexistent/claude-projects' } };
});
// A database with no price book starts a background sync against public
// feeds. Demo rows price at $0 without one, and a test makes no network calls.
vi.mock('./pricing-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pricing-sync')>()),
  ensurePricingHydrated: () => {},
}));

const { seedDemo, buildDemoPayloads, DEMO_HARNESSES, DEMO_ONE_SESSION_HARNESSES, DEMO_DAYS, DEMO_TURNS, DEMO_NODE, DEMO_MODELS, DEMO_PROJECTS } = await import('./demo-seed');
const { SYNTHETIC_MODELS, costForUsage } = await import('./pricing');
const { FOREIGN_FORMATS, ingestedHarnesses } = await import('./harness-registry');
const ALL_DEMO_HARNESSES = [...DEMO_HARNESSES, ...DEMO_ONE_SESSION_HARNESSES];
const DEMO_SESSIONS = DEMO_DAYS * DEMO_HARNESSES.length + DEMO_ONE_SESSION_HARNESSES.length;
const { readDashboard } = await import('./dashboard');
const { readTokensPayload } = await import('./tokens');
const { readProjectList } = await import('./projects-list');
const { readScrobblePayload } = await import('./scrobble');

const NOW = Date.parse('2026-10-23T12:00:00.000Z');

/** Everything a seed writes, minus autoincrement ids, in a stable order. */
function snapshot(d: typeof db) {
  const q = (sql: string) => d.prepare(sql).all();
  return {
    projects: q('SELECT name, display_name, path, first_seen, root_commit_hash, origin_url FROM projects ORDER BY name'),
    sessions: q(`SELECT session_uuid, harness, first_prompt, display_name, created_at, updated_at,
                        last_message_at, status, closed_at FROM sessions ORDER BY session_uuid`),
    messages: q(`SELECT message_uuid, parent_uuid, type, timestamp, model, input_tokens, output_tokens,
                        cache_read_tokens, cache_creation_tokens, ingested_at FROM messages ORDER BY message_uuid`),
    blocks: q(`SELECT m.message_uuid, cb.position, cb.block_type, cb.text_content, cb.tool_name, cb.tool_input, cb.tool_use_id
                 FROM content_blocks cb JOIN messages m ON m.id = cb.message_id ORDER BY m.message_uuid, cb.position`),
    usage: q('SELECT * FROM usage_minutes ORDER BY minute, project_id'),
    todos: q('SELECT uuid, content, status, source, created_at, updated_at, completed_at FROM todos ORDER BY uuid'),
    alerts: q('SELECT triggered_at, alert_type, metric, actual_value, project_name, details FROM alerts'),
    mesh: q('SELECT * FROM mesh_snapshots ORDER BY timestamp'),
    facts: q('SELECT * FROM mesh_node_facts'),
  };
}

describe('seedDemo', () => {
  let counts: ReturnType<typeof seedDemo>;
  beforeAll(() => { counts = seedDemo(db, { now: NOW }); });

  it('writes what the ticket asks for', () => {
    const sessions = DEMO_SESSIONS;
    expect(counts).toEqual({
      projects: 2,
      sessions,
      messages: sessions * DEMO_TURNS * 2,
      todos: 5,
      alerts: 1,
      meshSnapshots: DEMO_DAYS * 24 * 12,
      // Every turn but the first and last calls one tool, and each touches something.
      actions: sessions * (DEMO_TURNS - 2),
    });
    const harnesses = db.prepare('SELECT harness, COUNT(*) AS n FROM sessions GROUP BY harness ORDER BY harness').all();
    expect(harnesses).toEqual([
      { harness: 'agnt', n: DEMO_DAYS },
      { harness: 'aider', n: 1 },
      { harness: 'claude-code', n: DEMO_DAYS },
      { harness: 'codex', n: 1 },
      { harness: 'continue', n: 1 },
      { harness: 'gemini-cli', n: 1 },
      { harness: 'uncloseai', n: DEMO_DAYS },
    ]);
    // One session for every harness with a reader of its own, as the registry names them.
    expect([...DEMO_ONE_SESSION_HARNESSES].sort()).toEqual(
      ingestedHarnesses().filter((h) => FOREIGN_FORMATS.has(h.format!)).map((h) => h.id).sort());
    // Both projects carry work, and both are repos (a project list drops a
    // row with no root commit).
    const perProject = db.prepare(`SELECT p.root_commit_hash AS root, COUNT(s.id) AS n FROM projects p
                                   JOIN sessions s ON s.project_id = p.id GROUP BY p.id`).all() as Array<{ root: string; n: number }>;
    expect(perProject).toHaveLength(2);
    for (const p of perProject) { expect(p.root).toBeTruthy(); expect(p.n).toBeGreaterThan(0); }
    expect(db.prepare(`SELECT COUNT(DISTINCT status) AS n FROM todos`).get()).toEqual({ n: 3 });
    expect(db.prepare(`SELECT DISTINCT hostname FROM mesh_snapshots`).all()).toEqual([{ hostname: DEMO_NODE }]);
  });

  it('spans a week that ends at now', () => {
    const { first, last } = db.prepare('SELECT MIN(timestamp) AS first, MAX(timestamp) AS last FROM messages').get() as { first: string; last: string };
    expect(last).toBe(new Date(NOW).toISOString());
    expect(Date.parse(first)).toBeGreaterThan(NOW - 7 * 86_400_000);
    const days = db.prepare(`SELECT COUNT(DISTINCT substr(timestamp, 1, 10)) AS n FROM messages`).get() as { n: number };
    expect(days.n).toBeGreaterThanOrEqual(DEMO_DAYS);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE status = 'active'`).get()).toEqual({ n: 1 });
  });

  it('fills our action ledger, a destructive call and a network call among it', () => {
    const kinds = db.prepare(`SELECT kind, COUNT(*) AS n FROM action_ledger GROUP BY kind`).all() as Array<{ kind: string; n: number }>;
    expect(kinds.map((k) => k.kind).sort()).toEqual(['fs-read', 'fs-write', 'git', 'network', 'shell']);
    const flagged = db.prepare(`SELECT command, flags FROM action_ledger WHERE flagged = 1`).all() as Array<{ command: string; flags: string }>;
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.every((f) => f.flags === 'destructive' && f.command.includes('reset --hard'))).toBe(true);
  });

  it('carries text, reasoning, tool calls and their results', () => {
    const types = db.prepare('SELECT block_type, COUNT(*) AS n FROM content_blocks GROUP BY block_type').all() as Array<{ block_type: string; n: number }>;
    const by = Object.fromEntries(types.map((t) => [t.block_type, t.n]));
    expect(by.text).toBeGreaterThan(0);
    expect(by.reasoning).toBe(counts.sessions);
    expect(by['tool-call']).toBeGreaterThan(0);
    // Every call is answered by a result carrying its id.
    expect(by['tool-result']).toBe(by['tool-call']);
    const orphan = db.prepare(`SELECT COUNT(*) AS n FROM content_blocks c WHERE c.block_type = 'tool-call'
      AND NOT EXISTS (SELECT 1 FROM content_blocks r WHERE r.block_type = 'tool-result' AND r.tool_use_id = c.tool_use_id)`).get();
    expect(orphan).toEqual({ n: 0 });
  });

  it('books every token against a synthetic model, so every cost is $0', () => {
    const models = db.prepare(`SELECT DISTINCT model FROM messages WHERE model IS NOT NULL`).all() as Array<{ model: string }>;
    expect(models.map((m) => m.model).sort()).toEqual([...DEMO_MODELS].sort());
    for (const { model } of models) expect(SYNTHETIC_MODELS.has(model)).toBe(true);
    const rows = db.prepare(`SELECT model, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cache_read_tokens) AS r,
                             SUM(cache_creation_tokens) AS w FROM messages WHERE model IS NOT NULL GROUP BY model`).all() as any[];
    for (const r of rows) {
      expect(r.i + r.o).toBeGreaterThan(0);
      const c = costForUsage({ model: r.model, input: r.i, output: r.o, cacheRead: r.r, cacheWrite: r.w });
      expect(c.total).toBe(0);
      expect(c.source).toBe('synthetic');
    }
  });

  it('writes the same rows for the same now', () => {
    const again = createTestDb();
    seedDemo(again, { now: NOW });
    expect(snapshot(again)).toEqual(snapshot(db));
  });

  it('writes different rows for a different now', () => {
    const later = createTestDb();
    seedDemo(later, { now: NOW + 86_400_000 });
    expect(snapshot(later).messages).not.toEqual(snapshot(db).messages);
  });

  it('refuses a database that already holds sessions', () => {
    expect(() => seedDemo(db, { now: NOW })).toThrow(/already holds/);
  });
});

/**
 * The seed powers the payload builders: what the worker would store is
 * populated, so a page served from them has something on it.
 */
describe('buildDemoPayloads', () => {
  beforeAll(async () => {
    // Ranges slide with the wall clock; seed up to it.
    const fresh = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    if (fresh.n > 0) {
      for (const t of ['content_blocks', 'usage_minutes', 'messages', 'todos', 'sessions', 'projects', 'alerts', 'mesh_snapshots', 'mesh_node_facts']) {
        db.prepare(`DELETE FROM ${t}`).run();
      }
    }
    seedDemo(db);
    await buildDemoPayloads();
  });

  it('stores a populated dashboard for every warm range, at $0', () => {
    for (const range of ['24h', '7d', '28d']) {
      const d = readDashboard(range, Infinity)!.payload;
      expect(d.summary.sessions).toBeGreaterThan(0);
      expect(d.summary.totalTokens).toBeGreaterThan(0);
      expect(d.summary.totalCost).toBe(0);
      expect(d.modelBreakdown.length).toBeGreaterThan(0);
      expect(d.dailyActivity.length).toBeGreaterThan(0);
    }
    const week = readDashboard('7d', Infinity)!.payload;
    expect(week.summary.sessions).toBe(DEMO_SESSIONS);
    expect(week.modelBreakdown.map((m: any) => m.model).sort()).toEqual([...DEMO_MODELS].sort());
  });

  it('stores a populated tokens payload split by harness', () => {
    const t = readTokensPayload('7d', Infinity)!.payload;
    expect(JSON.stringify(t)).toContain('demo-model');
    for (const harness of ALL_DEMO_HARNESSES) expect(JSON.stringify(t)).toContain(harness);
    expect(readTokensPayload('all', Infinity)).not.toBeNull();
  });

  it('stores both projects in the project list', () => {
    const list = readProjectList(Infinity)!.payload;
    expect(list.map((p) => p.name).sort()).toEqual(DEMO_PROJECTS.map((p) => p.name).sort());
    for (const p of list) expect(p.sessionCount).toBeGreaterThan(0);
  });

  it('stores a scrobble payload that sees every demo harness', () => {
    const s = readScrobblePayload(Infinity)!.payload;
    expect(s.harnesses.map((h: any) => h.harness).sort()).toEqual([...ALL_DEMO_HARNESSES].sort());
  });
});
