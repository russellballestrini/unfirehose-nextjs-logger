import { describe, it, expect, vi, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb, seedProject, seedSession, seedMessage, seedContentBlock } from '@/test/db-helper';

const db = createTestDb();

// Add missing migrations
try { db.exec('ALTER TABLE sessions ADD COLUMN display_name TEXT'); } catch { /* already exists */ }

vi.mock('@sexy-logger/core/db/schema', () => ({ getDb: () => db }));

const { GET } = await import('./route');

function req(url: string) {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

describe('GET /api/logs', () => {
  beforeAll(() => {
    // Seed test data
    const pid = seedProject(db, 'test-project', 'Test Project');
    const sid = seedSession(db, pid, 'sess-1');

    // User message
    const umid = seedMessage(db, sid, {
      type: 'user',
      timestamp: '2026-03-03T13:59:00Z',
    });
    seedContentBlock(db, umid, {
      blockType: 'text',
      textContent: 'What should we build?',
    });

    // Assistant message
    const amid = seedMessage(db, sid, {
      type: 'assistant',
      timestamp: '2026-03-03T14:00:00Z',
      model: 'claude-opus-4-6',
    });
    seedContentBlock(db, amid, {
      blockType: 'text',
      textContent: 'Let me think about that.',
    });
  });

  it('returns aggregated log entries', async () => {
    const res = await GET(req('/api/logs'));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.entries.length).toBeGreaterThanOrEqual(1);
  });

  it('respects limit parameter', async () => {
    const res = await GET(req('/api/logs?limit=1'));
    const data = await res.json();
    expect(data.entries.length).toBeLessThanOrEqual(1);
  });
});
