import { getDb } from './schema';

// === Posts (jsonblog.org schema) ===

export function createPost(opts: {
  title: string;
  description?: string;
  source?: string;
  content?: string;
  url?: string;
}): number {
  const db = getDb();
  const uuid = crypto.randomUUID();
  // content_text is the legacy NOT NULL column on existing DBs; mirror content into it.
  const contentText = opts.content ?? opts.description ?? '';
  // created_at lacks a column-level default on existing DBs (SQLite forbids non-constant
  // defaults on ALTER ADD COLUMN), so set it explicitly here.
  const result = db.prepare(
    `INSERT INTO posts (post_uuid, title, description, source, content, content_text, url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    uuid,
    opts.title,
    opts.description ?? null,
    opts.source ?? null,
    opts.content ?? null,
    contentText,
    opts.url ?? null,
  );
  return result.lastInsertRowid as number;
}

export function getPosts(limit = 50, offset = 0) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM posts ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset) as PostRow[];
}

export function getPost(id: number) {
  const db = getDb();
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as PostRow | undefined;
}

export function deletePost(id: number) {
  const db = getDb();
  db.prepare('DELETE FROM posts WHERE id = ?').run(id);
}

export interface PostRow {
  id: number;
  post_uuid: string;
  title: string;
  description: string | null;
  source: string | null;
  content: string | null;
  url: string | null;
  created_at: string;
  updated_at: string;
}
