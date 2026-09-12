import { expect, it } from 'vitest';
import { createTestDb, seedProject, seedSession, seedMessage } from '../test/db-helper';

it('aggregates pricing tokens without reading the messages table', () => {
  const db = createTestDb();
  const session = seedSession(db, seedProject(db, 'usage-index'), 'usage-index');
  seedMessage(db, session, { model: 'test/model', inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheCreationTokens: 0 });
  const query = `SELECT model, SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
    MAX(timestamp) AS last_seen FROM messages
    WHERE model IS NOT NULL AND model != '' AND timestamp >= ? GROUP BY model`;
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + query).all('2000-01-01') as { detail: string }[];
  expect(plan.some(row => row.detail.includes('COVERING INDEX idx_messages_model_usage'))).toBe(true);
  expect(db.prepare(query).get('2000-01-01')).toMatchObject({ model: 'test/model', tokens: 200 });
  db.close();
});


it('aggregates project activity from the time-window covering index', () => {
  const db = createTestDb();
  const session = seedSession(db, seedProject(db, 'window-index'), 'window-index');
  seedMessage(db, session, { model: 'test/model', inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheCreationTokens: 0 });
  const query = `SELECT p.name, SUM(m.input_tokens) AS input,
    COUNT(DISTINCT s.session_uuid), COUNT(DISTINCT DATE(m.timestamp)), MAX(m.timestamp),
    SUM(m.output_tokens), SUM(m.cache_read_tokens), SUM(m.cache_creation_tokens),
    COUNT(CASE WHEN m.type = 'user' THEN 1 END)
    FROM messages m JOIN sessions s ON m.session_id = s.id JOIN projects p ON s.project_id = p.id
    WHERE m.timestamp >= ? GROUP BY p.id`;
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + query).all('2000-01-01') as { detail: string }[];
  expect(plan.some(row => row.detail.includes('COVERING INDEX idx_messages_window_usage'))).toBe(true);
  expect(db.prepare(query).get('2000-01-01')).toMatchObject({ name: 'window-index', input: 100 });
  db.close();
});


it('refreshes project totals without table reads for each session', () => {
  const db = createTestDb();
  const session = seedSession(db, seedProject(db, 'project-index'), 'project-index');
  seedMessage(db, session, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheCreationTokens: 0 });
  const query = `SELECT s.project_id, COUNT(*), SUM(m.input_tokens) AS input,
    SUM(m.output_tokens), SUM(m.cache_read_tokens), SUM(m.cache_creation_tokens), MAX(m.timestamp)
    FROM messages m JOIN sessions s ON s.id = m.session_id GROUP BY s.project_id`;
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + query).all() as { detail: string }[];
  expect(plan.some(row => row.detail.includes('COVERING INDEX idx_messages_session_usage'))).toBe(true);
  expect(db.prepare(query).get()).toMatchObject({ input: 100 });
  db.close();
});
