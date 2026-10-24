import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from '../test/db-helper';

/**
 * Posts and settings, against a real migrated database.
 *
 * Both are thin, but each carries one rule a migration made necessary: a
 * post mirrors its content into the legacy NOT NULL content_text column and
 * sets created_at itself, and a setting is an upsert, never a duplicate.
 */

const db = createTestDb();
vi.mock('./schema', async (orig) => ({ ...(await orig() as object), getDb: () => db }));
const { createPost, getPosts, getPost, deletePost } = await import('./ingest-posts');
const { getSetting, setSetting, getAllSettings, deleteSetting } = await import('./ingest-settings');

beforeEach(() => {
  db.prepare('DELETE FROM posts').run();
  db.prepare('DELETE FROM settings').run();
});

describe('createPost', () => {
  it('stores every field and hands back the new row id', () => {
    const id = createPost({ title: 'Hello', description: 'd', source: 'manual', content: '# body', url: 'https://x.test/p' });
    const row = getPost(id)!;
    expect(row).toMatchObject({ id, title: 'Hello', description: 'd', source: 'manual', content: '# body', url: 'https://x.test/p' });
    expect(row.post_uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('mirrors content, else the description, else nothing, into content_text', () => {
    const text = (id: number) => (db.prepare('SELECT content_text FROM posts WHERE id = ?').get(id) as { content_text: string }).content_text;
    expect(text(createPost({ title: 'a', content: 'C', description: 'D' }))).toBe('C');
    expect(text(createPost({ title: 'b', description: 'D' }))).toBe('D');
    expect(text(createPost({ title: 'c' }))).toBe('');
  });

  it('stores absent optional fields as null, not as empty strings', () => {
    const row = getPost(createPost({ title: 'bare' }))!;
    expect(row).toMatchObject({ description: null, source: null, content: null, url: null });
  });

  it('gives every post its own uuid', () => {
    const a = getPost(createPost({ title: 'a' }))!;
    const b = getPost(createPost({ title: 'b' }))!;
    expect(a.post_uuid).not.toBe(b.post_uuid);
  });
});

describe('getPosts / deletePost', () => {
  it('lists newest first, paged', () => {
    const ids = ['one', 'two', 'three'].map((title) => createPost({ title }));
    ids.forEach((id, i) => db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(`2026-01-0${i + 1} 00:00:00`, id));
    expect(getPosts().map((p) => p.title)).toEqual(['three', 'two', 'one']);
    expect(getPosts(1, 1).map((p) => p.title)).toEqual(['two']);
  });

  it('deletes one post and leaves the rest', () => {
    const keep = createPost({ title: 'keep' });
    const drop = createPost({ title: 'drop' });
    deletePost(drop);
    expect(getPost(drop)).toBeUndefined();
    expect(getPost(keep)?.title).toBe('keep');
  });
});

describe('settings', () => {
  it('reads null for a key never set', () => {
    expect(getSetting('nope')).toBeNull();
  });

  it('overwrites in place rather than adding a second row', () => {
    setSetting('theme', 'dark');
    setSetting('theme', 'light');
    expect(getSetting('theme')).toBe('light');
    expect(db.prepare("SELECT COUNT(*) c FROM settings WHERE key = 'theme'").get()).toEqual({ c: 1 });
  });

  it('lists every setting as one object, and forgets a deleted one', () => {
    setSetting('a', '1');
    setSetting('b', '2');
    expect(getAllSettings()).toMatchObject({ a: '1', b: '2' });
    deleteSetting('a');
    expect(getSetting('a')).toBeNull();
    expect(getAllSettings()).not.toHaveProperty('a');
  });
});
