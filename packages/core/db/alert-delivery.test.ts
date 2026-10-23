import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createTestDb, seedAlert } from '../test/db-helper';
import {
  createRule, updateRule, deleteRule, listRules, listDeliveries, deliverDue, sendTestAlert,
  memorySecretStore, fileSecretStore, scrubError, hasEnabledRules,
  type Sender, type SecretStore,
} from './alert-delivery';
import type { OutboundRequest } from '../alert-delivery';

let db: Database.Database;
let store: SecretStore;
const T0 = new Date('2026-10-23T15:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

/** A sender that records requests and answers from a script, one status per call. */
function fakeSender(statuses: Array<number | null> = [200]) {
  const calls: OutboundRequest[] = [];
  let i = 0;
  const send: Sender = async (req) => {
    calls.push(req);
    const status = statuses[Math.min(i++, statuses.length - 1)];
    return status === null ? { status: null, error: 'connect ECONNREFUSED' } : { status };
  };
  return { send, calls };
}

const webhook = (over: Record<string, unknown> = {}) => ({
  destination: 'webhook', name: 'hook', config: { url: 'http://localhost:9999/hook' }, ...over,
});

beforeEach(() => { db = createTestDb(); store = memorySecretStore(); });

describe('rules', () => {
  it('creates a rule that starts after every alert already logged', () => {
    seedAlert(db); seedAlert(db);
    const r = createRule(db, store, webhook(), T0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rule).toMatchObject({ name: 'hook', enabled: true, destination: 'webhook', rate_limit_per_hour: 10 });
    expect((db.prepare('SELECT since_alert_id FROM alert_delivery_rules').get() as { since_alert_id: number }).since_alert_id).toBe(2);
    expect(hasEnabledRules(db)).toBe(true);
  });

  it('returns field errors and stores nothing for a bad rule', () => {
    expect(createRule(db, store, { destination: 'email' })).toEqual({ ok: false, errors: { destination: 'one of webhook, ntfy, slack, discord' } });
    const r = createRule(db, store, { destination: 'slack', match: { metric: 'vibes' }, rate_limit_per_hour: 0 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(['match', 'rate_limit_per_hour', 'webhookUrl']);
    expect(listRules(db, store)).toEqual([]);
  });

  it('keeps secrets out of the database and shows them masked', () => {
    const url = 'https://hooks.slack.com/services/T000/B000/SECRETabcd';
    const r = createRule(db, store, { destination: 'slack', secrets: { webhookUrl: url } }, T0);
    if (!r.ok) throw new Error('expected ok');
    expect(r.rule.secrets).toEqual({ webhookUrl: 'https://hooks.slack.com/••••abcd' });
    expect(JSON.stringify(r.rule)).not.toContain('SECRET');
    const row = JSON.stringify(db.prepare('SELECT * FROM alert_delivery_rules').all());
    expect(row).not.toContain('SECRET');
    expect(store.get(r.rule.id).webhookUrl).toBe(url);
  });

  it('keeps a stored secret on an edit that leaves it blank, replaces or clears it on request', () => {
    const r = createRule(db, store, webhook({ secrets: { hmacSecret: 'first-secret-123' } }), T0);
    if (!r.ok) throw new Error('expected ok');
    const id = r.rule.id;
    updateRule(db, store, id, { name: 'renamed', secrets: { hmacSecret: '' } }, T0);
    expect(store.get(id).hmacSecret).toBe('first-secret-123');
    updateRule(db, store, id, { secrets: { hmacSecret: 'second-secret-456' } }, T0);
    expect(store.get(id).hmacSecret).toBe('second-secret-456');
    const cleared = updateRule(db, store, id, { secrets: { hmacSecret: null } }, T0);
    expect(cleared && cleared.ok && cleared.rule.secrets).toEqual({ hmacSecret: null });
    expect(updateRule(db, store, id, { destination: 'slack' }, T0)).toEqual({ ok: false, errors: { destination: 'cannot change; create a new rule' } });
    expect(updateRule(db, store, 999, {}, T0)).toBeNull();
  });

  it('deletes a rule with its attempts and its secrets', async () => {
    const r = createRule(db, store, webhook({ secrets: { hmacSecret: 'secret-secret' } }), T0);
    if (!r.ok) throw new Error('expected ok');
    await sendTestAlert(db, store, r.rule.id, fakeSender().send, T0);
    expect(deleteRule(db, store, r.rule.id)).toBe(true);
    expect(listDeliveries(db)).toEqual([]);
    expect(store.get(r.rule.id)).toEqual({});
  });
});

describe('deliverDue', () => {
  it('does nothing at all while no rule exists', async () => {
    seedAlert(db);
    const f = fakeSender();
    expect(await deliverDue(db, store, f.send, T0)).toMatchObject({ rules: 0, sent: 0 });
    expect(f.calls).toHaveLength(0);
  });

  it('delivers a new alert once per rule, however many ticks run', async () => {
    createRule(db, store, webhook(), T0);
    createRule(db, store, { destination: 'ntfy', config: { server: 'http://ntfy.lan', topic: 'fox' } }, T0);
    seedAlert(db);
    const f = fakeSender();
    expect(await deliverDue(db, store, f.send, at(1000))).toMatchObject({ rules: 2, queued: 2, sent: 2 });
    expect(await deliverDue(db, store, f.send, at(60_000))).toMatchObject({ queued: 0, sent: 0 });
    expect(f.calls.map((c) => c.url).sort()).toEqual(['http://localhost:9999/hook', 'http://ntfy.lan/fox']);
    expect(listDeliveries(db).every((d) => d.status === 'sent' && d.attempts === 1 && d.http_status === 200)).toBe(true);
  });

  it('never sends the backlog from before a rule existed', async () => {
    seedAlert(db); seedAlert(db);
    createRule(db, store, webhook(), T0);
    const f = fakeSender();
    await deliverDue(db, store, f.send, at(1000));
    expect(f.calls).toHaveLength(0);
  });

  it('skips a disabled rule, and on re-enable starts from then', async () => {
    const r = createRule(db, store, webhook({ enabled: false }), T0);
    if (!r.ok) throw new Error('expected ok');
    seedAlert(db);
    const f = fakeSender();
    await deliverDue(db, store, f.send, at(1000));
    expect(f.calls).toHaveLength(0);
    expect(hasEnabledRules(db)).toBe(false);
    updateRule(db, store, r.rule.id, { enabled: true }, at(2000));
    await deliverDue(db, store, f.send, at(3000));
    expect(f.calls).toHaveLength(0);
    seedAlert(db);
    await deliverDue(db, store, f.send, at(4000));
    expect(f.calls).toHaveLength(1);
  });

  it('matches by threshold and by project', async () => {
    createRule(db, store, webhook({ match: { metric: 'input_tokens', window: 60 } }), T0);
    createRule(db, store, webhook({ match: { project: 'unfirehose' } }), T0);
    seedAlert(db, { metric: 'input_tokens', windowMinutes: 60 });
    seedAlert(db, { metric: 'input_tokens', windowMinutes: 15 });
    seedAlert(db, { metric: 'output_tokens', projectName: 'unfirehose' });
    await deliverDue(db, store, fakeSender().send, at(1000));
    const pairs = (db.prepare('SELECT alert_id, rule_id FROM alert_deliveries ORDER BY alert_id').all() as Array<{ alert_id: number; rule_id: number }>)
      .map((d) => `${d.alert_id}:${d.rule_id}`);
    expect(pairs).toEqual(['1:1', '3:2']);
  });

  it('retries a 5xx or a dead connection with backoff, then gives up', async () => {
    createRule(db, store, webhook(), T0);
    seedAlert(db);
    const f = fakeSender([503, null, 503, 503, 503]);
    expect(await deliverDue(db, store, f.send, at(0))).toMatchObject({ retrying: 1 });
    let d = listDeliveries(db)[0];
    expect(d).toMatchObject({ status: 'pending', attempts: 1, http_status: 503 });
    expect(d.next_retry_at).toBe(at(30_000).toISOString());
    // Not yet due: nothing is sent.
    await deliverDue(db, store, f.send, at(10_000));
    expect(f.calls).toHaveLength(1);
    await deliverDue(db, store, f.send, at(30_000));
    d = listDeliveries(db)[0];
    expect(d).toMatchObject({ status: 'pending', attempts: 2, http_status: null, error: 'connect ECONNREFUSED' });
    expect(d.next_retry_at).toBe(at(30_000 + 120_000).toISOString());
    // Run far enough ahead that every remaining retry is due.
    for (let i = 0; i < 5; i++) await deliverDue(db, store, f.send, at(10 * 3600_000 * (i + 1)));
    d = listDeliveries(db)[0];
    expect(d).toMatchObject({ status: 'failed', attempts: 5, http_status: 503 });
    expect(f.calls).toHaveLength(5);
  });

  it('fails a 4xx at once: it will say the same thing next time', async () => {
    createRule(db, store, webhook(), T0);
    seedAlert(db);
    expect(await deliverDue(db, store, fakeSender([404]).send, at(0))).toMatchObject({ failed: 1, retrying: 0 });
    expect(listDeliveries(db)[0]).toMatchObject({ status: 'failed', attempts: 1, http_status: 404 });
  });

  it('holds each rule to its per-hour limit and drops the rest as rate_limited', async () => {
    createRule(db, store, webhook({ rate_limit_per_hour: 2 }), T0);
    for (let i = 0; i < 4; i++) seedAlert(db);
    const f = fakeSender();
    expect(await deliverDue(db, store, f.send, at(1000))).toMatchObject({ sent: 2, rateLimited: 2 });
    expect(f.calls).toHaveLength(2);
    // An hour on, the window has room again for what comes next.
    seedAlert(db);
    expect(await deliverDue(db, store, f.send, at(3600_000 + 2000))).toMatchObject({ sent: 1 });
  });

  it('closes a pending attempt whose alert was cleared', async () => {
    createRule(db, store, webhook(), T0);
    seedAlert(db);
    await deliverDue(db, store, fakeSender([500]).send, at(0));
    db.prepare('DELETE FROM alerts').run();
    await deliverDue(db, store, fakeSender().send, at(3600_000));
    expect(listDeliveries(db)[0]).toMatchObject({ status: 'failed', error: 'alert cleared before delivery' });
  });

  it('reports a rule missing its secret as failed, without retrying', async () => {
    const r = createRule(db, store, { destination: 'discord', secrets: { webhookUrl: 'https://discord.com/api/webhooks/1/x' } }, T0);
    if (!r.ok) throw new Error('expected ok');
    store.delete(r.rule.id);
    seedAlert(db);
    const f = fakeSender();
    expect(await deliverDue(db, store, f.send, at(0))).toMatchObject({ failed: 1 });
    expect(f.calls).toHaveLength(0);
    expect(listDeliveries(db)[0].error).toBe('discord needs a webhook URL');
  });
});

describe('sendTestAlert', () => {
  it('sends a synthetic alert through the same path, records it, and works on a disabled rule', async () => {
    const r = createRule(db, store, webhook({ enabled: false, secrets: { hmacSecret: 'secret-secret' } }), T0);
    if (!r.ok) throw new Error('expected ok');
    const f = fakeSender([202]);
    expect(await sendTestAlert(db, store, r.rule.id, f.send, T0)).toEqual({ ok: true, status: 202, error: null });
    expect(JSON.parse(f.calls[0].body).event).toBe('alert.test');
    expect(f.calls[0].headers['X-Unfirehose-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(listDeliveries(db)[0]).toMatchObject({ is_test: 1, alert_id: null, status: 'sent' });
    expect(listRules(db, store, T0)[0].last).toMatchObject({ status: 'sent', is_test: true });
    expect(await sendTestAlert(db, store, 999, f.send, T0)).toBeNull();
  });

  it('never stores the destination URL in an error', async () => {
    const url = 'https://hooks.slack.com/services/T0/B0/TOPSECRET';
    const r = createRule(db, store, { destination: 'slack', secrets: { webhookUrl: url } }, T0);
    if (!r.ok) throw new Error('expected ok');
    const leaky: Sender = async () => ({ status: null, error: `request to ${url} failed` });
    const res = await sendTestAlert(db, store, r.rule.id, leaky, T0);
    expect(res?.error).toBe('request to [destination] failed');
    expect(JSON.stringify(db.prepare('SELECT * FROM alert_deliveries').all())).not.toContain('TOPSECRET');
  });
});

describe('scrubError', () => {
  it('removes the URL, its path, and any other URL', () => {
    const req = { url: 'https://discord.com/api/webhooks/1/tok', method: 'POST' as const, headers: {}, body: '' };
    expect(scrubError('bad /api/webhooks/1/tok and https://elsewhere.test/x', req)).toBe('bad /[path] and [url]');
  });
});

describe('fileSecretStore', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'uf-secrets-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes a 0600 file, reads it back, and tightens one it finds loose', () => {
    const file = path.join(dir, 'nested', 'alert-secrets.json');
    const s = fileSecretStore(file);
    s.set(1, { token: 'tk_one' });
    s.set(2, { webhookUrl: 'https://x.test/y' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fileSecretStore(file).get(1)).toEqual({ token: 'tk_one' });
    s.delete(1);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 2: { webhookUrl: 'https://x.test/y' } });
    chmodSync(file, 0o644);
    s.get(2);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('reads a corrupt file as empty rather than throwing', () => {
    const file = path.join(dir, 's.json');
    writeFileSync(file, '{nope', { mode: 0o600 });
    expect(fileSecretStore(file).get(1)).toEqual({});
  });

  it('refuses the real path from a test', () => {
    const prev = process.env.UNFIREHOSE_ALERT_SECRETS_PATH;
    delete process.env.UNFIREHOSE_ALERT_SECRETS_PATH;
    try {
      expect(() => fileSecretStore()).toThrow(/from a test/);
    } finally {
      if (prev !== undefined) process.env.UNFIREHOSE_ALERT_SECRETS_PATH = prev;
    }
  });
});
