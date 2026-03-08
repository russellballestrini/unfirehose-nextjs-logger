/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb } from '@/test/db-helper';

const db = createTestDb();

vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));
vi.mock('@unturf/unfirehose/db/ingest', () => ({
  getAllSettings: () => {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.value;
    return map;
  },
  setSetting: (key: string, value: string) => {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')").run(key, value);
  },
  deleteSetting: (key: string) => {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  },
}));

vi.mock('os', () => ({ userInfo: () => ({ username: 'testuser' }) }));

const { GET, POST, DELETE: DELETE_handler } = await import('./route');

function req(url: string, opts?: { method?: string; body?: any }) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method: opts?.method ?? 'GET',
    ...(opts?.body ? { body: JSON.stringify(opts.body), headers: { 'Content-Type': 'application/json' } } : {}),
  });
}

beforeEach(() => {
  db.exec('DELETE FROM settings');
});

describe('GET /api/settings', () => {
  it('returns empty settings with system username', async () => {
    const res = await GET();
    const data = await res.json();
    expect(data._system_username).toBe('testuser');
  });

  it('returns saved settings', async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('theme_accent_color', '#ff0000')").run();
    const res = await GET();
    const data = await res.json();
    expect(data.theme_accent_color).toBe('#ff0000');
  });
});

describe('POST /api/settings', () => {
  it('sets a setting', async () => {
    const res = await POST(req('/api/settings', {
      method: 'POST',
      body: { action: 'set', key: 'test_key', value: 'test_value' },
    }));
    const data = await res.json();
    expect(data.ok).toBe(true);

    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('test_key') as any;
    expect(row.value).toBe('test_value');
  });

  it('overwrites existing setting', async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('existing', 'old')").run();
    await POST(req('/api/settings', {
      method: 'POST',
      body: { action: 'set', key: 'existing', value: 'new' },
    }));
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('existing') as any;
    expect(row.value).toBe('new');
  });

  it('deletes a setting via action', async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('to_delete', 'bye')").run();
    await POST(req('/api/settings', {
      method: 'POST',
      body: { action: 'delete', key: 'to_delete' },
    }));
    const row = db.prepare('SELECT * FROM settings WHERE key = ?').get('to_delete');
    expect(row).toBeUndefined();
  });
});

describe('DELETE /api/settings', () => {
  it('deletes a setting', async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('del_key', 'val')").run();
    const res = await DELETE_handler(req('/api/settings', {
      method: 'DELETE',
      body: { key: 'del_key' },
    }));
    const data = await res.json();
    expect(data.ok).toBe(true);
  });
});
