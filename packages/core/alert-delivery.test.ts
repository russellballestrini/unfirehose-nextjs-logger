import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import {
  summarizeAlert, formatWebhook, formatSlack, formatDiscord, formatNtfy, encodeHeader,
  buildRequest, signBody, validateUrl, validateTopic, validateDestination, maskSecret,
  backoffMs, isRetryable, syntheticAlert, ntfyUrl, SIGNATURE_HEADER, TIMESTAMP_HEADER,
  type AlertLike,
} from './alert-delivery';

const alert = (over: Partial<AlertLike> = {}): AlertLike => ({
  id: 42,
  triggered_at: '2026-10-23 15:00:00',
  alert_type: 'threshold_breach',
  window_minutes: 15,
  metric: 'output_tokens',
  threshold_value: 2_500_000,
  actual_value: 5_000_000,
  project_name: null,
  details: '{"ratio":"2.00"}',
  ...over,
});
const NOW = new Date('2026-10-23T15:01:00Z');

describe('summarizeAlert', () => {
  it('says what crossed which threshold, by how much, and how loud', () => {
    const s = summarizeAlert(alert());
    expect(s.title).toBe('unfirehose: output tokens over threshold (15 minutes)');
    expect(s.message).toBe('5.0M output tokens in 15 minutes, over our 2.5M threshold (2.0x).');
    expect(s.severity).toBe('high');
    expect(s.path).toBe('/usage/alert/42');
    expect(summarizeAlert(alert({ actual_value: 9_000_000 })).severity).toBe('urgent');
    expect(summarizeAlert(alert({ actual_value: 2_600_000 })).severity).toBe('normal');
    expect(summarizeAlert(alert({ window_minutes: 60, project_name: 'unfirehose' })).title)
      .toBe('unfirehose: output tokens over threshold (1 hour) in unfirehose');
  });

  it('labels a test as a test', () => {
    const s = summarizeAlert(syntheticAlert(NOW));
    expect(s.test).toBe(true);
    expect(s.title).toBe('unfirehose: test alert');
    expect(s.message).toMatch(/^This is a test from unfirehose/);
  });
});

describe('formatWebhook', () => {
  it('carries our alert row, parsed details and the words', () => {
    const p = formatWebhook(alert(), NOW);
    expect(p).toMatchObject({
      event: 'alert.triggered', version: 1, sent_at: NOW.toISOString(), severity: 'high', path: '/usage/alert/42',
      alert: { id: 42, metric: 'output_tokens', ratio: 2, details: { ratio: '2.00' }, project_name: null },
    });
    expect(formatWebhook(syntheticAlert(NOW), NOW).event).toBe('alert.test');
  });
});

describe('formatSlack', () => {
  it('gives a text fallback and a header, message, fields and context', () => {
    const p = formatSlack(alert({ project_name: '<!channel> & co' }));
    expect(p.text).toContain('output tokens over threshold');
    expect(p.blocks.map((b) => b.type)).toEqual(['header', 'section', 'section', 'context']);
    const fields = (p.blocks[2] as { fields: { text: string }[] }).fields.map((f) => f.text);
    expect(fields).toContain('*Actual*\n5.0M');
    // A project name cannot become a Slack mention.
    expect(fields).toContain('*Project*\n&lt;!channel&gt; &amp; co');
  });
});

describe('formatDiscord', () => {
  it('sends one embed, coloured by severity, with mentions switched off', () => {
    const p = formatDiscord(alert({ actual_value: 9_000_000, project_name: '@everyone' }));
    expect(p.allowed_mentions).toEqual({ parse: [] });
    expect(p.embeds).toHaveLength(1);
    expect(p.embeds[0].color).toBe(0xd40000);
    expect(p.embeds[0].timestamp).toBe('2026-10-23T15:00:00.000Z');
    expect(p.embeds[0].fields.map((f) => f.name)).toEqual(['Actual', 'Threshold', 'Window', 'Project']);
  });
});

describe('formatNtfy', () => {
  it('puts the message in the body and Title, Priority, Tags in headers', () => {
    const n = formatNtfy(alert());
    expect(n.body).toContain('5.0M output tokens');
    expect(n.headers).toEqual({ Title: 'unfirehose: output tokens over threshold (15 minutes)', Priority: '4', Tags: 'rotating_light' });
    expect(formatNtfy(alert({ actual_value: 2_600_000 })).headers.Priority).toBe('3');
    expect(formatNtfy(syntheticAlert(NOW)).headers.Tags).toBe('test_tube');
  });

  it('encodes a non-ASCII title as RFC 2047 so a header stays legal', () => {
    expect(encodeHeader('plain')).toBe('plain');
    const enc = encodeHeader('café ☕');
    expect(enc).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    expect(Buffer.from(enc.slice(10, -2), 'base64').toString('utf8')).toBe('café ☕');
  });
});

describe('buildRequest', () => {
  it('signs a webhook body with HMAC-SHA256 over timestamp.body', () => {
    const req = buildRequest('webhook', { url: 'https://example.test/hook' }, { hmacSecret: 'shhh-secret' }, alert(), NOW);
    expect(req.url).toBe('https://example.test/hook');
    expect(req.headers['Content-Type']).toBe('application/json');
    const ts = req.headers[TIMESTAMP_HEADER];
    expect(ts).toBe(String(NOW.getTime() / 1000));
    const expected = 'sha256=' + createHmac('sha256', 'shhh-secret').update(`${ts}.${req.body}`).digest('hex');
    expect(req.headers[SIGNATURE_HEADER]).toBe(expected);
    expect(signBody('shhh-secret', ts, req.body)).toBe(expected);
  });

  it('leaves the signature off when there is no secret', () => {
    const req = buildRequest('webhook', { url: 'http://localhost:9000/' }, {}, alert(), NOW);
    expect(req.headers[SIGNATURE_HEADER]).toBeUndefined();
  });

  it('posts ntfy to server/topic with a bearer token when given', () => {
    const req = buildRequest('ntfy', { server: 'https://ntfy.example.lan/', topic: 'fox-alerts' }, { token: 'tk_abc' }, alert(), NOW);
    expect(req.url).toBe('https://ntfy.example.lan/fox-alerts');
    expect(req.headers.Authorization).toBe('Bearer tk_abc');
    expect(req.headers.Priority).toBe('4');
    expect(ntfyUrl('https://ntfy.sh', 'a b')).toBe('https://ntfy.sh/a%20b');
  });

  it('sends Slack and Discord to their secret webhook URL', () => {
    const s = buildRequest('slack', {}, { webhookUrl: 'https://hooks.slack.com/services/T/B/X' }, alert(), NOW);
    expect(s.url).toBe('https://hooks.slack.com/services/T/B/X');
    expect(JSON.parse(s.body).blocks).toBeDefined();
    const d = buildRequest('discord', {}, { webhookUrl: 'https://discord.com/api/webhooks/1/abc' }, alert(), NOW);
    expect(JSON.parse(d.body).embeds).toHaveLength(1);
  });

  it('throws, naming the field, when a destination is missing what it needs', () => {
    expect(() => buildRequest('slack', {}, {}, alert(), NOW)).toThrow('slack needs a webhook URL');
    expect(() => buildRequest('ntfy', { server: 'https://ntfy.sh' }, {}, alert(), NOW)).toThrow('ntfy needs a server and a topic');
  });
});

describe('validation', () => {
  it('accepts http and https, including localhost and LAN, and nothing else', () => {
    expect(validateUrl('https://ntfy.sh')).toBeNull();
    expect(validateUrl('http://127.0.0.1:8080/hook')).toBeNull();
    expect(validateUrl('http://192.168.1.20/ntfy')).toBeNull();
    expect(validateUrl('file:///etc/passwd')).toMatch(/http/);
    expect(validateUrl('gopher://x')).toMatch(/http/);
    expect(validateUrl('not a url')).toBe('not a valid URL');
    expect(validateUrl('')).toBe('a URL is required');
    expect(validateUrl('https://user:pw@host/')).toMatch(/credentials/);
    expect(validateUrl('http://hooks.slack.com/x', { httpsOnly: true })).toBe('must be an https:// URL');
  });

  it('checks topics the way ntfy does', () => {
    expect(validateTopic('fox_alerts-1')).toBeNull();
    expect(validateTopic('has space')).not.toBeNull();
    expect(validateTopic('')).not.toBeNull();
  });

  it('names each bad field, and lets an edit keep a stored webhook URL', () => {
    expect(validateDestination('email', {}, {})).toEqual({ destination: 'one of webhook, ntfy, slack, discord' });
    expect(validateDestination('webhook', { url: 'ftp://x' }, { hmacSecret: 'short' })).toEqual({
      url: 'must be an http:// or https:// URL', hmacSecret: 'at least 8 characters',
    });
    expect(validateDestination('ntfy', { server: 'https://ntfy.sh', topic: 'x y' }, {})).toHaveProperty('topic');
    expect(validateDestination('slack', {}, {})).toEqual({ webhookUrl: 'a webhook URL is required' });
    expect(validateDestination('discord', {}, {}, (k) => k === 'webhookUrl')).toEqual({});
  });
});

describe('maskSecret', () => {
  it('keeps a URL host and at most four trailing characters', () => {
    expect(maskSecret('https://hooks.slack.com/services/T000/B000/XXXXabcd')).toBe('https://hooks.slack.com/••••abcd');
    expect(maskSecret('tk_0123456789abcdef')).toBe('••••cdef');
    expect(maskSecret('short-key')).toBe('••••');
    expect(maskSecret('')).toBeNull();
    expect(maskSecret(undefined)).toBeNull();
  });
});

describe('retry policy', () => {
  it('backs off 30s, 2m, 8m, 32m, then caps at an hour, and honours Retry-After', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => backoffMs(n) / 1000)).toEqual([30, 120, 480, 1920, 3600, 3600]);
    expect(backoffMs(1, 300_000)).toBe(300_000);
    expect(backoffMs(1, 10 * 3600_000)).toBe(3600_000);
  });

  it('retries network errors, throttles and 5xx, not other 4xx', () => {
    expect([null, 408, 429, 500, 503].map(isRetryable)).toEqual([true, true, true, true, true]);
    expect([400, 401, 403, 404, 410].map(isRetryable)).toEqual([false, false, false, false, false]);
  });
});
