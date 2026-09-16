import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb } from '@unturf/unfirehose/test/db-helper';

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));
const { GET } = await import('./route');

const req = (qs: string) => new NextRequest(new URL(`http://localhost:3000/api/sessions/rewrites${qs}`));

beforeEach(() => {
  db.exec('DELETE FROM session_rewrites; DELETE FROM sessions; DELETE FROM projects');
  const pid = db.prepare("INSERT INTO projects (name, display_name, path) VALUES ('claude:-p', '-p', '/p')").run().lastInsertRowid;
  db.prepare("INSERT INTO sessions (session_uuid, project_id, harness) VALUES ('s1', ?, 'claude-code'), ('s2', ?, 'hermes')").run(pid, pid);
  db.prepare(`INSERT INTO session_rewrites
    (session_uuid, harness, seq, kind, observed_at, file_lines, tail_distance, before_hash, after_hash, before_text, after_text,
     before_len, after_len, truncated, changed_keys, content_changed, before_type, after_type) VALUES
    ('s1', 'claude-code', 7, 'rewritten', datetime('now'), 10, 2, 'h1', 'h2', '{"a":1}', '{"a":2}', 7, 7, 0, '["message.content","message.usage"]', 1, 'assistant', 'assistant'),
    ('s2', 'hermes', 3, 'truncated', datetime('now', '-2 days'), 2, -2, 'h3', NULL, '{"b":1}', NULL, 7, NULL, 1, '[]', 0, 'user', NULL)`).run();
});

describe('GET /api/sessions/rewrites', () => {
  it('answers a summary of the window and the rows, newest first, project joined', async () => {
    const data = await (await GET(req('?hours=24'))).json();
    expect(data.summary).toEqual({
      total: 1, sessions: 1, byHarness: { 'claude-code': 1 }, maxTailDistance: 2,
      contentChanged: 1, metadataOnly: 0, truncations: 0, byChangedKey: { 'message.content': 1, 'message.usage': 1 },
    });
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({
      session_uuid: 's1', project: 'claude:-p', harness: 'claude-code', seq: 7, kind: 'rewritten',
      file_lines: 10, tail_distance: 2, before_hash: 'h1', after_hash: 'h2', before_text: '{"a":1}', after_text: '{"a":2}',
      before_len: 7, after_len: 7, truncated: false, changed_keys: ['message.content', 'message.usage'],
      content_changed: true, before_type: 'assistant', after_type: 'assistant',
    });
    expect(typeof data.rows[0].id).toBe('number');
    expect(typeof data.rows[0].observed_at).toBe('string');
  });

  it('widens the window and narrows by session and harness', async () => {
    const wide = await (await GET(req('?hours=72'))).json();
    expect(wide.rows.map((r: { session_uuid: string }) => r.session_uuid)).toEqual(['s1', 's2']);
    expect(wide.summary.truncations).toBe(1);
    const one = await (await GET(req('?hours=72&session=s2'))).json();
    expect(one.rows).toHaveLength(1);
    expect(one.rows[0]).toMatchObject({ kind: 'truncated', after_text: null, after_hash: null, truncated: true, changed_keys: [] });
    const h = await (await GET(req('?hours=72&harness=claude-code&limit=1'))).json();
    expect(h.rows.map((r: { harness: string }) => r.harness)).toEqual(['claude-code']);
  });
});
