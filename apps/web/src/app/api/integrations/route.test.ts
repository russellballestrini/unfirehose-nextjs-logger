import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { INTEGRATION_IDS } from '@/integrations/catalog';

/**
 * GET and POST /api/integrations: what exists, what is on, and the toggle.
 */

const settings: Record<string, string> = {};
vi.mock('@unturf/unfirehose/db/ingest', () => ({
  getSetting: (k: string) => settings[k] ?? null,
  setSetting: (k: string, v: string) => { settings[k] = v; },
}));

const { GET, POST } = await import('./route');
const id = INTEGRATION_IDS[0];
const post = (body: unknown) => POST({ json: async () => body } as never);
const saved = process.env.UNFIREHOSE_INTEGRATIONS;

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
  delete process.env.UNFIREHOSE_INTEGRATIONS;
});
afterEach(() => {
  if (saved === undefined) delete process.env.UNFIREHOSE_INTEGRATIONS;
  else process.env.UNFIREHOSE_INTEGRATIONS = saved;
});

describe('/api/integrations', () => {
  it('lists every integration, each off by default', async () => {
    const body = await (await GET()).json();
    expect(body.env).toBe('UNFIREHOSE_INTEGRATIONS');
    expect(body.integrations.map((i: { id: string }) => i.id)).toEqual([...INTEGRATION_IDS]);
    for (const i of body.integrations) expect(i).toMatchObject({ enabled: false, source: 'default' });
  });

  it('turns one on and off, and says so', async () => {
    expect(await (await post({ id, enabled: true })).json()).toMatchObject({ ok: true, enabled: true, source: 'setting' });
    expect(settings[`integration_${id}`]).toBe('true');
    expect((await (await GET()).json()).integrations[0].enabled).toBe(true);
    await post({ id, enabled: false });
    expect(settings[`integration_${id}`]).toBe('false');
  });

  it('refuses an unknown id or a non-boolean', async () => {
    expect((await post({ id: 'nope', enabled: true })).status).toBe(400);
    expect((await post({ id, enabled: 'yes' })).status).toBe(400);
    expect(settings).toEqual({});
  });

  it('refuses to toggle while the environment decides', async () => {
    process.env.UNFIREHOSE_INTEGRATIONS = id;
    expect((await post({ id, enabled: false })).status).toBe(409);
    expect((await (await GET()).json()).integrations[0]).toMatchObject({ enabled: true, source: 'env' });
  });
});
