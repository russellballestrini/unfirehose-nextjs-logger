import { describe, it, expect, vi, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb, seedProject, seedSession, seedMessage, seedContentBlock } from '@/test/db-helper';

const db = createTestDb();

// Add missing migrations
try { db.exec('ALTER TABLE sessions ADD COLUMN display_name TEXT'); } catch { /* already exists */ }

vi.mock('@unfirehose/core/db/schema', () => ({ getDb: () => db }));

const { GET } = await import('./route');

function req(url: string) {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

describe('GET /api/thinking', () => {
  beforeAll(() => {
    const pid = seedProject(db, 'test-project', 'Test Project');
    const sid = seedSession(db, pid, 'sess-1');

    // User message (preceding prompt)
    const umid = seedMessage(db, sid, {
      type: 'user',
      timestamp: '2026-03-03T13:59:00Z',
    });
    seedContentBlock(db, umid, {
      blockType: 'text',
      textContent: 'What should we build?',
    });

    // Assistant message with thinking block
    const amid = seedMessage(db, sid, {
      type: 'assistant',
      timestamp: '2026-03-03T14:00:00Z',
      model: 'claude-opus-4-6',
    });
    seedContentBlock(db, amid, {
      blockType: 'thinking',
      textContent: 'Let me consider this problem carefully...',
    });
  });

  it('returns thinking excerpts across projects', async () => {
    const res = await GET(req('/api/thinking?limit=10'));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].thinking).toContain('Let me consider');
    expect(data.entries[0].precedingPrompt).toContain('What should we build');
  });

  it('filters by search text', async () => {
    const res = await GET(req('/api/thinking?search=nonexistent&limit=10'));
    const data = await res.json();
    expect(data.entries).toHaveLength(0);
  });
});
