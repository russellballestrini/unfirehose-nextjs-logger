import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';
import path from 'path';
import { createTestDb } from '@unturf/unfirehose/test/db-helper';

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));

const files = new Map<string, string>();
vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (!files.has(p)) throw new Error('ENOENT');
    return files.get(p)!;
  }),
}));

vi.mock('@unturf/unfirehose/session-paths', () => ({
  harnessFor: () => ({
    adapter: { name: 'mock', sessionFile: (slug: string, id: string) => `/mock/${slug}/${id}.jsonl` },
    slug: 'proj',
  }),
}));

const { GET } = await import('./route');
const { SessionChainTracker } = await import('@unturf/unfirehose/db/provenance-ingest');

const KAT = path.resolve(__dirname, '../../../../../../../../packages/schema/fixtures/chain-kat.jsonl');
type Vector = { kind: string; label: string; lines: string[]; expect: Record<string, unknown> };
const vectors: Vector[] = readFileSync(KAT, 'utf8').split('\n')
  .filter((l) => l.trim() && !l.startsWith('#')).map((l) => JSON.parse(l)).filter((r) => r.kind === 'session');
const vector = (label: string) => vectors.find((v) => v.label === label)!;

const req = (url: string) => new NextRequest(new URL(url, 'http://localhost:3000'));
const call = (id: string, qs = '') => GET(req(`/api/sessions/${id}/chain${qs}`), { params: Promise.resolve({ sessionId: id }) });

beforeEach(() => {
  files.clear();
  db.exec('DELETE FROM session_chain; DELETE FROM session_chain_leaves;');
});

describe('GET /api/sessions/:sessionId/chain', () => {
  it('is unchained with no recorded row and no live check', async () => {
    const res = await call('nobody');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: 'nobody', recorded: null, state: 'unchained', events: [] });
  });

  it('returns the verdict ingest recorded', async () => {
    const v = vector('corrupted/edited-body');
    const t = new SessionChainTracker(db, 'rec', { reset: true });
    for (const l of v.lines) t.feed(l);
    t.flush();
    const data = await (await call('rec')).json();
    expect(data.state).toBe('corrupted');
    expect(data.recorded.first_break).toBe(v.expect.first_break);
    expect(data.recorded.first_break_reason).toBe(v.expect.first_break_reason);
    // Every break the verifier hit rides along as its own event.
    expect(data.events.length).toBe(data.recorded.breaks);
    expect(data.events[0]).toMatchObject({ seq: v.expect.first_break, kind: v.expect.first_break_reason });
  });

  it('live=1 needs a project', async () => {
    expect((await call('x', '?live=1')).status).toBe(400);
  });

  it('live=1 recomputes from the file and sets aside a partial tail', async () => {
    const v = vector('verified/n=3');
    files.set('/mock/proj/live.jsonl', v.lines.join('\n') + '\n' + '{"type":"message","half');
    const data = await (await call('live', '?project=p&live=1')).json();
    expect(data.state).toBe('verified');
    expect(data.live.partialTail).toBe(true);
    expect(data.live.breaks).toBe(0);
    expect(data.live.root_computed).toBe(v.expect.root_expected);
    expect(data.live.entries).toBe(v.lines.length);
  });

  it('live=1 on a missing file is 404 and still carries the recorded verdict', async () => {
    const res = await call('gone', '?project=p&live=1');
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.state).toBe('unchained');
    expect(data.live).toBeNull();
  });

  it('live=1 names a break the recorded row does not know about yet', async () => {
    const v = vector('corrupted/deleted-line');
    files.set('/mock/proj/fresh.jsonl', v.lines.join('\n') + '\n');
    const data = await (await call('fresh', '?project=p&live=1')).json();
    expect(data.recorded).toBeNull();
    expect(data.state).toBe('corrupted');
    expect([data.live.first_break, data.live.first_break_reason]).toEqual([v.expect.first_break, v.expect.first_break_reason]);
  });
});
