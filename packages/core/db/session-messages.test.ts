import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { createTestDb } from '../test/db-helper';
import { FIXTURES } from '../test/harness-shape';

const db = createTestDb();
vi.mock('./schema', () => ({ getDb: () => db, UNFIREHOSE_DIR: '/tmp/unfirehose-test' }));

const { ingestForeignSource } = await import('./ingest-foreign');
const { storedSessionMessages, storedProjectSessions } = await import('./session-messages');

/** A stored harness's session, read back for the viewer: the messages ingest wrote, in order. */
describe('storedSessionMessages', () => {
  it('reads a session back as the unfirehose/1.0 messages that went in', () => {
    ingestForeignSource(db, { harness: 'codex', format: 'codex-rollout', root: path.join(FIXTURES, 'codex', 'sessions') });
    const msgs = storedSessionMessages(db, '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b');
    const flat = msgs.flatMap((m) => m.content.map((b: any) => `${m.role}:${b.type}`));
    expect(flat).toEqual([
      'user:text', 'user:text', 'assistant:reasoning', 'assistant:text', 'assistant:tool-call', 'user:tool-result', 'assistant:text',
    ]);
    const call = msgs.flatMap((m) => m.content).find((b: any) => b.type === 'tool-call');
    expect(call).toMatchObject({ toolCallId: 'call_Q1w2e3', toolName: 'shell' });
    const usage = msgs.filter((m) => m.usage).map((m) => m.usage.inputTokens);
    expect(usage).toEqual([1200, 1400]);
    expect(msgs.every((m) => m.harness === 'codex' && m.$schema === 'unfirehose/1.0')).toBe(true);
    expect(storedSessionMessages(db, 'nope')).toEqual([]);
  });

  it('lists a stored project\'s sessions', () => {
    expect(storedProjectSessions(db, 'codex:-home-demo-git-demo-api')).toEqual([
      expect.objectContaining({ sessionId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', gitBranch: 'main', messageCount: 9 }),
    ]);
  });
});
