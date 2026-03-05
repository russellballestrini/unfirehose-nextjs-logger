import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createTestDb,
  seedProject,
  seedSession,
  seedMessage,
  seedContentBlock,
  seedUsageMinute,
  seedAlert,
} from '../test/db-helper';

let testDb: Database.Database;

vi.mock('./schema', () => ({
  getDb: () => testDb,
}));

// Import after mock setup
const {
  getRecentAlerts,
  getUnacknowledgedAlerts,
  acknowledgeAlert,
  getUsageTimeline,
  getUsageByProject,
  getProjectActivity,
  getProjectRecentPrompts,
  getAlertThresholds,
  updateAlertThreshold,
  getAlertById,
  getUsageByProjectInWindow,
  getModelBreakdownInWindow,
  getActiveSessionsInWindow,
  getThinkingBlocksInWindow,
  getTimelineInWindow,
  getUserPromptsInWindow,
  getDbStats,
} = await import('./ingest');

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.close();
});

// === getDbStats ===

describe('getDbStats', () => {
  it('returns zero counts for an empty database', () => {
    const stats = getDbStats();
    expect(stats.projects).toBe(0);
    expect(stats.sessions).toBe(0);
    expect(stats.messages).toBe(0);
    expect(stats.contentBlocks).toBe(0);
    expect(stats.thinkingBlocks).toBe(0);
    expect(stats.totalTokensStored).toBe(0);
    expect(stats.alerts).toBe(0);
  });

  it('returns correct counts after seeding data', () => {
    const pid = seedProject(testDb);
    const sid = seedSession(testDb, pid);
    const mid = seedMessage(testDb, sid, { inputTokens: 100, outputTokens: 50 });
    seedContentBlock(testDb, mid, { blockType: 'text', textContent: 'hello' });
    seedContentBlock(testDb, mid, { blockType: 'thinking', textContent: 'hmm' });
    seedAlert(testDb);

    const stats = getDbStats();
    expect(stats.projects).toBe(1);
    expect(stats.sessions).toBe(1);
    expect(stats.messages).toBe(1);
    expect(stats.contentBlocks).toBe(2);
    expect(stats.thinkingBlocks).toBe(1);
    expect(stats.totalTokensStored).toBe(150);
    expect(stats.alerts).toBe(1);
  });
});

// === getRecentAlerts ===

describe('getRecentAlerts', () => {
  it('returns empty array when no alerts exist', () => {
    expect(getRecentAlerts()).toEqual([]);
  });

  it('returns alerts ordered by triggered_at descending', () => {
    seedAlert(testDb, { triggeredAt: '2026-03-01T10:00:00Z', actualValue: 100 });
    seedAlert(testDb, { triggeredAt: '2026-03-02T10:00:00Z', actualValue: 200 });

    const alerts = getRecentAlerts() as { actual_value: number }[];
    expect(alerts).toHaveLength(2);
    expect(alerts[0].actual_value).toBe(200);
    expect(alerts[1].actual_value).toBe(100);
  });

  it('respects the limit parameter', () => {
    seedAlert(testDb);
    seedAlert(testDb, { actualValue: 999 });
    seedAlert(testDb, { actualValue: 888 });

    const alerts = getRecentAlerts(2);
    expect(alerts).toHaveLength(2);
  });
});

// === getUnacknowledgedAlerts ===

describe('getUnacknowledgedAlerts', () => {
  it('returns only unacknowledged alerts', () => {
    seedAlert(testDb, { acknowledged: 0 });
    seedAlert(testDb, { acknowledged: 1 });

    const alerts = getUnacknowledgedAlerts();
    expect(alerts).toHaveLength(1);
  });

  it('returns empty array when all alerts are acknowledged', () => {
    seedAlert(testDb, { acknowledged: 1 });
    expect(getUnacknowledgedAlerts()).toHaveLength(0);
  });
});

// === acknowledgeAlert ===

describe('acknowledgeAlert', () => {
  it('sets acknowledged = 1 for the given alert id', () => {
    const id = seedAlert(testDb, { acknowledged: 0 });
    acknowledgeAlert(id);
    const alert = testDb.prepare('SELECT acknowledged FROM alerts WHERE id = ?').get(id) as { acknowledged: number };
    expect(alert.acknowledged).toBe(1);
  });

  it('does not affect other alerts', () => {
    const id1 = seedAlert(testDb, { acknowledged: 0 });
    const id2 = seedAlert(testDb, { acknowledged: 0, actualValue: 999 });
    acknowledgeAlert(id1);
    const alert2 = testDb.prepare('SELECT acknowledged FROM alerts WHERE id = ?').get(id2) as { acknowledged: number };
    expect(alert2.acknowledged).toBe(0);
  });
});

// === getUsageTimeline ===

describe('getUsageTimeline', () => {
  it('returns empty array when no usage data exists', () => {
    expect(getUsageTimeline()).toEqual([]);
  });

  it('returns aggregated usage per minute within the window', () => {
    const pid = seedProject(testDb);
    const now = new Date();
    const minute = now.toISOString().slice(0, 16);
    seedUsageMinute(testDb, pid, minute, { input: 1000, output: 500 });

    const timeline = getUsageTimeline(60) as { input_tokens: number }[];
    expect(timeline.length).toBeGreaterThanOrEqual(1);
    expect(timeline[0].input_tokens).toBe(1000);
  });

  it('excludes data outside the time window', () => {
    const pid = seedProject(testDb);
    seedUsageMinute(testDb, pid, '2020-01-01T00:00', { input: 1000 });

    const timeline = getUsageTimeline(60);
    expect(timeline).toHaveLength(0);
  });
});

// === getUsageByProject ===

describe('getUsageByProject', () => {
  it('returns empty array when no usage data exists', () => {
    expect(getUsageByProject()).toEqual([]);
  });

  it('returns per-project aggregation', () => {
    const pid1 = seedProject(testDb, 'proj-1', 'Project 1');
    const pid2 = seedProject(testDb, 'proj-2', 'Project 2');
    const now = new Date().toISOString().slice(0, 16);
    seedUsageMinute(testDb, pid1, now, { input: 5000, output: 2000 });
    seedUsageMinute(testDb, pid2, now, { input: 1000, output: 500 });

    const result = getUsageByProject(60) as { name: string; input_tokens: number }[];
    expect(result).toHaveLength(2);
    // Ordered by total tokens desc
    expect(result[0].name).toBe('proj-1');
  });
});

// === getProjectActivity ===

describe('getProjectActivity', () => {
  it('returns empty array when no messages exist', () => {
    expect(getProjectActivity()).toEqual([]);
  });

  it('returns activity with message counts and token totals', () => {
    const pid = seedProject(testDb);
    const sid = seedSession(testDb, pid);
    seedMessage(testDb, sid, { type: 'user', uuid: 'u1', timestamp: new Date().toISOString() });
    seedMessage(testDb, sid, {
      type: 'assistant',
      uuid: 'a1',
      timestamp: new Date().toISOString(),
      inputTokens: 500,
      outputTokens: 200,
    });

    const activity = getProjectActivity(30) as { user_messages: number; assistant_messages: number; total_input: number }[];
    expect(activity).toHaveLength(1);
    expect(activity[0].user_messages).toBe(1);
    expect(activity[0].assistant_messages).toBe(1);
    expect(activity[0].total_input).toBe(500);
  });

  it('excludes old messages outside the days window', () => {
    const pid = seedProject(testDb);
    const sid = seedSession(testDb, pid);
    seedMessage(testDb, sid, { type: 'user', timestamp: '2020-01-01T00:00:00Z' });

    expect(getProjectActivity(30)).toHaveLength(0);
  });
});

// === getProjectRecentPrompts ===

describe('getProjectRecentPrompts', () => {
  it('returns empty array when no matching prompts exist', () => {
    expect(getProjectRecentPrompts('nonexistent')).toEqual([]);
  });

  it('returns user text blocks for the given project', () => {
    const pid = seedProject(testDb, 'my-proj');
    const sid = seedSession(testDb, pid);
    const mid = seedMessage(testDb, sid, { type: 'user', timestamp: new Date().toISOString() });
    seedContentBlock(testDb, mid, { blockType: 'text', textContent: 'This is a long enough prompt to pass the filter' });

    const prompts = getProjectRecentPrompts('my-proj');
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toContain('long enough');
  });

  it('filters out short prompts', () => {
    const pid = seedProject(testDb, 'my-proj');
    const sid = seedSession(testDb, pid);
    const mid = seedMessage(testDb, sid, { type: 'user', timestamp: new Date().toISOString() });
    seedContentBlock(testDb, mid, { blockType: 'text', textContent: 'short' });

    expect(getProjectRecentPrompts('my-proj')).toHaveLength(0);
  });
});

// === getAlertThresholds ===

describe('getAlertThresholds', () => {
  it('returns the 7 seeded default thresholds', () => {
    const thresholds = getAlertThresholds();
    expect(thresholds).toHaveLength(7);
  });

  it('orders by window_minutes then metric', () => {
    const thresholds = getAlertThresholds() as { window_minutes: number }[];
    for (let i = 1; i < thresholds.length; i++) {
      expect(thresholds[i].window_minutes).toBeGreaterThanOrEqual(thresholds[i - 1].window_minutes);
    }
  });
});

// === updateAlertThreshold ===

describe('updateAlertThreshold', () => {
  it('updates threshold_value for the given id', () => {
    const thresholds = getAlertThresholds() as { id: number; threshold_value: number }[];
    const first = thresholds[0];
    updateAlertThreshold(first.id, 99999, true);

    const updated = testDb.prepare('SELECT threshold_value FROM alert_thresholds WHERE id = ?').get(first.id) as { threshold_value: number };
    expect(updated.threshold_value).toBe(99999);
  });

  it('updates enabled flag', () => {
    const thresholds = getAlertThresholds() as { id: number }[];
    updateAlertThreshold(thresholds[0].id, 50000, false);

    const updated = testDb.prepare('SELECT enabled FROM alert_thresholds WHERE id = ?').get(thresholds[0].id) as { enabled: number };
    expect(updated.enabled).toBe(0);
  });
});

// === getAlertById ===

describe('getAlertById', () => {
  it('returns undefined when alert does not exist', () => {
    expect(getAlertById(9999)).toBeUndefined();
  });

  it('returns full alert record when it exists', () => {
    const id = seedAlert(testDb, { metric: 'total_tokens', actualValue: 5000000 });
    const alert = getAlertById(id);
    expect(alert).toBeDefined();
    expect(alert!.metric).toBe('total_tokens');
    expect(alert!.actual_value).toBe(5000000);
  });
});

// === getUsageByProjectInWindow ===

describe('getUsageByProjectInWindow', () => {
  it('returns empty array when no data in window', () => {
    expect(getUsageByProjectInWindow('2026-03-03T00:00', '2026-03-03T01:00')).toEqual([]);
  });

  it('returns per-project breakdown within time window', () => {
    const pid = seedProject(testDb);
    seedUsageMinute(testDb, pid, '2026-03-03T00:30', { input: 1000, output: 500, count: 3 });

    const result = getUsageByProjectInWindow('2026-03-03T00:00', '2026-03-03T01:00') as { input_tokens: number; message_count: number }[];
    expect(result).toHaveLength(1);
    expect(result[0].input_tokens).toBe(1000);
    expect(result[0].message_count).toBe(3);
  });
});

// === getModelBreakdownInWindow ===

describe('getModelBreakdownInWindow', () => {
  it('returns empty array when no assistant messages in window', () => {
    expect(getModelBreakdownInWindow('2026-03-03T00:00', '2026-03-03T01:00')).toEqual([]);
  });

  it('groups by model with token totals', () => {
    const pid = seedProject(testDb);
    const sid = seedSession(testDb, pid);
    seedMessage(testDb, sid, {
      type: 'assistant',
      timestamp: '2026-03-03T00:30:00Z',
      model: 'claude-opus-4-6',
      inputTokens: 1000,
      outputTokens: 500,
    });
    seedMessage(testDb, sid, {
      type: 'assistant',
      timestamp: '2026-03-03T00:31:00Z',
      model: 'claude-opus-4-6',
      inputTokens: 2000,
      outputTokens: 800,
    });

    const result = getModelBreakdownInWindow('2026-03-03T00:00', '2026-03-03T01:00') as { model: string; input_tokens: number; message_count: number }[];
    expect(result).toHaveLength(1);
    expect(result[0].model).toBe('claude-opus-4-6');
    expect(result[0].input_tokens).toBe(3000);
    expect(result[0].message_count).toBe(2);
  });
});

// === getActiveSessionsInWindow ===

describe('getActiveSessionsInWindow', () => {
  it('returns empty array when no sessions active in window', () => {
    expect(getActiveSessionsInWindow('2026-03-03T00:00', '2026-03-03T01:00')).toEqual([]);
  });

  it('returns session details with token totals', () => {
    const pid = seedProject(testDb);
    const sid = seedSession(testDb, pid, 'session-abc');
    seedMessage(testDb, sid, {
      type: 'assistant',
      timestamp: '2026-03-03T00:30:00Z',
      inputTokens: 5000,
      outputTokens: 2000,
    });

    const result = getActiveSessionsInWindow('2026-03-03T00:00', '2026-03-03T01:00') as { session_uuid: string; input_tokens: number }[];
    expect(result).toHaveLength(1);
    expect(result[0].session_uuid).toBe('session-abc');
    expect(result[0].input_tokens).toBe(5000);
  });
});

// === getThinkingBlocksInWindow ===

describe('getThinkingBlocksInWindow', () => {
  it('returns empty array when no thinking blocks in window', () => {
    expect(getThinkingBlocksInWindow('2026-03-03T00:00', '2026-03-03T01:00')).toEqual([]);
  });

  it('returns thinking blocks with metadata', () => {
    const pid = seedProject(testDb);
    const sid = seedSession(testDb, pid);
    const mid = seedMessage(testDb, sid, {
      type: 'assistant',
      timestamp: '2026-03-03T00:30:00Z',
      model: 'claude-opus-4-6',
    });
    seedContentBlock(testDb, mid, { blockType: 'thinking', textContent: 'Let me think about this...' });

    const result = getThinkingBlocksInWindow('2026-03-03T00:00', '2026-03-03T01:00') as { text_content: string; char_count: number }[];
    expect(result).toHaveLength(1);
    expect(result[0].text_content).toContain('Let me think');
    expect(result[0].char_count).toBeGreaterThan(0);
  });
});

// === getTimelineInWindow ===

describe('getTimelineInWindow', () => {
  it('returns empty array when no usage in window', () => {
    expect(getTimelineInWindow('2026-03-03T00:00', '2026-03-03T01:00')).toEqual([]);
  });

  it('returns minute-level aggregation ordered ascending', () => {
    const pid = seedProject(testDb);
    seedUsageMinute(testDb, pid, '2026-03-03T00:31', { input: 2000 });
    seedUsageMinute(testDb, pid, '2026-03-03T00:30', { input: 1000 });

    const result = getTimelineInWindow('2026-03-03T00:00', '2026-03-03T01:00') as { minute: string; input_tokens: number }[];
    expect(result).toHaveLength(2);
    // Should be ordered ascending
    expect(result[0].minute).toBe('2026-03-03T00:30');
    expect(result[1].minute).toBe('2026-03-03T00:31');
  });
});

// === getUserPromptsInWindow ===

describe('getUserPromptsInWindow', () => {
  it('returns empty array when no user prompts in window', () => {
    expect(getUserPromptsInWindow('2026-03-03T00:00', '2026-03-03T01:00')).toEqual([]);
  });

  it('returns user text blocks within the time window', () => {
    const pid = seedProject(testDb);
    const sid = seedSession(testDb, pid);
    const mid = seedMessage(testDb, sid, { type: 'user', timestamp: '2026-03-03T00:30:00Z' });
    seedContentBlock(testDb, mid, { blockType: 'text', textContent: 'What is the status of the deployment?' });

    const result = getUserPromptsInWindow('2026-03-03T00:00', '2026-03-03T01:00') as { prompt: string }[];
    expect(result).toHaveLength(1);
    expect(result[0].prompt).toContain('deployment');
  });

  it('filters out short prompts', () => {
    const pid = seedProject(testDb);
    const sid = seedSession(testDb, pid);
    const mid = seedMessage(testDb, sid, { type: 'user', timestamp: '2026-03-03T00:30:00Z' });
    seedContentBlock(testDb, mid, { blockType: 'text', textContent: 'yes' });

    expect(getUserPromptsInWindow('2026-03-03T00:00', '2026-03-03T01:00')).toHaveLength(0);
  });
});
