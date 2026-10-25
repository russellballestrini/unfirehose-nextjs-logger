import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { createTestDb, seedProject, seedSession } from '@unturf/unfirehose/test/db-helper';

/**
 * Pushing todos into a session: the route appends a TodoWrite tool call and
 * its result to the session's JSONL, so a re-ingest reads them as native,
 * and writes the todos straight into the table so the board shows them now.
 * Against a real database and a real file in a temp directory.
 */
const db = createTestDb();
const dir = mkdtempSync(path.join(tmpdir(), 'inject-'));
const sessionFile = (project: string, id: string) => path.join(dir, `${project}--${id}.jsonl`);

vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));
vi.mock('@unturf/unfirehose/session-paths', () => ({ resolveSessionFile: sessionFile }));

const { POST } = await import('./route');

const SESSION = 'sess-1';
let projectId: number;
let sessionId: number;

const inject = (body: unknown, id = SESSION) =>
  POST(new NextRequest(`http://localhost/api/sessions/${id}/inject`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ sessionId: id }) });

beforeEach(() => {
  db.exec('DELETE FROM todo_events; DELETE FROM todos; DELETE FROM sessions; DELETE FROM projects;');
  projectId = seedProject(db, '-home-demo', 'demo');
  sessionId = seedSession(db, projectId, SESSION);
  writeFileSync(sessionFile('-home-demo', SESSION), '{"type":"user"}');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('POST /api/sessions/[sessionId]/inject', () => {
  it('appends a TodoWrite call and its result to the session file', async () => {
    const res = await inject({ todos: [{ content: '  write tests  ' }, { content: 'ship', status: 'in_progress' }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, injected: 2, file: sessionFile('-home-demo', SESSION) });

    const lines = readFileSync(sessionFile('-home-demo', SESSION), 'utf8').split('\n');
    expect(lines[0]).toBe('{"type":"user"}');
    const call = JSON.parse(lines[1]);
    const result = JSON.parse(lines[2]);
    expect(call.type).toBe('assistant');
    expect(call.message.content[0]).toMatchObject({
      type: 'tool_use', name: 'TodoWrite',
      input: { todos: [{ content: 'write tests', status: 'pending' }, { content: 'ship', status: 'in_progress' }] },
    });
    expect(call.message.content[0].id).toMatch(/^toolu_inject_[0-9a-f]{20}$/);
    expect(result).toMatchObject({ type: 'result', tool_use_id: call.message.content[0].id, is_error: false });
  });

  it('writes each todo, and its first event, so the board shows it before any re-ingest', async () => {
    const { ids } = await (await inject({ todos: [{ content: 'a' }, { content: 'b', status: 'completed' }] })).json();
    expect(ids).toHaveLength(2);
    const rows = db.prepare('SELECT project_id, session_id, content, status, source, source_session_uuid FROM todos ORDER BY id').all();
    expect(rows).toEqual([
      { project_id: projectId, session_id: sessionId, content: 'a', status: 'pending', source: 'manual', source_session_uuid: SESSION },
      { project_id: projectId, session_id: sessionId, content: 'b', status: 'completed', source: 'manual', source_session_uuid: SESSION },
    ]);
    expect(db.prepare('SELECT todo_id, old_status, new_status FROM todo_events ORDER BY todo_id').all()).toEqual([
      { todo_id: ids[0], old_status: null, new_status: 'pending' },
      { todo_id: ids[1], old_status: null, new_status: 'completed' },
    ]);
  });

  it('refuses a missing or empty todos list, or one with no content in it', async () => {
    for (const body of [{}, { todos: 'x' }, { todos: [] }]) {
      const res = await inject(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('todos array required');
    }
    const blank = await inject({ todos: [{ content: '   ' }, {}] });
    expect(blank.status).toBe(400);
    expect((await blank.json()).error).toBe('no valid todos');
    expect(readFileSync(sessionFile('-home-demo', SESSION), 'utf8')).toBe('{"type":"user"}');
  });

  it('answers 404 for a session it does not know, or whose file is gone', async () => {
    const unknown = await inject({ todos: [{ content: 'a' }] }, 'no-such-session');
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toBe('session not found');
    rmSync(sessionFile('-home-demo', SESSION));
    const gone = await inject({ todos: [{ content: 'a' }] });
    expect(gone.status).toBe(404);
    expect((await gone.json()).error).toBe('session file not found on disk');
    expect(db.prepare('SELECT COUNT(*) c FROM todos').get()).toEqual({ c: 0 });
  });
});
