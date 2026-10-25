/**
 * Alert delivery: what we send, where, and how it is signed.
 *
 * Pure functions only. Rules, attempts, retries and secrets live in
 * db/alert-delivery.ts; this file turns one alert row into one HTTP request
 * per destination, so every payload shape is testable without a database
 * or a network. Nothing here sends anything.
 *
 * Destinations: a generic webhook (JSON, optional HMAC-SHA256 signature),
 * ntfy (a public server or a self-hosted one), a Slack incoming webhook and
 * a Discord webhook. No email: that needs a sender we do not run.
 */
import { createHmac } from 'crypto';
import { formatTokens } from './format';
import { describeSecretAlert, isSecretAlert, parseSecretDetails } from './secret-alert';

export const DESTINATIONS = ['webhook', 'ntfy', 'slack', 'discord'] as const;
export type Destination = (typeof DESTINATIONS)[number];

/** The shape of a row in `alerts`, as much of it as a message needs. */
export interface AlertLike {
  id: number;
  triggered_at: string;
  alert_type: string;
  window_minutes: number;
  metric: string;
  threshold_value: number;
  actual_value: number;
  project_name: string | null;
  details?: string | null;
}

/** Non-secret settings, stored in the rule row and shown to the client. */
export interface DestinationConfig {
  /** webhook: where to POST. */
  url?: string;
  /** ntfy: server base, https://ntfy.sh or a self-hosted one. */
  server?: string;
  /** ntfy: topic name. */
  topic?: string;
}

/** Secret settings, stored apart from the rule and never sent back whole. */
export interface DestinationSecrets {
  /** slack, discord: the webhook URL is the credential. */
  webhookUrl?: string;
  /** webhook: HMAC-SHA256 key for the signature header. */
  hmacSecret?: string;
  /** ntfy: access token for a protected topic. */
  token?: string;
}

/** Which keys of DestinationSecrets each destination uses. */
export const SECRET_FIELDS: Record<Destination, (keyof DestinationSecrets)[]> = {
  webhook: ['hmacSecret'],
  ntfy: ['token'],
  slack: ['webhookUrl'],
  discord: ['webhookUrl'],
};

export interface OutboundRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export const SIGNATURE_HEADER = 'X-Unfirehose-Signature';
export const TIMESTAMP_HEADER = 'X-Unfirehose-Timestamp';
const USER_AGENT = 'unfirehose-alerts/1';

const METRIC_LABEL: Record<string, string> = {
  input_tokens: 'input tokens',
  output_tokens: 'output tokens',
  total_tokens: 'total tokens',
  cost_usd: 'cost (USD)',
};

export type Severity = 'normal' | 'high' | 'urgent';

export interface AlertSummary {
  title: string;
  message: string;
  severity: Severity;
  ratio: number | null;
  /** Where the alert's detail page lives on our dashboard. */
  path: string;
  test: boolean;
}

export function isTestAlert(a: AlertLike): boolean {
  return a.alert_type === 'test';
}

function windowLabel(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

function amount(metric: string, n: number): string {
  return metric === 'cost_usd' ? `$${n.toFixed(2)}` : formatTokens(Math.round(n));
}

/** One alert in words, shared by every destination so they all say the same thing. */
export function summarizeAlert(a: AlertLike): AlertSummary {
  if (isSecretAlert(a)) {
    // A credential seen in a session: its kind and where, never its value.
    const w = describeSecretAlert(a);
    return { title: w.title, message: w.message, severity: 'urgent', ratio: null, path: `/usage/alert/${a.id}`, test: false };
  }
  const label = METRIC_LABEL[a.metric] ?? a.metric.replace(/_/g, ' ');
  const ratio = a.threshold_value > 0 ? a.actual_value / a.threshold_value : null;
  const severity: Severity = ratio === null ? 'normal' : ratio >= 3 ? 'urgent' : ratio >= 1.5 ? 'high' : 'normal';
  const test = isTestAlert(a);
  const scope = a.project_name ? ` in ${a.project_name}` : '';
  const title = test
    ? 'unfirehose: test alert'
    : `unfirehose: ${label} over threshold (${windowLabel(a.window_minutes)})${scope}`;
  const ratioText = ratio === null ? '' : ` (${ratio.toFixed(1)}x)`;
  const body = `${amount(a.metric, a.actual_value)} ${label} in ${windowLabel(a.window_minutes)}, `
    + `over our ${amount(a.metric, a.threshold_value)} threshold${ratioText}.`;
  const message = test ? `This is a test from unfirehose. A real alert reads: ${body}` : body;
  return { title, message, severity, ratio, path: `/usage/alert/${a.id}`, test };
}

// ── Formatters, one per destination ──────────────────────────────────────

/** Generic webhook body: our alert row plus the words we would show. */
export function formatWebhook(a: AlertLike, sentAt: Date) {
  const s = summarizeAlert(a);
  let details: unknown = null;
  try { details = a.details ? JSON.parse(a.details) : null; } catch { details = a.details ?? null; }
  return {
    event: s.test ? 'alert.test' : 'alert.triggered',
    version: 1,
    sent_at: sentAt.toISOString(),
    title: s.title,
    message: s.message,
    severity: s.severity,
    path: s.path,
    alert: {
      id: a.id,
      triggered_at: a.triggered_at,
      alert_type: a.alert_type,
      window_minutes: a.window_minutes,
      metric: a.metric,
      threshold_value: a.threshold_value,
      actual_value: a.actual_value,
      ratio: s.ratio,
      project_name: a.project_name,
      details,
    },
  };
}

/** Slack incoming webhook: `text` is the notification fallback, blocks the card. */
export function formatSlack(a: AlertLike) {
  const s = summarizeAlert(a);
  const fields = isSecretAlert(a) ? secretFields(a).map(([k, v]) => ({ type: 'mrkdwn', text: `*${k}*\n${slackEscape(v)}` })) : [
    { type: 'mrkdwn', text: `*Metric*\n${METRIC_LABEL[a.metric] ?? a.metric}` },
    { type: 'mrkdwn', text: `*Window*\n${windowLabel(a.window_minutes)}` },
    { type: 'mrkdwn', text: `*Actual*\n${amount(a.metric, a.actual_value)}` },
    { type: 'mrkdwn', text: `*Threshold*\n${amount(a.metric, a.threshold_value)}` },
  ];
  if (a.project_name && !isSecretAlert(a)) fields.push({ type: 'mrkdwn', text: `*Project*\n${slackEscape(a.project_name)}` });
  return {
    text: `${s.title}: ${s.message}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: s.title.slice(0, 150) } },
      { type: 'section', text: { type: 'mrkdwn', text: slackEscape(s.message) } },
      { type: 'section', fields },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `alert #${a.id} · ${a.triggered_at} · severity ${s.severity}` }] },
    ],
  };
}

/** Card fields for a credential alert: kind, where, project, session, time. No value. */
function secretFields(a: AlertLike): Array<[string, string]> {
  const d = parseSecretDetails(a)!;
  const w = describeSecretAlert(a);
  return [
    ['Kind', w.kinds],
    ['Where', w.where],
    ['Project', d.projectDisplay || d.project || 'unknown'],
    ['Session', d.session ?? 'unknown'],
    ['Seen at', d.seenAt || a.triggered_at],
  ];
}

/** Slack treats <, > and & as markup; a project name must not become a link or a mention. */
function slackEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const DISCORD_COLOR: Record<Severity, number> = { normal: 0xf5a623, high: 0xe8590c, urgent: 0xd40000 };

/** Discord webhook: one embed, and no mention a project name could smuggle in. */
export function formatDiscord(a: AlertLike) {
  const s = summarizeAlert(a);
  const fields = isSecretAlert(a) ? secretFields(a).map(([name, value]) => ({ name, value: value.slice(0, 1024), inline: true })) : [
    { name: 'Actual', value: amount(a.metric, a.actual_value), inline: true },
    { name: 'Threshold', value: amount(a.metric, a.threshold_value), inline: true },
    { name: 'Window', value: windowLabel(a.window_minutes), inline: true },
  ];
  if (a.project_name && !isSecretAlert(a)) fields.push({ name: 'Project', value: a.project_name.slice(0, 1024), inline: true });
  return {
    username: 'unfirehose',
    content: s.title.slice(0, 2000),
    allowed_mentions: { parse: [] as string[] },
    embeds: [{
      title: s.title.slice(0, 256),
      description: s.message.slice(0, 4096),
      color: DISCORD_COLOR[s.severity],
      fields,
      footer: { text: `alert #${a.id}` },
      timestamp: toIso(a.triggered_at),
    }],
  };
}

/** SQLite's datetime('now') reads `2026-10-23 15:31:54`, which Discord rejects. */
function toIso(t: string): string {
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(t) ? `${t.replace(' ', 'T')}Z` : t;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

const NTFY_PRIORITY: Record<Severity, string> = { normal: '3', high: '4', urgent: '5' };

/** Header values must be latin1; ntfy decodes RFC 2047 for anything else. */
export function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** ntfy: the message is the body, everything else rides in headers. */
export function formatNtfy(a: AlertLike) {
  const s = summarizeAlert(a);
  return {
    body: s.message,
    headers: {
      Title: encodeHeader(s.title),
      Priority: NTFY_PRIORITY[s.severity],
      Tags: s.test ? 'test_tube' : isSecretAlert(a) ? 'key,rotating_light' : s.severity === 'normal' ? 'warning' : 'rotating_light',
    } as Record<string, string>,
  };
}

// ── Signing ──────────────────────────────────────────────────────────────

/**
 * `sha256=<hex>` over `${timestamp}.${body}`. The timestamp is signed so a
 * captured request cannot be replayed later with a fresh header. A receiver
 * recomputes it with the same secret and compares in constant time.
 */
export function signBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

// ── One alert, one destination, one request ──────────────────────────────

export function buildRequest(
  destination: Destination,
  config: DestinationConfig,
  secrets: DestinationSecrets,
  alert: AlertLike,
  now: Date = new Date(),
): OutboundRequest {
  const base = { 'User-Agent': USER_AGENT };
  switch (destination) {
    case 'webhook': {
      if (!config.url) throw new Error('webhook needs a url');
      const body = JSON.stringify(formatWebhook(alert, now));
      const timestamp = String(Math.floor(now.getTime() / 1000));
      const headers: Record<string, string> = {
        ...base,
        'Content-Type': 'application/json',
        'X-Unfirehose-Event': isTestAlert(alert) ? 'alert.test' : 'alert.triggered',
        [TIMESTAMP_HEADER]: timestamp,
      };
      if (secrets.hmacSecret) headers[SIGNATURE_HEADER] = signBody(secrets.hmacSecret, timestamp, body);
      return { url: config.url, method: 'POST', headers, body };
    }
    case 'ntfy': {
      if (!config.server || !config.topic) throw new Error('ntfy needs a server and a topic');
      const n = formatNtfy(alert);
      const headers: Record<string, string> = { ...base, 'Content-Type': 'text/plain; charset=utf-8', ...n.headers };
      if (secrets.token) headers.Authorization = `Bearer ${secrets.token}`;
      return { url: ntfyUrl(config.server, config.topic), method: 'POST', headers, body: n.body };
    }
    case 'slack':
    case 'discord': {
      if (!secrets.webhookUrl) throw new Error(`${destination} needs a webhook URL`);
      const payload = destination === 'slack' ? formatSlack(alert) : formatDiscord(alert);
      return {
        url: secrets.webhookUrl,
        method: 'POST',
        headers: { ...base, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      };
    }
  }
}

export function ntfyUrl(server: string, topic: string): string {
  return `${server.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`;
}

// ── Validation ───────────────────────────────────────────────────────────

/**
 * http or https, a host, no credentials in the URL. Localhost and LAN
 * addresses are allowed on purpose: this is a single-user app on our own
 * machine, a self-hosted ntfy or a receiver on the same box is a normal
 * destination, and whoever can create a rule can already reach those.
 */
export function validateUrl(raw: unknown, { httpsOnly = false } = {}): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'a URL is required';
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return 'not a valid URL'; }
  if (u.protocol !== 'https:' && (httpsOnly || u.protocol !== 'http:')) {
    return httpsOnly ? 'must be an https:// URL' : 'must be an http:// or https:// URL';
  }
  if (!u.hostname) return 'URL needs a host';
  if (u.username || u.password) return 'put credentials in the token field, not the URL';
  return null;
}

/** ntfy topics: what ntfy itself accepts, 1 to 64 of [-_A-Za-z0-9]. */
export function validateTopic(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^[-_A-Za-z0-9]{1,64}$/.test(raw)) return 'topic is 1 to 64 letters, digits, - or _';
  return null;
}

/**
 * Errors keyed by field, empty when the destination can be built.
 * `secrets` holds only what was sent in this request; `hasSecret` says
 * whether a stored one already covers a field left blank on an edit.
 */
export function validateDestination(
  destination: unknown,
  config: DestinationConfig,
  secrets: DestinationSecrets,
  hasSecret: (k: keyof DestinationSecrets) => boolean = () => false,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!DESTINATIONS.includes(destination as Destination)) {
    errors.destination = `one of ${DESTINATIONS.join(', ')}`;
    return errors;
  }
  const d = destination as Destination;
  if (d === 'webhook') {
    const e = validateUrl(config.url);
    if (e) errors.url = e;
    if (secrets.hmacSecret !== undefined && secrets.hmacSecret !== '' && secrets.hmacSecret.length < 8) {
      errors.hmacSecret = 'at least 8 characters';
    }
  }
  if (d === 'ntfy') {
    const e = validateUrl(config.server);
    if (e) errors.server = e;
    const t = validateTopic(config.topic);
    if (t) errors.topic = t;
  }
  if (d === 'slack' || d === 'discord') {
    if (secrets.webhookUrl) {
      const e = validateUrl(secrets.webhookUrl, { httpsOnly: true });
      if (e) errors.webhookUrl = e;
    } else if (!hasSecret('webhookUrl')) {
      errors.webhookUrl = 'a webhook URL is required';
    }
  }
  return errors;
}

// ── Showing a secret without showing it ──────────────────────────────────

/**
 * What the client sees of a stored secret. A URL keeps its host so we can
 * tell Slack from Discord from a typo; everything else keeps at most its
 * last four characters, and none at all when it is short enough that four
 * would be a real fraction of it.
 */
export function maskSecret(value: string | undefined | null): string | null {
  if (!value) return null;
  const tail = value.length >= 16 ? value.slice(-4) : '';
  try {
    const u = new URL(value);
    if (u.protocol === 'http:' || u.protocol === 'https:') return `${u.protocol}//${u.host}/••••${tail}`;
  } catch { /* not a URL */ }
  return `••••${tail}`;
}

// ── Retry policy ─────────────────────────────────────────────────────────

export const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 60 * 60_000;

/** Wait before attempt `attempts + 1`: 30 s, 2 min, 8 min, 32 min, capped at an hour. */
export function backoffMs(attempts: number, retryAfterMs?: number | null): number {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 4 ** Math.max(0, attempts - 1));
  if (retryAfterMs && retryAfterMs > 0) return Math.min(BACKOFF_CAP_MS, Math.max(exp, retryAfterMs));
  return exp;
}

/** A 4xx other than timeout or throttle will say the same thing next time. */
export function isRetryable(status: number | null): boolean {
  if (status === null) return true; // network error, timeout
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500;
}

/** A synthetic alert for the "Send test" button, shaped like a real one. */
export function syntheticAlert(now: Date = new Date()): AlertLike {
  return {
    id: 0,
    triggered_at: now.toISOString(),
    alert_type: 'test',
    window_minutes: 15,
    metric: 'output_tokens',
    threshold_value: 2_500_000,
    actual_value: 3_100_000,
    project_name: null,
    details: JSON.stringify({ test: true }),
  };
}
