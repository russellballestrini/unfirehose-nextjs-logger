import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createTestDb } from '@unturf/unfirehose/test/db-helper';

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));

// Secrets land in a scratch 0600 file, never ~/.unfirehose.
const dir = mkdtempSync(path.join(tmpdir(), 'uf-alert-routes-'));
const secretsFile = path.join(dir, 'alert-secrets.json');
beforeAll(() => { process.env.UNFIREHOSE_ALERT_SECRETS_PATH = secretsFile; });
afterAll(() => { delete process.env.UNFIREHOSE_ALERT_SECRETS_PATH; rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllGlobals(); });

const { GET, POST } = await import('./route');
const one = await import('./[id]/route');
const test = await import('./[id]/test/route');

const SLACK = 'https://hooks.slack.com/services/T000/B000/TOPSECRETwxyz';
const req = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
  new NextRequest(new URL(url, 'http://localhost:3000'), init);
const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

async function create(body: unknown) {
  const res = await POST(req('/api/alerts/delivery', json('POST', body)));
  return { status: res.status, data: await res.json() };
}

describe('/api/alerts/delivery', () => {
  it('creates a Slack rule, stores the URL in the 0600 file, and answers with it masked', async () => {
    const { status, data } = await create({ name: 'team', destination: 'slack', secrets: { webhookUrl: SLACK } });
    expect(status).toBe(201);
    expect(data.rule.secrets).toEqual({ webhookUrl: 'https://hooks.slack.com/••••wxyz' });
    expect(JSON.stringify(data)).not.toContain('TOPSECRET');
    expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(secretsFile, 'utf8')).toContain('TOPSECRET');

    const list = await (await GET(req('/api/alerts/delivery'))).json();
    expect(list.rules).toHaveLength(1);
    expect(list.destinations).toEqual(['webhook', 'ntfy', 'slack', 'discord']);
    expect(JSON.stringify(list)).not.toContain('TOPSECRET');
  });

  it('rejects a bad rule with errors by field and no echo of what was sent', async () => {
    const { status, data } = await create({ destination: 'webhook', config: { url: 'file:///etc/shadow' } });
    expect(status).toBe(400);
    expect(data.errors).toEqual({ url: 'must be an http:// or https:// URL' });
    expect((await create({ destination: 'email' })).status).toBe(400);
    const bad = await POST(req('/api/alerts/delivery', { method: 'POST', body: 'nope' }));
    expect(bad.status).toBe(400);
  });

  it('updates, reads, and deletes one rule', async () => {
    const { data } = await create({ destination: 'ntfy', config: { server: 'http://ntfy.lan', topic: 'fox' }, secrets: { token: 'tk_0123456789abcdef' } });
    const id = data.rule.id;
    const patched = await (await one.PATCH(req(`/api/alerts/delivery/${id}`, json('PATCH', { enabled: false, secrets: { token: '' } })), ctx(id))).json();
    expect(patched.rule).toMatchObject({ enabled: false, secrets: { token: '••••cdef' } });
    const got = await (await one.GET(req(`/api/alerts/delivery/${id}`), ctx(id))).json();
    expect(got.rule.config).toEqual({ server: 'http://ntfy.lan', topic: 'fox' });
    expect((await one.PATCH(req('/api/alerts/delivery/999', json('PATCH', {})), ctx(999))).status).toBe(404);
    expect((await one.GET(req('/api/alerts/delivery/x'), ctx('x'))).status).toBe(400);
    expect((await one.DELETE(req(`/api/alerts/delivery/${id}`, { method: 'DELETE' }), ctx(id))).status).toBe(200);
    expect((await one.DELETE(req(`/api/alerts/delivery/${id}`, { method: 'DELETE' }), ctx(id))).status).toBe(404);
    expect(readFileSync(secretsFile, 'utf8')).not.toContain('tk_0123456789abcdef');
  });

  it('sends a test through our real sender, with fetch stubbed, and reports the answer', async () => {
    const { data } = await create({ destination: 'discord', secrets: { webhookUrl: 'https://discord.com/api/webhooks/1/TOPSECRETtok' } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await test.POST(req(`/api/alerts/delivery/${data.rule.id}/test`, { method: 'POST' }), ctx(data.rule.id));
    expect(await res.json()).toEqual({ ok: true, status: 204, error: null });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://discord.com/api/webhooks/1/TOPSECRETtok');
    expect(init.redirect).toBe('manual');
    expect(JSON.parse(init.body).embeds[0].title).toBe('unfirehose: test alert');

    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    const failed = await (await test.POST(req('/x', { method: 'POST' }), ctx(data.rule.id))).json();
    expect(failed).toEqual({ ok: false, status: null, error: 'fetch failed (ECONNREFUSED)' });
    expect((await test.POST(req('/x', { method: 'POST' }), ctx(999))).status).toBe(404);
  });
});
