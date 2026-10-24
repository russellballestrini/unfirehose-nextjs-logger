import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedProject } from '../test/db-helper';
import { getOrCreateSession, insertMessage, insertContentBlocks } from './ingest-rows';
import { backfillLedger, drainLedger, ledgerCursors, ledgerStatus, queryLedger, rebuildLedger, scanLedgerHead } from './action-ledger';
import { SECRET_ALERTS_SINCE_KEY, secretAlertsSince } from './secret-alerts';
import { deliverDue, createRule, memorySecretStore, listRules } from './alert-delivery';
import type { OutboundRequest } from '../alert-delivery';

/**
 * Credentials found at ingest become alerts, once, naming kind, session,
 * project and time and never the value. Fixtures are assembled at runtime
 * so no literal credential sits in the source.
 */

const ant = 'sk-ant-' + 'api03-' + 'Zq8xW2vB7nM4kL9pR3tY6uE1oA5sD0fG';
const gh = 'ghp' + '_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const pem = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';

let db: Database.Database;
let seq = 0;
const SINCE = '2026-10-20T00:00:00.000Z';

function session(projectName: string, uuid: string, display = projectName) {
  const existing = db.prepare('SELECT id FROM projects WHERE name = ?').get(projectName) as { id: number } | undefined;
  const projectId = existing?.id ?? seedProject(db, projectName, display);
  return getOrCreateSession(db, uuid, projectId, { harness: 'claude-code', createdAt: '2026-10-01T00:00:00Z' });
}

/** An assistant tool call and, when given, the user message carrying its result. */
function turn(sessionId: number, timestamp: string, tool: string, input: unknown, output?: string) {
  const callId = `toolu_${++seq}`;
  const m = insertMessage(db, sessionId, { role: 'assistant', id: `m-${seq}`, timestamp, model: 'demo-model' });
  insertContentBlocks(db, m!, [{ type: 'tool-call', toolCallId: callId, toolName: tool, input }]);
  if (output !== undefined) {
    const u = insertMessage(db, sessionId, { role: 'user', id: `u-${seq}`, timestamp, model: null });
    insertContentBlocks(db, u!, [{ type: 'tool-result', toolCallId: callId, output }]);
  }
  return callId;
}

const alerts = () => db.prepare(`SELECT * FROM alerts WHERE alert_type = 'secret_exposed' ORDER BY id`).all() as Array<{
  id: number; metric: string; window_minutes: number; actual_value: number; project_name: string | null; details: string;
}>;

/** Feature "landed" at SINCE, before any of these lines. */
function landed() {
  ledgerCursors(db);
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(SECRET_ALERTS_SINCE_KEY, SINCE);
}

beforeEach(() => {
  db = createTestDb();
  seq = 0;
});

describe('credentials seen at ingest', () => {
  it('raises one alert for a credential in a tool result, naming kind, session, project and time only', () => {
    landed();
    const s = session('-home-fox-git-api', 'sess-a', 'api');
    const callId = turn(s, '2026-10-24T10:00:00Z', 'Bash', { command: 'cat .env' }, `ANTHROPIC_API_KEY=${ant}\nPORT=3000\n`);
    const r = scanLedgerHead(db);
    expect(r.alerts).toBe(1);
    expect(r.secrets).toBe(1);

    const [a] = alerts();
    expect(a).toMatchObject({ metric: 'secret', window_minutes: 0, actual_value: 1, project_name: '-home-fox-git-api' });
    expect(JSON.parse(a.details)).toEqual({
      kinds: ['anthropic_key'], location: 'result', tool: 'Bash', session: 'sess-a',
      project: '-home-fox-git-api', projectDisplay: 'api', harness: 'claude-code',
      seenAt: '2026-10-24T10:00:00Z', blockId: expect.any(Number), toolUseId: callId,
    });
    // Operation Voyeur: no trace of the value anywhere we wrote.
    const everything = JSON.stringify([
      db.prepare('SELECT * FROM alerts').all(),
      db.prepare('SELECT * FROM secret_sightings').all(),
      db.prepare('SELECT * FROM action_ledger').all(),
    ]);
    expect(everything).not.toContain(ant);
    expect(everything).not.toContain(ant.slice(-12));

    // The ledger row of the call that printed it is flagged.
    const row = queryLedger(db, { flag: 'secret-in-output' }).rows[0];
    expect(row).toMatchObject({ tool: 'Bash', command: 'cat .env', flags: ['secret-in-output'] });
    expect(row.reasons).toContain('its output carried a credential (anthropic_key)');
  });

  it('raises for a credential in a tool call: a file written, a command line, an MCP tool', () => {
    landed();
    const s = session('-home-fox-git-api', 'sess-a');
    turn(s, '2026-10-24T10:00:00Z', 'Write', { file_path: '/home/fox/git/api/.env', content: `GITHUB_TOKEN=${gh}\n` });
    const t = session('-home-fox-git-web', 'sess-b');
    turn(t, '2026-10-24T10:01:00Z', 'mcp__linear__create_issue', { title: 'x', description: pem });
    expect(scanLedgerHead(db).alerts).toBe(2);
    const details = alerts().map((a) => JSON.parse(a.details));
    expect(details.map((d) => [d.location, d.tool, d.kinds])).toEqual([
      ['call', 'Write', ['github_token']],
      ['call', 'mcp__linear__create_issue', ['private_key']],
    ]);
    const mcp = queryLedger(db, { tool: 'mcp__linear__create_issue' }).rows[0];
    expect(mcp).toMatchObject({ kind: 'network', flags: ['secret-in-command'] });
    expect(mcp.reasons).toBe('sends a credential (private_key) to MCP server linear');
  });

  it('never alerts twice for one line: re-scan, backfill and a ledger rebuild find it already seen', () => {
    landed();
    const s = session('-home-fox-git-api', 'sess-a');
    turn(s, '2026-10-24T10:00:00Z', 'Bash', { command: 'env' }, `GH=${gh}`);
    expect(scanLedgerHead(db).alerts).toBe(1);
    expect(scanLedgerHead(db).alerts).toBe(0);
    drainLedger(db);
    rebuildLedger(db);
    expect(drainLedger(db).alerts).toBe(0);
    expect(alerts()).toHaveLength(1);
    // Rebuilt ledger still carries the output flag, from the kept sighting.
    expect(queryLedger(db, { flag: 'secret-in-output' }).total).toBe(1);
  });

  it('joins a second sighting of the same kind in the same session to the open alert', () => {
    landed();
    const s = session('-home-fox-git-api', 'sess-a');
    turn(s, '2026-10-24T10:00:00Z', 'Bash', { command: 'cat .env' }, `KEY=${ant}`);
    turn(s, '2026-10-24T10:05:00Z', 'Read', { file_path: '.env' }, `KEY=${ant}`);
    turn(s, '2026-10-24T10:06:00Z', 'Read', { file_path: 'id' }, pem);
    expect(scanLedgerHead(db).alerts).toBe(2);
    const [first, second] = alerts();
    expect(first.actual_value).toBe(2);
    expect(JSON.parse(second.details).kinds).toEqual(['private_key']);

    // Another session is its own alert; a cleared alert lets the next one through.
    const t = session('-home-fox-git-api', 'sess-b');
    turn(t, '2026-10-24T11:00:00Z', 'Bash', { command: 'env' }, `KEY=${ant}`);
    expect(scanLedgerHead(db).alerts).toBe(1);
    db.prepare('DELETE FROM alerts').run();
    turn(t, '2026-10-24T11:30:00Z', 'Bash', { command: 'env' }, `KEY=${ant}`);
    expect(scanLedgerHead(db).alerts).toBe(1);
  });

  it('flags history without alerting: lines older than the feature, and everything the backfill reads', () => {
    const s = session('-home-fox-git-api', 'sess-old');
    // History that exists before the scanner first runs.
    turn(s, '2026-10-24T09:00:00Z', 'Bash', { command: 'cat .env' }, `KEY=${ant}`);
    ledgerCursors(db);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(SECRET_ALERTS_SINCE_KEY, SINCE);
    // A first ingest of an old ~/.claude: new block ids, old timestamps.
    turn(s, '2026-03-01T09:00:00Z', 'Bash', { command: 'printenv' }, `KEY=${gh}`);
    expect(scanLedgerHead(db).alerts).toBe(0);
    let b;
    do { b = backfillLedger(db); expect(b.alerts).toBe(0); } while (!b.done);

    expect(alerts()).toHaveLength(0);
    const seen = db.prepare('SELECT kinds, backfilled, alert_id FROM secret_sightings ORDER BY block_id').all();
    expect(seen).toEqual([
      { kinds: 'anthropic_key', backfilled: 1, alert_id: null },
      { kinds: 'github_token', backfilled: 0, alert_id: null },
    ]);
    expect(queryLedger(db, { flag: 'secret-in-output' }).total).toBe(2);
    expect(ledgerStatus(db).secrets).toEqual({ sightings: 2, alerted: 0, since: SINCE });
  });

  it('starts the clock the first time it runs and keeps it', () => {
    const first = secretAlertsSince(db, new Date('2026-10-24T12:00:00Z'));
    expect(first).toBe('2026-10-24T12:00:00.000Z');
    expect(secretAlertsSince(db, new Date('2027-01-01T00:00:00Z'))).toBe(first);
  });

  it('flags the call even when its output is read first, as the newest-first backfill does', () => {
    const s = session('-home-fox-git-api', 'sess-a');
    const callId = turn(s, '2026-10-01T10:00:00Z', 'Bash', { command: 'cat creds' }, pem);
    ledgerCursors(db);
    const resultBlock = (db.prepare(`SELECT id FROM content_blocks WHERE block_type = 'tool-result'`).get() as { id: number }).id;
    // A window holding the result only, then one holding the call.
    backfillLedger(db, { window: (ledgerCursors(db).below - 1) - resultBlock + 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM secret_sightings').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM action_ledger').get()).toEqual({ n: 0 });
    drainLedger(db);
    const row = db.prepare('SELECT flags, tool_use_id FROM action_ledger').get();
    expect(row).toEqual({ flags: 'secret-in-output', tool_use_id: callId });
  });

  it('leaves ordinary output alone', () => {
    landed();
    const s = session('-home-fox-git-api', 'sess-a');
    turn(s, '2026-10-24T10:00:00Z', 'Bash', { command: 'ls' }, 'README.md\nsrc\npackage.json\n');
    turn(s, '2026-10-24T10:00:01Z', 'Read', { file_path: 'a.ts' }, 'const apiKey = process.env.API_KEY;\n');
    expect(scanLedgerHead(db)).toMatchObject({ secrets: 0, alerts: 0 });
  });
});

describe('credential alerts through delivery', () => {
  it('sends kind, where, session, project and time to Slack, and no value', async () => {
    landed();
    const store = memorySecretStore();
    const r = createRule(db, store, {
      destination: 'slack', secrets: { webhookUrl: 'https://hooks.slack.com/services/T/B/x' }, match: { metric: 'secret' },
    }, new Date('2026-10-24T09:00:00Z'));
    expect(r.ok).toBe(true);
    const s = session('-home-fox-git-api', 'sess-a', 'api');
    turn(s, '2026-10-24T10:00:00Z', 'Bash', { command: 'cat .env' }, `KEY=${ant}`);
    // A usage alert at the same time: this rule matches credentials only.
    db.prepare(`INSERT INTO alerts (alert_type, window_minutes, metric, threshold_value, actual_value) VALUES ('threshold_breach', 15, 'output_tokens', 10, 20)`).run();
    scanLedgerHead(db);

    const sent: OutboundRequest[] = [];
    const out = await deliverDue(db, store, async (req) => { sent.push(req); return { status: 200 }; }, new Date('2026-10-24T10:01:00Z'));
    expect(out.sent).toBe(1);
    const body = JSON.parse(sent[0].body);
    expect(body.text).toContain('Anthropic key seen in api');
    const fields = body.blocks.find((b: { fields?: unknown }) => b.fields).fields.map((f: { text: string }) => f.text);
    expect(fields).toEqual([
      '*Kind*\nAnthropic key', '*Where*\na tool result of Bash', '*Project*\napi', '*Session*\nsess-a', '*Seen at*\n2026-10-24T10:00:00Z',
    ]);
    expect(sent[0].body).not.toContain(ant);
    expect(listRules(db, store)[0].match.metric).toBe('secret');
  });

  it('a project rule matches a credential alert by encoded or display name', async () => {
    landed();
    const store = memorySecretStore();
    const at = new Date('2026-10-24T09:00:00Z');
    createRule(db, store, { destination: 'webhook', config: { url: 'http://127.0.0.1:9/a' }, match: { project: 'api' } }, at);
    createRule(db, store, { destination: 'webhook', config: { url: 'http://127.0.0.1:9/b' }, match: { project: '-home-fox-git-api' } }, at);
    createRule(db, store, { destination: 'webhook', config: { url: 'http://127.0.0.1:9/c' }, match: { project: 'web' } }, at);
    const s = session('-home-fox-git-api', 'sess-a', 'api');
    turn(s, '2026-10-24T10:00:00Z', 'Bash', { command: 'env' }, `KEY=${gh}`);
    scanLedgerHead(db);
    const urls: string[] = [];
    await deliverDue(db, store, async (req) => { urls.push(req.url); return { status: 204 }; }, new Date('2026-10-24T10:01:00Z'));
    expect(urls.sort()).toEqual(['http://127.0.0.1:9/a', 'http://127.0.0.1:9/b']);
  });
});
