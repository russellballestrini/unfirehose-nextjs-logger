import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb, seedProject, seedSession, seedMessage } from '@unturf/unfirehose/test/db-helper';
import { freezeBatch } from '@unturf/unfirehose/db/block-cold';

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));

const { GET, POST } = await import('./route');

const post = (body: unknown) => POST(new NextRequest('http://localhost/api/db/retention', { method: 'POST', body: JSON.stringify(body) }));
const DAY = 86_400_000;

beforeEach(() => {
  for (const t of ['content_blocks_cold', 'content_blocks', 'messages', 'sessions', 'projects', 'settings']) db.prepare(`DELETE FROM ${t}`).run();
  const s = seedSession(db, seedProject(db));
  for (let i = 0; i < 4; i++) {
    const m = seedMessage(db, s, { timestamp: new Date(Date.now() - (200 + i) * DAY).toISOString() });
    db.prepare("INSERT INTO content_blocks (message_id, position, block_type, text_content) VALUES (?, 0, 'text', ?)").run(m, `old text ${i} `.repeat(40));
  }
});

describe('/api/db/retention', () => {
  it('GET defaults to keep everything', async () => {
    expect(await (await GET()).json()).toMatchObject({ days: null, minDays: 30, choices: [30, 90, 180, 365], cold: { blocks: 0 } });
  });

  it('estimate is a dry run', async () => {
    const r = await (await post({ action: 'estimate', days: 90 })).json();
    expect(r).toMatchObject({ days: 90, blocks: 4 });
    expect(r.estimatedSavedBytes).toBeGreaterThan(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM content_blocks WHERE cold = 1').get() as { n: number }).n).toBe(0);
    expect((await (await GET()).json()).days).toBeNull();
  });

  it('set saves a window and off clears it', async () => {
    expect(await (await post({ action: 'set', days: 90 })).json()).toMatchObject({ days: 90 });
    expect((await (await GET()).json()).days).toBe(90);
    expect(await (await post({ action: 'set', days: 'off' })).json()).toMatchObject({ days: null });
  });

  it('thaw brings cold text back hot', async () => {
    while (!freezeBatch(db, { days: 90 }).caughtUp) { /* drain */ }
    expect((await (await GET()).json()).cold.blocks).toBe(4);
    const r = await (await post({ action: 'thaw' })).json();
    expect(r).toMatchObject({ blocks: 4, done: true, cold: { blocks: 0 } });
    expect((db.prepare('SELECT text_content FROM content_blocks ORDER BY id LIMIT 1').get() as { text_content: string }).text_content).toBe('old text 0 '.repeat(40));
  });

  it('refuses a window under the minimum and unknown actions', async () => {
    expect((await post({ action: 'set', days: 7 })).status).toBe(400);
    expect((await post({ action: 'estimate' })).status).toBe(400);
    expect((await post({ action: 'delete' })).status).toBe(400);
  });
});
