import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';

/**
 * Files attached to a todo.
 *
 * The blob store is content-addressed and shared: an attachment and a
 * rescued tool result can be the same bytes under the same name. That makes
 * deletion the interesting half — the row goes, and the file only goes when
 * nothing else is holding it. A tool result's payload is unrecoverable once
 * Claude Code's thirty-day sweep removes the on-disk original, so it counts
 * as a holder even though it is not an attachment.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unfirehose-attach-'));
vi.mock('@unturf/unfirehose/db/schema', () => ({
  UNFIREHOSE_DIR: dir,
  getDb: () => db,
}));

/** A tiny stand-in for the two tables this route touches. */
let attachments: Array<{ id: number; todo_id: number; filename: string; mime_type: string; size_bytes: number; hash: string; created_at: string }>;
let toolResultHashes: string[];
let nextId: number;
let dbThrows: string | null;

const db = {
  prepare(sql: string) {
    if (dbThrows) throw new Error(dbThrows);
    return {
      run: (...a: unknown[]) => {
        if (sql.includes('INSERT INTO todo_attachments')) {
          const [todo_id, filename, mime_type, size_bytes, hash, created_at] = a as [number, string, string, number, string, string];
          attachments.push({ id: nextId, todo_id, filename, mime_type, size_bytes, hash, created_at });
          return { lastInsertRowid: nextId++ };
        }
        if (sql.includes('DELETE FROM todo_attachments')) {
          attachments = attachments.filter((r) => r.id !== a[0]);
        }
        return { lastInsertRowid: 0 };
      },
      get: (...a: unknown[]) => {
        if (sql.includes('SELECT hash FROM todo_attachments')) return attachments.find((r) => r.id === a[0]);
        if (sql.includes('COUNT(*)')) {
          // Count only the tables the statement actually names. Counting
          // both regardless would let a query that forgot tool_results pass
          // this suite while deleting blobs nothing can rebuild.
          const hash = a[0] as string;
          let c = 0;
          if (sql.includes('FROM todo_attachments')) c += attachments.filter((r) => r.hash === hash).length;
          if (sql.includes('FROM tool_results')) c += toolResultHashes.filter((h) => h === hash).length;
          return { c };
        }
        return undefined;
      },
      all: (...a: unknown[]) =>
        attachments.filter((r) => r.todo_id === a[0]).sort((x, y) => y.created_at.localeCompare(x.created_at)),
    };
  },
};

const { POST, GET, DELETE } = await import('./route');

/** A File the route can read, without needing a browser. */
const file = (name: string, body: string, type = 'text/plain') =>
  ({ name, type, size: Buffer.byteLength(body), arrayBuffer: async () => Buffer.from(body) }) as unknown as File;

const upload = (todoId: unknown, files: File[]) =>
  POST({
    formData: async () => ({
      get: () => todoId,
      getAll: () => files,
    }),
  } as never);

const list = (query: string) =>
  GET({ nextUrl: new URL(`http://localhost:3000/api/todos/attachments${query}`) } as never);

const remove = (body: unknown) => DELETE({ json: async () => body } as never);

const sha = (s: string) => createHash('sha256').update(Buffer.from(s)).digest('hex');
const onDisk = (h: string) => fs.existsSync(path.join(dir, 'attachments', h));

beforeEach(() => { attachments = []; toolResultHashes = []; nextId = 1; dbThrows = null; });
afterEach(() => { vi.restoreAllMocks(); });

describe('uploading', () => {
  it('stores a file and answers with the row it made', async () => {
    const res = await upload(7, [file('notes.txt', 'hello')]);
    expect(res.status).toBe(200);
    const { attachments: made } = await res.json();
    expect(made[0]).toMatchObject({ todoId: 7, filename: 'notes.txt', mimeType: 'text/plain', sizeBytes: 5 });
    expect(onDisk(sha('hello'))).toBe(true);
  });

  it('names the file by its own hash, so the same bytes are stored once', async () => {
    // Two todos with the same screenshot attached is the common case.
    await upload(1, [file('a.txt', 'same bytes')]);
    await upload(2, [file('b-different-name.txt', 'same bytes')]);
    expect(fs.readdirSync(path.join(dir, 'attachments')).filter((f) => f === sha('same bytes'))).toHaveLength(1);
    expect(attachments).toHaveLength(2);
  });

  it('accepts several files in one request', async () => {
    const { attachments: made } = await (await upload(1, [file('a.txt', 'a'), file('b.txt', 'b')])).json();
    expect(made).toHaveLength(2);
  });

  it('refuses without a todo to attach to', async () => {
    const res = await upload(null, [file('a.txt', 'a')]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('todoId required');
  });

  it('refuses a request carrying no files', async () => {
    expect((await upload(1, [])).status).toBe(400);
  });

  it('refuses an oversized file, and names it and its size', async () => {
    // The message is what the page shows. Which file, and how far over, are
    // the two things a person needs in order to act.
    const big = { name: 'huge.bin', type: '', size: 11 * 1024 * 1024, arrayBuffer: async () => Buffer.alloc(0) } as unknown as File;
    const res = await upload(1, [big]);
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain('huge.bin');
    expect(error).toContain(String(11 * 1024 * 1024));
  });

  it('checks every file before writing any of them', async () => {
    // A batch that is half-accepted leaves rows pointing at a request the
    // caller was told had failed.
    const big = { name: 'huge.bin', type: '', size: 11 * 1024 * 1024, arrayBuffer: async () => Buffer.alloc(0) } as unknown as File;
    await upload(1, [file('small.txt', 'fine'), big]);
    expect(attachments).toHaveLength(0);
    expect(onDisk(sha('fine'))).toBe(false);
  });

  it('gives a file with no declared type one anyway', async () => {
    // An empty mime type in a Content-Type header makes a download fail.
    await upload(1, [file('mystery', 'x', '')]);
    expect(attachments[0].mime_type).toBe('application/octet-stream');
  });

  it('reports a database that will not take the row', async () => {
    dbThrows = 'database is locked';
    const res = await upload(1, [file('a.txt', 'a')]);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('database is locked');
  });
});

describe('listing', () => {
  it('returns what is attached to one todo, newest first', async () => {
    attachments = [
      { id: 1, todo_id: 5, filename: 'old.txt', mime_type: 'text/plain', size_bytes: 1, hash: 'h1', created_at: '2026-01-01T00:00:00Z' },
      { id: 2, todo_id: 5, filename: 'new.txt', mime_type: 'text/plain', size_bytes: 1, hash: 'h2', created_at: '2026-09-01T00:00:00Z' },
      { id: 3, todo_id: 6, filename: 'other.txt', mime_type: 'text/plain', size_bytes: 1, hash: 'h3', created_at: '2026-09-02T00:00:00Z' },
    ];
    const body = await (await list('?todoId=5')).json();
    expect(body.attachments.map((a: { filename: string }) => a.filename)).toEqual(['new.txt', 'old.txt']);
  });

  it('refuses without a todo', async () => {
    expect((await list('')).status).toBe(400);
  });

  it('returns an empty list for a todo with nothing attached', async () => {
    expect((await (await list('?todoId=99')).json()).attachments).toEqual([]);
  });
});

describe('deleting', () => {
  it('removes the row and the file when nothing else holds it', async () => {
    await upload(1, [file('once.txt', 'only copy')]);
    const res = await remove({ id: 1 });
    expect(res.status).toBe(200);
    expect(attachments).toHaveLength(0);
    expect(onDisk(sha('only copy'))).toBe(false);
  });

  it('keeps the file while another attachment still points at it', async () => {
    // Deleting one of two todos' copy of the same screenshot must not blank
    // the other one.
    await upload(1, [file('a.txt', 'shared bytes')]);
    await upload(2, [file('b.txt', 'shared bytes')]);
    await remove({ id: 1 });
    expect(onDisk(sha('shared bytes'))).toBe(true);
  });

  it('keeps the file while a tool result still needs it', async () => {
    // tool_results shares this store and its payloads are unrecoverable
    // once Claude Code's thirty-day sweep removes the on-disk original.
    // Counting only attachments here would delete data nothing can rebuild.
    await upload(1, [file('a.txt', 'rescued payload')]);
    toolResultHashes = [sha('rescued payload')];
    await remove({ id: 1 });
    expect(attachments).toHaveLength(0);
    expect(onDisk(sha('rescued payload'))).toBe(true);
  });

  it('refuses without an id', async () => {
    expect((await remove({})).status).toBe(400);
  });

  it('says an attachment is not there rather than reporting success', async () => {
    const res = await remove({ id: 404 });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('attachment not found');
  });
});
