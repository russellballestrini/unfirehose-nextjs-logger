/**
 * A small synthetic database for `make demo`, our README screenshots and the
 * tests that want every page populated without anyone's real logs.
 *
 * Two projects, three harnesses (claude-code, uncloseai, agnt) with a week of
 * sessions ending at `now`, one session each for the harnesses with readers
 * of their own (codex, gemini-cli, continue, aider), a few todos, one alert and a week of samples for
 * one mesh node. Every assistant message is booked against a model in
 * SYNTHETIC_MODELS, so every cost reads $0 and the pricing sync never asks
 * an oracle about it.
 *
 * Deterministic: no Math.random, no wall clock. Every value derives from a
 * fixed seed and `now`, so the same `now` writes the same rows. Rows go in
 * through the same helpers ingest uses (getOrCreateSession, insertMessage,
 * insertContentBlocks, updateUsageMinutes), so a column ingest fills is
 * filled here too.
 *
 * Two steps, because they read our database differently:
 *   seedDemo(db, { now })   writes rows into the handle it is given
 *   buildDemoPayloads()     builds the stored dashboard, tokens, project list
 *                           and scrobble payloads through getDb(), exactly as
 *                           the worker does, so pages render with no worker
 * Call the second only where getDb() is the database the first seeded.
 */
import type Database from 'better-sqlite3';
import { getOrCreateSession, insertMessage, insertContentBlocks, updateUsageMinutes } from './db/ingest-rows';
import { DEMO_MODELS } from './pricing';
import { drainLedger } from './db/action-ledger';

export { DEMO_MODELS };

/** Harness names as `sessions.harness` carries them: a session a day each. */
export const DEMO_HARNESSES = ['claude-code', 'uncloseai', 'agnt'] as const;
/**
 * Harnesses with a reader of their own (db/ingest-foreign.ts): one session
 * each, so their badges, token rows and session viewer have something to
 * show. A test holds this to the registry's foreign formats.
 */
export const DEMO_ONE_SESSION_HARNESSES = ['codex', 'gemini-cli', 'continue', 'aider'] as const;
type DemoHarness = (typeof DEMO_HARNESSES)[number] | (typeof DEMO_ONE_SESSION_HARNESSES)[number];
/** The node our mesh samples describe. */
export const DEMO_NODE = 'demo-node';
export const DEMO_DAYS = 7;
/** Turns per session; each turn is one user and one assistant message. */
export const DEMO_TURNS = 6;

export const DEMO_PROJECTS = [
  {
    name: '-home-demo-git-demo-api',
    displayName: 'demo-api',
    path: '/home/demo/git/demo-api',
    rootCommit: 'de00000000000000000000000000000000000a01',
    origin: 'https://git.example.invalid/demo/demo-api.git',
    prompts: [
      'Add pagination to the /orders endpoint and cover it with tests',
      'Why does the health check time out under load? Find the slow query',
      'Rename the billing module to invoices without breaking imports',
      'Write a migration that backfills created_at on legacy rows',
    ],
  },
  {
    name: '-home-demo-git-demo-web',
    displayName: 'demo-web',
    path: '/home/demo/git/demo-web',
    rootCommit: 'de00000000000000000000000000000000000b02',
    origin: 'https://git.example.invalid/demo/demo-web.git',
    prompts: [
      'Make the settings page usable at phone width',
      'Replace the hand-rolled date strings with our ago helper',
      'The chart legend overlaps the axis in dark mode, fix it',
      'Split the dashboard into server and client components',
    ],
  },
] as const;

const HARNESS_MODEL: Record<DemoHarness, string> = {
  'claude-code': DEMO_MODELS[0],
  uncloseai: DEMO_MODELS[1],
  agnt: DEMO_MODELS[0],
  codex: DEMO_MODELS[1],
  'gemini-cli': DEMO_MODELS[1],
  continue: DEMO_MODELS[0],
  aider: DEMO_MODELS[1],
};

const TOOLS = [
  { name: 'Read', input: (p: string) => ({ file_path: `${p}/src/index.ts` }), output: 'export function main() {\n  // 120 lines\n}\n' },
  { name: 'Grep', input: () => ({ pattern: 'TODO', path: 'src' }), output: 'src/routes.ts:42: // TODO paginate\nsrc/db.ts:7: // TODO index' },
  { name: 'Bash', input: () => ({ command: 'npm test -- --run' }), output: 'Test Files  12 passed (12)\n     Tests  148 passed (148)' },
  { name: 'Edit', input: (p: string) => ({ file_path: `${p}/src/routes.ts`, old_string: 'limit = 100', new_string: 'limit = query.limit ?? 50' }), output: 'The file has been updated.' },
  // For our action ledger: one call it flags as destructive, one network call.
  { name: 'Bash', input: () => ({ command: 'git stash && git reset --hard origin/main' }), output: 'HEAD is now at 3f2c1a9 Merge branch fix/pagination' },
  { name: 'WebFetch', input: () => ({ url: 'https://registry.npmjs.org/better-sqlite3', prompt: 'Which version is latest?' }), output: 'The latest version is 12.4.1.' },
] as const;

const TODOS = [
  { project: 0, content: 'Cover the empty page of /orders with a test', status: 'pending', source: 'claude', minutes: 10 },
  { project: 0, content: 'Add an index on orders(created_at)', status: 'in_progress', source: 'claude', minutes: 20 },
  { project: 0, content: 'Backfill created_at on legacy rows', status: 'completed', source: 'agnt', minutes: 30 },
  { project: 1, content: 'Settings page at 320px without horizontal scroll', status: 'pending', source: 'claude', minutes: 45 },
  { project: 1, content: 'Swap hand-rolled relative times for ago', status: 'completed', source: 'uncloseai', minutes: 15 },
] as const;

/** mulberry32: a tiny seeded generator, so the seed replays exactly. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const hex = (n: number) => Array.from({ length: n }, () => int(0, 15).toString(16)).join('');
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + int(0, 3)).toString(16)}${hex(3)}-${hex(12)}`;
  return { next, int, uuid };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
/** SQLite datetime('now') shape: what alerts and mesh rows carry. */
const sqlTime = (ms: number) => iso(ms).replace('T', ' ').slice(0, 19);

export interface DemoSeedResult {
  projects: number;
  sessions: number;
  messages: number;
  todos: number;
  alerts: number;
  meshSnapshots: number;
  /** Rows in our action ledger, classified from the tool calls above. */
  actions: number;
}

/**
 * Seed our demo rows into `db`, which must carry the schema (`migrate`).
 * Refuses a database that already holds sessions: a demo seeded on top of
 * real history would be neither.
 */
export function seedDemo(db: Database.Database, opts: { now?: number } = {}): DemoSeedResult {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
  if (existing.n > 0) throw new Error(`seedDemo: database already holds ${existing.n} sessions; seed a fresh one`);

  const now = Math.floor((opts.now ?? Date.now()) / 1000) * 1000;
  const rng = prng(4010);
  const result: DemoSeedResult = { projects: 0, sessions: 0, messages: 0, todos: 0, alerts: 0, meshSnapshots: 0, actions: 0 };

  db.transaction(() => {
    const projectIds: number[] = [];
    const insertProject = db.prepare(
      `INSERT INTO projects (name, display_name, path, first_seen, root_commit_hash, origin_url, remotes_json, last_cwd_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of DEMO_PROJECTS) {
      projectIds.push(Number(insertProject.run(
        p.name, p.displayName, p.path, sqlTime(now - DEMO_DAYS * DAY), p.rootCommit, p.origin,
        JSON.stringify([p.origin]), p.path,
      ).lastInsertRowid));
      result.projects++;
    }

    const closeSession = db.prepare(
      `UPDATE sessions SET updated_at = ?, last_message_at = ?, status = ?, closed_at = ? WHERE id = ?`,
    );
    let toolSeq = 0;
    let lastSessionId = 0;

    const seedSession = (harness: DemoHarness, h: number, daysAgo: number) => {
      const projectIdx = (daysAgo + h) % DEMO_PROJECTS.length;
      const project = DEMO_PROJECTS[projectIdx];
      const projectId = projectIds[projectIdx];
      const model = HARNESS_MODEL[harness];

      // Gaps between messages, laid out first so a session can end on a
      // chosen instant. The newest claude-code session ends exactly at now.
      const gaps: number[] = [];
      for (let k = 0; k < DEMO_TURNS; k++) {
        gaps.push(k === 0 ? 0 : rng.int(2, 6) * MINUTE + rng.int(0, 59) * 1000); // user after previous assistant
        gaps.push(rng.int(15, 90) * 1000); // assistant after user
      }
      const span = gaps.reduce((a, b) => a + b, 0);
      const end = daysAgo === 0 && h === 0 ? now : now - daysAgo * DAY - h * 3 * HOUR - rng.int(1, 60) * MINUTE;
      let t = end - span;

      const prompt = project.prompts[(DEMO_DAYS - 1 - daysAgo + h) % project.prompts.length];
      const sessionUuid = rng.uuid();
      const sessionId = getOrCreateSession(db, sessionUuid, projectId, {
        firstPrompt: prompt,
        createdAt: iso(t),
        harness,
        gitBranch: 'main',
        cliVersion: harness === 'claude-code' ? '2.1.0' : '1.0.0',
      });
      result.sessions++;

      let parent: string | null = null;
      let pendingTool: { id: string; output: string } | null = null;
      let g = 0;
      for (let k = 0; k < DEMO_TURNS; k++) {
        t += gaps[g++];
        const userContent: any[] = pendingTool
          ? [{ type: 'tool-result', toolCallId: pendingTool.id, output: pendingTool.output }]
          : [{ type: 'text', text: k === 0 ? prompt : 'Looks right. Keep going.' }];
        pendingTool = null;
        const userUuid = rng.uuid();
        const userId = insertMessage(db, sessionId, { role: 'user', id: userUuid, parentId: parent, timestamp: iso(t) });
        if (userId) { insertContentBlocks(db, userId, userContent); result.messages++; }
        parent = userUuid;

        t += gaps[g++];
        const assistantContent: any[] = [];
        if (k === 0) {
          assistantContent.push({ type: 'reasoning', text: `Start by reading how ${project.displayName} is laid out, then find where this change belongs.` });
          assistantContent.push({ type: 'text', text: 'I will look at the code first, then make the change in small steps.' });
        } else if (k < DEMO_TURNS - 1) {
          const tool = TOOLS[(toolSeq + h) % TOOLS.length];
          const id = `toolu_demo_${String(++toolSeq).padStart(4, '0')}`;
          assistantContent.push({ type: 'text', text: `Next: ${tool.name.toLowerCase()}.` });
          assistantContent.push({ type: 'tool-call', toolCallId: id, toolName: tool.name, input: tool.input(project.path) });
          pendingTool = { id, output: tool.output };
        } else {
          assistantContent.push({ type: 'text', text: 'Done. Tests pass and the change is ready for review.' });
        }
        // Aider prints its counts rounded ("2.4k sent"), and its reader keeps them so, marked approximate.
        const approx = harness === 'aider';
        const rounded = (n: number) => (approx && n >= 1000 ? Math.round(n / 100) * 100 : n);
        const input = rounded(rng.int(800, 4000));
        const output = rounded(rng.int(100, 1200));
        // Claude Code reads most of its prompt from cache; the others report none.
        const cacheRead = harness === 'claude-code' ? rng.int(10_000, 60_000) : 0;
        const cacheWrite = harness === 'claude-code' ? rng.int(0, 3000) : 0;
        const assistantUuid = rng.uuid();
        const assistantId = insertMessage(db, sessionId, {
          role: 'assistant', id: assistantUuid, parentId: parent, timestamp: iso(t), model,
          ...(approx ? { tokensApprox: true } : {}),
          usage: { inputTokens: input, outputTokens: output, inputTokenDetails: { cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite } },
        });
        if (assistantId) {
          insertContentBlocks(db, assistantId, assistantContent);
          updateUsageMinutes(db, projectId, iso(t), { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheCreationTokens: cacheWrite });
          result.messages++;
        }
        parent = assistantUuid;
      }
      const last = iso(t);
      closeSession.run(last, last, 'closed', last, sessionId);
      lastSessionId = sessionId;
    };

    // Oldest first, so ids climb with time the way an ingest would leave them.
    for (let daysAgo = DEMO_DAYS - 1; daysAgo >= 0; daysAgo--) {
      DEMO_HARNESSES.forEach((harness, h) => seedSession(harness, h, daysAgo));
    }
    // The session that ends at now is still going.
    db.prepare(`UPDATE sessions SET status = 'active', closed_at = NULL WHERE id = ?`).run(lastSessionId);
    // One session for each harness with a reader of its own, over the last few days.
    DEMO_ONE_SESSION_HARNESSES.forEach((harness, i) => {
      seedSession(harness, DEMO_HARNESSES.length + i, (i + 1) % DEMO_DAYS);
    });

    // ingested_at defaults to the wall clock; pin it to the message's own time
    // so the same `now` leaves byte-identical rows.
    db.prepare(`UPDATE messages SET ingested_at = replace(substr(timestamp, 1, 19), 'T', ' ')`).run();

    const insertTodo = db.prepare(
      `INSERT INTO todos (uuid, project_id, content, status, source, estimated_minutes, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    TODOS.forEach((todo, i) => {
      const created = now - (DEMO_DAYS - 1 - i) * DAY - 2 * HOUR;
      const updated = created + 3 * HOUR;
      insertTodo.run(
        rng.uuid(), projectIds[todo.project], todo.content, todo.status, todo.source, todo.minutes,
        sqlTime(created), sqlTime(updated), todo.status === 'completed' ? sqlTime(updated) : null,
      );
      result.todos++;
    });

    db.prepare(
      `INSERT INTO alerts (triggered_at, alert_type, window_minutes, metric, threshold_value, actual_value, project_name, details, acknowledged)
       VALUES (?, 'threshold_breach', 5, 'output_tokens', 4000, 5210, ?, ?, 0)`,
    ).run(sqlTime(now - 26 * HOUR), DEMO_PROJECTS[0].name, JSON.stringify({ demo: true, note: 'A synthetic spike from our demo seed' }));
    result.alerts++;

    // A week of samples for one node, every five minutes, on a daily cycle.
    const insertSnap = db.prepare(
      `INSERT INTO mesh_snapshots (timestamp, hostname, cpu_cores, load_avg_1, load_avg_5, load_avg_15,
         mem_total_gb, mem_used_gb, power_watts, gpu_power_watts, gpu_util, gpu_mem_used_mb, gpu_mem_total_mb,
         power_source, claude_processes, agent_processes, harness_counts)
       VALUES (?, ?, 8, ?, ?, ?, 32, ?, ?, NULL, NULL, NULL, NULL, 'estimate', ?, ?, ?)`,
    );
    const step = 5 * MINUTE;
    const first = Math.floor((now - DEMO_DAYS * DAY) / step) * step + step;
    for (let ts = first; ts <= now; ts += step) {
      const hourOfDay = new Date(ts).getUTCHours() + new Date(ts).getUTCMinutes() / 60;
      const busy = Math.max(0, Math.sin(((hourOfDay - 8) / 24) * 2 * Math.PI)); // peaks mid afternoon UTC
      const jitter = rng.next();
      const load = +(0.3 + busy * 3.5 + jitter * 0.4).toFixed(2);
      const agents = busy > 0.3 ? 1 + Math.floor(jitter * 2) : 0;
      insertSnap.run(
        sqlTime(ts), DEMO_NODE, load, +(load * 0.9).toFixed(2), +(load * 0.8).toFixed(2),
        +(9 + busy * 11 + jitter).toFixed(1), +(38 + busy * 70 + jitter * 6).toFixed(1),
        agents > 0 ? 1 : 0, agents, agents > 0 ? JSON.stringify({ 'claude-code': 1, ...(agents > 1 ? { uncloseai: 1 } : {}) }) : null,
      );
      result.meshSnapshots++;
    }
    db.prepare(
      `INSERT INTO mesh_node_facts (hostname, facts, uptime_seconds, ssh_alias, observed_at) VALUES (?, ?, ?, NULL, ?)`,
    ).run(
      DEMO_NODE,
      JSON.stringify({ cpuModel: 'Demo CPU 8-Core', arch: 'x86_64', os: 'Linux', kind: 'compute', memCapGB: 32, ssdCount: 1, spinningDisks: 0 }),
      DEMO_DAYS * 86400, sqlTime(now),
    );
  })();

  // What the worker's backfill would leave: every tool call above, classified.
  result.actions = drainLedger(db).recorded;

  return result;
}

/**
 * Build the stored payloads pages read — dashboard and tokens for every warm
 * range, the project list and scrobble — through their own refresh
 * functions, against getDb(). What the worker would leave after its first
 * minute, so a page renders with no worker running.
 */
export async function buildDemoPayloads(): Promise<void> {
  const { refreshDashboard, WARM_RANGES } = await import('./dashboard');
  const { refreshTokensPayload, WARM_TOKENS_SHORT_RANGES, WARM_TOKENS_LONG_RANGES } = await import('./tokens');
  const { refreshProjectList } = await import('./projects-list');
  const { refreshScrobblePayload } = await import('./scrobble');
  for (const range of WARM_RANGES) refreshDashboard(range);
  for (const range of [...WARM_TOKENS_SHORT_RANGES, ...WARM_TOKENS_LONG_RANGES]) refreshTokensPayload(range);
  await refreshProjectList();
  refreshScrobblePayload();
}
