import { describe, it, expect } from 'vitest';
import { createTestDb, seedAlert } from '@unturf/unfirehose/test/db-helper';
import { createRule, memorySecretStore, type Sender } from '@unturf/unfirehose/db/alert-delivery';
import { createAlertTicker } from './alert-tick';

describe('createAlertTicker', () => {
  it('sends nothing and logs nothing while no rule is enabled', async () => {
    const db = createTestDb();
    seedAlert(db);
    const lines: string[] = [];
    let calls = 0;
    const tick = createAlertTicker({
      db: () => db, store: memorySecretStore,
      send: async () => { calls++; return { status: 200 }; }, log: (l) => lines.push(l),
    });
    expect(await tick()).toBeNull();
    expect(calls).toBe(0);
    expect(lines).toEqual([]);
  });

  it('delivers a new alert, logs counts but no destination, and is single-flight', async () => {
    const db = createTestDb();
    const store = memorySecretStore();
    const url = 'https://hooks.slack.com/services/T/B/SECRET';
    createRule(db, store, { destination: 'slack', secrets: { webhookUrl: url } });
    seedAlert(db);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const send: Sender = async () => { await gate; return { status: 200 }; };
    const lines: string[] = [];
    const tick = createAlertTicker({ db: () => db, store: () => store, send, log: (l) => lines.push(l) });
    const first = tick();
    expect(await tick()).toBeNull(); // still in flight
    release();
    expect(await first).toMatchObject({ sent: 1 });
    expect(lines).toEqual(['[worker] alert delivery: 1 sent, 0 retrying, 0 failed, 0 rate-limited']);
    expect(lines.join('')).not.toContain('SECRET');
  });
});
