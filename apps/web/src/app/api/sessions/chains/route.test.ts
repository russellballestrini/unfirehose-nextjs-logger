import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { vi } from 'vitest';
import { createTestDb } from '@unturf/unfirehose/test/db-helper';

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));
const { GET } = await import('./route');

const req = (qs: string) => new NextRequest(new URL(`http://localhost:3000/api/sessions/chains${qs}`));

beforeEach(() => {
  db.exec('DELETE FROM session_chain');
  db.prepare(`INSERT INTO session_chain (session_uuid, state, breaks, first_break, anchor_state) VALUES
    ('a', 'verified', 0, NULL, 'intact'), ('b', 'corrupted', 2, 7, NULL), ('c', 'unchained', 0, NULL, 'rewritten')`).run();
});

describe('GET /api/sessions/chains', () => {
  it('answers many sessions at once and leaves out the unknown', async () => {
    const data = await (await GET(req('?ids=a,b,c,nobody, ,a'))).json();
    expect(data.chains).toEqual({
      a: { state: 'verified', anchor: 'intact', breaks: 0, firstBreak: null },
      b: { state: 'corrupted', anchor: null, breaks: 2, firstBreak: 7 },
      c: { state: 'unchained', anchor: 'rewritten', breaks: 0, firstBreak: null },
    });
  });

  it('is empty for no ids', async () => {
    expect(await (await GET(req(''))).json()).toEqual({ chains: {} });
  });
});
