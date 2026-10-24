import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb, seedProject, seedSession, seedMessage, seedContentBlock } from '@unturf/unfirehose/test/db-helper';
import { drainLedger } from '@unturf/unfirehose/db/action-ledger';

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));
const { GET, POST } = await import('./route');

const req = (qs: string) => new NextRequest(new URL(`http://localhost:3000/api/actions${qs}`));

let n = 0;
function call(sessionId: number, timestamp: string, toolName: string, input: unknown) {
  const id = seedMessage(db, sessionId, { uuid: `m-${++n}`, timestamp });
  seedContentBlock(db, id, { blockType: 'tool-call', toolName, toolInput: JSON.stringify(input), toolUseId: `toolu_${n}` });
}

beforeEach(() => {
  db.exec(`DELETE FROM action_ledger; DELETE FROM content_blocks; DELETE FROM messages; DELETE FROM sessions;
           DELETE FROM projects; DELETE FROM settings WHERE key LIKE 'action_ledger_%'`);
  const pid = seedProject(db, '-home-fox-git-api', 'api');
  const s = seedSession(db, pid, 'sess-1');
  db.prepare(`UPDATE sessions SET harness = 'claude-code' WHERE id = ?`).run(s);
  call(s, '2026-10-01T09:00:00Z', 'Read', { file_path: 'src/a.ts' });
  call(s, '2026-10-02T09:00:00Z', 'Bash', { command: 'rm -rf ~/.ssh' });
  call(s, '2026-10-03T09:00:00Z', 'WebFetch', { url: 'https://example.com/a,b' });
  drainLedger(db);
});

describe('GET /api/actions', () => {
  it('answers rows newest first, with their project and session for a link', async () => {
    const data = await (await GET(req(''))).json();
    expect(data.total).toBe(3);
    expect(data.rows.map((r: { kind: string }) => r.kind)).toEqual(['network', 'fs-write', 'fs-read']);
    expect(data.rows[1]).toMatchObject({
      tool: 'Bash', command: 'rm -rf ~/.ssh', flags: ['destructive'], projectName: '-home-fox-git-api',
      sessionUuid: 'sess-1', toolUseId: 'toolu_2', harness: 'claude-code',
    });
    expect(data.status).toMatchObject({ rows: 3, backfillRemaining: 0 });
    expect(data.kinds).toMatchObject({ network: 1, 'fs-write': 1, 'fs-read': 1, git: 0, shell: 0 });
  });

  it('filters and pages', async () => {
    expect((await (await GET(req('?flag=destructive'))).json()).total).toBe(1);
    expect((await (await GET(req('?kind=network&path=example.com'))).json()).total).toBe(1);
    expect((await (await GET(req('?project=-home-fox-git-api&session=sess-1&harness=claude-code'))).json()).total).toBe(3);
    expect((await (await GET(req('?project=missing'))).json()).rows).toEqual([]);
    const p1 = await (await GET(req('?limit=2'))).json();
    expect(p1.rows).toHaveLength(2);
    const p2 = await (await GET(req(`?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`))).json();
    expect(p2.rows.map((r: { tool: string }) => r.tool)).toEqual(['Read']);
  });

  it('exports CSV, quoting what needs it', async () => {
    const res = await GET(req('?format=csv'));
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    const text = await res.text();
    const lines = text.trim().split('\n');
    expect(lines[0]).toBe('timestamp,project,session,harness,tool,kind,flags,paths,command,reasons');
    expect(lines).toHaveLength(4);
    expect(text).toContain('"https://example.com/a,b"');
  });
});

describe('POST /api/actions', () => {
  it('rebuilds from content blocks', async () => {
    db.exec(`UPDATE action_ledger SET flags = '', flagged = 0`);
    const res = await (await POST(new NextRequest('http://localhost:3000/api/actions', { method: 'POST', body: JSON.stringify({ rebuild: true }) }))).json();
    expect(res).toMatchObject({ ok: true, rebuilt: true, rows: 3, done: true });
    expect((await (await GET(req('?flag=any'))).json()).total).toBe(1);
  });
});
