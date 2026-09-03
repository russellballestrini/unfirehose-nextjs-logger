import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createTestDb, seedProject, seedSession, seedMessage, seedContentBlock } from '../test/db-helper';
import { scanRateLimits, backfillReportedRefusals } from './rate-limit-scan';
import { recordHarnessRefusal } from './refusals';

let db: Database.Database;
let tmp: string;

beforeEach(() => {
  db = createTestDb();
  tmp = mkdtempSync(path.join(tmpdir(), 'rls-'));
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('scanRateLimits fromScratch', () => {
  it('rebuilds text-scanned rows and leaves harness-reported rows alone', () => {
    const pid = seedProject(db, 'p');
    const sid = seedSession(db, pid);
    const mid = seedMessage(db, sid, { timestamp: '2026-09-03T10:00:00.000Z' });
    seedContentBlock(db, mid, { textContent: 'API Error: 529 Overloaded. This is a server-side issue.' });
    recordHarnessRefusal(db, {
      sessionId: sid, timestamp: '2026-09-02T19:56:10.290Z', kind: 'server_error',
      provider: 'uncloseai', upstream: 'qwen', model: null, httpStatus: 500, detail: 'HTTP 500',
    });

    scanRateLimits(db, { fromScratch: true });
    const rules = db.prepare('SELECT rule FROM rate_limit_events ORDER BY rule').all() as { rule: string }[];
    expect(rules.map(r => r.rule)).toEqual(['anthropic-overloaded', 'harness-reported']);

    scanRateLimits(db, { fromScratch: true });
    expect(db.prepare('SELECT COUNT(*) AS c FROM rate_limit_events').get()).toEqual({ c: 2 });
  });

  it('skips a text match already covered by a reported refusal in the same minute', () => {
    const pid = seedProject(db, 'p');
    const sid = seedSession(db, pid);
    const mid = seedMessage(db, sid, { timestamp: '2026-09-03T10:00:00.000Z' });
    seedContentBlock(db, mid, { textContent: 'API Error: 529 Overloaded.' });
    recordHarnessRefusal(db, {
      sessionId: sid, messageId: mid, timestamp: '2026-09-03T10:00:00.000Z', kind: 'overloaded',
      provider: 'anthropic', upstream: 'anthropic', model: null, httpStatus: 529, detail: 'API Error: 529 Overloaded.',
    });
    const r = scanRateLimits(db);
    expect(r.found).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM rate_limit_events').get()).toEqual({ c: 1 });
  });
});

describe('backfillReportedRefusals', () => {
  it('rebuilds throttle records and Claude api errors from disk, once', () => {
    const pid = seedProject(db, 'p');
    const sid = seedSession(db, pid, 'sess-uc');
    const csid = seedSession(db, pid, 'sess-cc');
    const mid = seedMessage(db, csid, { uuid: 'msg-529', timestamp: '2026-09-03T13:40:25.031Z' });

    const uc = path.join(tmp, 'uncloseai', 'home-fox-git-x');
    mkdirSync(uc, { recursive: true });
    writeFileSync(path.join(uc, 'sess-uc.jsonl'), [
      JSON.stringify({ type: 'message', role: 'assistant', content: [] }),
      JSON.stringify({ type: 'throttle', harness: 'uncloseai', timestamp: '2026-09-02T19:56:10.290Z', kind: 'server_error', upstream: 'qwen', model: 'Qwen3.6', httpStatus: 500, message: 'HTTP Error 500' }),
      JSON.stringify({ type: 'throttle', harness: 'uncloseai', timestamp: '2026-09-02T19:57:08.568Z', kind: 'timeout', upstream: 'grok', model: 'grok-4', message: 'timed out' }),
    ].join('\n'));

    const cc = path.join(tmp, 'claude', '-home-fox-git-x');
    mkdirSync(cc, { recursive: true });
    writeFileSync(path.join(cc, 'sess-cc.jsonl'), [
      JSON.stringify({ type: 'assistant', uuid: 'msg-ok', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'fine' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'msg-529', sessionId: 'sess-cc', timestamp: '2026-09-03T13:40:25.031Z', error: 'server_error', isApiErrorMessage: true, apiErrorStatus: 529, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 Overloaded.' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'msg-login', sessionId: 'sess-cc', timestamp: '2026-09-03T13:41:00.000Z', error: 'authentication_failed', isApiErrorMessage: true, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Login expired' }] } }),
    ].join('\n'));

    const opts = { uncloseaiDir: path.join(tmp, 'uncloseai'), claudeProjectsDir: path.join(tmp, 'claude') };
    const first = backfillReportedRefusals(db, opts);
    expect(first).toMatchObject({ files: 2, throttleRecords: 2, claudeApiErrors: 1, inserted: 3, skipped: 0 });

    const rows = db.prepare('SELECT session_id, message_id, kind, provider, upstream, http_status FROM rate_limit_events ORDER BY timestamp').all();
    expect(rows).toEqual([
      { session_id: sid, message_id: null, kind: 'server_error', provider: 'uncloseai', upstream: 'qwen', http_status: 500 },
      { session_id: sid, message_id: null, kind: 'timeout', provider: 'uncloseai', upstream: 'grok', http_status: null },
      { session_id: csid, message_id: mid, kind: 'overloaded', provider: 'anthropic', upstream: 'anthropic', http_status: 529 },
    ]);

    const second = backfillReportedRefusals(db, opts);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(3);
  });
});
