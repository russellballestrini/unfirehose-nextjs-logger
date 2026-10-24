/**
 * Alert delivery rules, their secrets, and the loop that sends.
 *
 * Alerts were display-only: checkThresholds writes a row and a page shows
 * it. A rule here says which alerts (all, one threshold, one project) go to
 * which destination; deliverDue() runs from the worker after each tick,
 * sends what is new, records every attempt in alert_deliveries, retries
 * with backoff, and never sends one alert to one rule twice. Nothing is
 * sent unless a user has created a rule.
 *
 * Secrets — a Slack or Discord webhook URL, an ntfy token, an HMAC key —
 * are kept out of the database. Our browser vault cannot hold them (it is
 * encrypted in the browser and the worker never sees it), and the database
 * is copied, exported and seeded in ways a credential should not follow.
 * They live in one JSON file beside it, written 0600 under umask 077, and
 * leave this module only masked (maskSecret) or inside an outbound request.
 * Nothing here logs a secret or a destination URL. Operation Voyeur.
 */
import type Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { UNFIREHOSE_DIR } from './data-dir';
import {
  DESTINATIONS, SECRET_FIELDS, MAX_ATTEMPTS,
  buildRequest, backoffMs, isRetryable, maskSecret, syntheticAlert, validateDestination,
  type AlertLike, type Destination, type DestinationConfig, type DestinationSecrets, type OutboundRequest,
} from '../alert-delivery';

type Db = Database.Database;

// ── Secrets ──────────────────────────────────────────────────────────────

export interface SecretStore {
  get(ruleId: number): DestinationSecrets;
  set(ruleId: number, secrets: DestinationSecrets): void;
  delete(ruleId: number): void;
}

export function memorySecretStore(): SecretStore {
  const m = new Map<number, DestinationSecrets>();
  return {
    get: (id) => ({ ...(m.get(id) ?? {}) }),
    set: (id, s) => { m.set(id, { ...s }); },
    delete: (id) => { m.delete(id); },
  };
}

/** Where our alert secrets live. Read at call time so a test can move it. */
export function alertSecretsPath(): string {
  if (process.env.UNFIREHOSE_ALERT_SECRETS_PATH) return process.env.UNFIREHOSE_ALERT_SECRETS_PATH;
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    // Same guard as getDb(): a test must never write a real credential file.
    throw new Error('alert secrets reached ~/.unfirehose from a test. Set UNFIREHOSE_ALERT_SECRETS_PATH or use memorySecretStore().');
  }
  return path.join(UNFIREHOSE_DIR, 'alert-secrets.json');
}

/**
 * A JSON file `{ "<ruleId>": { ...secrets } }`, 0600. Written whole to a
 * temp file and renamed, so a crash mid-write leaves the old file intact.
 * A file found readable by group or other is tightened on read.
 */
export function fileSecretStore(file: string = alertSecretsPath()): SecretStore {
  const readAll = (): Record<string, DestinationSecrets> => {
    if (!existsSync(file)) return {};
    try {
      if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
    } catch { /* best effort */ }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };
  const writeAll = (all: Record<string, DestinationSecrets>) => {
    const old = process.umask(0o077);
    try {
      const dir = path.dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } finally {
      process.umask(old);
    }
  };
  return {
    get: (id) => ({ ...(readAll()[String(id)] ?? {}) }),
    set: (id, s) => { const all = readAll(); all[String(id)] = s; writeAll(all); },
    delete: (id) => { const all = readAll(); if (String(id) in all) { delete all[String(id)]; writeAll(all); } },
  };
}

// ── Rules ────────────────────────────────────────────────────────────────

/** 'secret' picks out credential alerts (secret_exposed), which carry it as their metric. */
export const MATCH_METRICS = ['input_tokens', 'output_tokens', 'total_tokens', 'cost_usd', 'secret'] as const;

interface RuleRow {
  id: number;
  name: string;
  enabled: number;
  destination: Destination;
  config: string;
  match_metric: string | null;
  match_window: number | null;
  match_project: string | null;
  rate_limit_per_hour: number;
  since_alert_id: number;
  created_at: string;
  updated_at: string;
}

/** A rule as the client sees it: config in full, secrets masked. */
export interface PublicRule {
  id: number;
  name: string;
  enabled: boolean;
  destination: Destination;
  config: DestinationConfig;
  match: { metric: string | null; window: number | null; project: string | null };
  rate_limit_per_hour: number;
  /** Each secret field this destination uses: masked, or null when unset. */
  secrets: Record<string, string | null>;
  created_at: string;
  updated_at: string;
  last: { status: string; http_status: number | null; error: string | null; at: string; is_test: boolean } | null;
  sent_24h: number;
  /** Gave up: a status that will not change, or out of retries. */
  failed_24h: number;
  /**
   * Not sent because the rule was over its per-hour limit in the last 24 h.
   * Dropped, not queued: the cap is a flood guard and a late alert is noise.
   */
  dropped_24h: number;
  /** When the most recent of those was dropped, or null. */
  last_dropped_at: string | null;
}

export interface RuleInput {
  name?: unknown;
  enabled?: unknown;
  destination?: unknown;
  config?: unknown;
  /** Only the fields being set. Absent or '' keeps what is stored; null clears. */
  secrets?: unknown;
  match?: unknown;
  rate_limit_per_hour?: unknown;
}

export type RuleResult = { ok: true; rule: PublicRule } | { ok: false; errors: Record<string, string> };

function pickConfig(d: Destination, raw: unknown): DestinationConfig {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const s = (k: string) => (typeof c[k] === 'string' ? (c[k] as string).trim() : undefined);
  if (d === 'webhook') return { url: s('url') };
  if (d === 'ntfy') return { server: s('server') || 'https://ntfy.sh', topic: s('topic') };
  return {};
}

/** Secrets in this request, split into what to set and what to clear. */
function pickSecrets(d: Destination, raw: unknown): { set: DestinationSecrets; clear: (keyof DestinationSecrets)[] } {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const set: DestinationSecrets = {};
  const clear: (keyof DestinationSecrets)[] = [];
  for (const k of SECRET_FIELDS[d]) {
    const v = c[k];
    if (v === null) clear.push(k);
    else if (typeof v === 'string' && v.trim()) set[k] = v.trim();
  }
  return { set, clear };
}

function pickMatch(raw: unknown, errors: Record<string, string>) {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  let metric: string | null = null;
  let window: number | null = null;
  let project: string | null = null;
  if (m.metric !== undefined && m.metric !== null && m.metric !== '') {
    if (MATCH_METRICS.includes(m.metric as (typeof MATCH_METRICS)[number])) metric = m.metric as string;
    else errors.match = `metric is one of ${MATCH_METRICS.join(', ')}`;
  }
  if (m.window !== undefined && m.window !== null && m.window !== '') {
    const w = Number(m.window);
    if (Number.isInteger(w) && w > 0 && w <= 1440) window = w;
    else errors.match = 'window is whole minutes, 1 to 1440';
  }
  if (typeof m.project === 'string' && m.project.trim()) {
    project = m.project.trim().slice(0, 200);
  }
  return { metric, window, project };
}

function pickRateLimit(raw: unknown, fallback: number, errors: Record<string, string>): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 600) { errors.rate_limit_per_hour = '1 to 600 per hour'; return fallback; }
  return n;
}

function maxAlertId(db: Db): number {
  return (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM alerts').get() as { m: number }).m;
}

function toPublic(db: Db, store: SecretStore, r: RuleRow, now: Date): PublicRule {
  const secrets = store.get(r.id);
  const masked: Record<string, string | null> = {};
  for (const k of SECRET_FIELDS[r.destination] ?? []) masked[k] = maskSecret(secrets[k]);
  const last = db.prepare(
    `SELECT status, http_status, error, updated_at AS at, is_test FROM alert_deliveries
     WHERE rule_id = ? AND status != 'pending' ORDER BY updated_at DESC, id DESC LIMIT 1`,
  ).get(r.id) as { status: string; http_status: number | null; error: string | null; at: string; is_test: number } | undefined;
  const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const counts = db.prepare(
    `SELECT SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) AS dropped,
            MAX(CASE WHEN status = 'rate_limited' THEN updated_at END) AS last_dropped_at
     FROM alert_deliveries WHERE rule_id = ? AND is_test = 0 AND updated_at >= ?`,
  ).get(r.id, since) as { sent: number | null; failed: number | null; dropped: number | null; last_dropped_at: string | null };
  let config: DestinationConfig = {};
  try { config = JSON.parse(r.config); } catch { /* keep empty */ }
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled === 1,
    destination: r.destination,
    config,
    match: { metric: r.match_metric, window: r.match_window, project: r.match_project },
    rate_limit_per_hour: r.rate_limit_per_hour,
    secrets: masked,
    created_at: r.created_at,
    updated_at: r.updated_at,
    last: last ? { ...last, is_test: last.is_test === 1 } : null,
    sent_24h: counts.sent ?? 0,
    failed_24h: counts.failed ?? 0,
    dropped_24h: counts.dropped ?? 0,
    last_dropped_at: counts.last_dropped_at ?? null,
  };
}

function getRuleRow(db: Db, id: number): RuleRow | undefined {
  return db.prepare('SELECT * FROM alert_delivery_rules WHERE id = ?').get(id) as RuleRow | undefined;
}

export function listRules(db: Db, store: SecretStore, now = new Date()): PublicRule[] {
  const rows = db.prepare('SELECT * FROM alert_delivery_rules ORDER BY id').all() as RuleRow[];
  return rows.map((r) => toPublic(db, store, r, now));
}

export function getRule(db: Db, store: SecretStore, id: number, now = new Date()): PublicRule | null {
  const r = getRuleRow(db, id);
  return r ? toPublic(db, store, r, now) : null;
}

export function createRule(db: Db, store: SecretStore, input: RuleInput, now = new Date()): RuleResult {
  const errors: Record<string, string> = {};
  if (!DESTINATIONS.includes(input.destination as Destination)) {
    return { ok: false, errors: { destination: `one of ${DESTINATIONS.join(', ')}` } };
  }
  const d = input.destination as Destination;
  const config = pickConfig(d, input.config);
  const { set } = pickSecrets(d, input.secrets);
  Object.assign(errors, validateDestination(d, config, set));
  const match = pickMatch(input.match, errors);
  const rate = pickRateLimit(input.rate_limit_per_hour, 10, errors);
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 80) : d;
  if (Object.keys(errors).length) return { ok: false, errors };

  const iso = now.toISOString();
  const id = db.prepare(
    `INSERT INTO alert_delivery_rules
       (name, enabled, destination, config, match_metric, match_window, match_project, rate_limit_per_hour, since_alert_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(name, input.enabled === false ? 0 : 1, d, JSON.stringify(config), match.metric, match.window, match.project, rate, maxAlertId(db), iso, iso)
    .lastInsertRowid as number;
  if (Object.keys(set).length) store.set(id, set);
  return { ok: true, rule: getRule(db, store, id, now)! };
}

export function updateRule(db: Db, store: SecretStore, id: number, input: RuleInput, now = new Date()): RuleResult | null {
  const row = getRuleRow(db, id);
  if (!row) return null;
  const errors: Record<string, string> = {};
  const d = row.destination; // a rule's destination is what it is; make a new rule to change it
  if (input.destination !== undefined && input.destination !== d) {
    return { ok: false, errors: { destination: 'cannot change; create a new rule' } };
  }
  let config: DestinationConfig = JSON.parse(row.config || '{}');
  if (input.config !== undefined) config = pickConfig(d, { ...config, ...(input.config as object) });
  const stored = store.get(id);
  const { set, clear } = pickSecrets(d, input.secrets);
  const after: DestinationSecrets = { ...stored, ...set };
  for (const k of clear) delete after[k];
  Object.assign(errors, validateDestination(d, config, set, (k) => Boolean(after[k])));
  const match = input.match !== undefined
    ? pickMatch(input.match, errors)
    : { metric: row.match_metric, window: row.match_window, project: row.match_project };
  const rate = pickRateLimit(input.rate_limit_per_hour, row.rate_limit_per_hour, errors);
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 80) : row.name;
  const enabled = input.enabled === undefined ? row.enabled === 1 : input.enabled === true;
  if (Object.keys(errors).length) return { ok: false, errors };

  // Re-enabling starts from now: alerts that fired while a rule was off are
  // history, and sending them all at once is the flood we promise not to send.
  const since = enabled && row.enabled === 0 ? maxAlertId(db) : row.since_alert_id;
  db.prepare(
    `UPDATE alert_delivery_rules SET name = ?, enabled = ?, config = ?, match_metric = ?, match_window = ?,
       match_project = ?, rate_limit_per_hour = ?, since_alert_id = ?, updated_at = ? WHERE id = ?`,
  ).run(name, enabled ? 1 : 0, JSON.stringify(config), match.metric, match.window, match.project, rate, since, now.toISOString(), id);
  if (set && (Object.keys(set).length || clear.length)) store.set(id, after);
  return { ok: true, rule: getRule(db, store, id, now)! };
}

export function deleteRule(db: Db, store: SecretStore, id: number): boolean {
  const changed = db.transaction(() => {
    db.prepare('DELETE FROM alert_deliveries WHERE rule_id = ?').run(id);
    return db.prepare('DELETE FROM alert_delivery_rules WHERE id = ?').run(id).changes;
  })();
  store.delete(id);
  return changed > 0;
}

export interface DeliveryRow {
  id: number;
  alert_id: number | null;
  rule_id: number;
  is_test: number;
  status: string;
  http_status: number | null;
  error: string | null;
  attempts: number;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

export function listDeliveries(db: Db, opts: { ruleId?: number; limit?: number } = {}): DeliveryRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  if (opts.ruleId) {
    return db.prepare('SELECT * FROM alert_deliveries WHERE rule_id = ? ORDER BY id DESC LIMIT ?').all(opts.ruleId, limit) as DeliveryRow[];
  }
  return db.prepare('SELECT * FROM alert_deliveries ORDER BY id DESC LIMIT ?').all(limit) as DeliveryRow[];
}

// ── Sending ──────────────────────────────────────────────────────────────

export interface SendResult {
  /** HTTP status, or null when no response came back (DNS, refused, timeout). */
  status: number | null;
  error?: string;
  retryAfterMs?: number | null;
}

/** The one thing that touches a network. Injected everywhere so tests never do. */
export type Sender = (req: OutboundRequest) => Promise<SendResult>;

const SEND_TIMEOUT_MS = 10_000;

/** Strip a destination URL out of anything we are about to store or show. */
export function scrubError(message: string, req?: OutboundRequest): string {
  let m = message;
  if (req?.url) {
    m = m.split(req.url).join('[destination]');
    try {
      const u = new URL(req.url);
      if (u.pathname.length > 1) m = m.split(u.pathname).join('/[path]');
    } catch { /* not a URL */ }
  }
  return m.replace(/https?:\/\/\S+/g, '[url]').slice(0, 300);
}

/**
 * fetch with a deadline, no redirects followed (a 3xx is reported, so a
 * destination cannot bounce us somewhere the rule did not name), and a
 * short read of an error body for the attempt log.
 */
export const httpSend: Sender = async (req) => {
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.status >= 200 && res.status < 300) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status };
    }
    const ra = res.headers.get('retry-after');
    const retryAfterMs = ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : null;
    const text = (await res.text().catch(() => '')).slice(0, 200);
    return { status: res.status, error: scrubError(`HTTP ${res.status}${text ? `: ${text}` : ''}`, req), retryAfterMs };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const why = e.name === 'TimeoutError' ? `timed out after ${SEND_TIMEOUT_MS / 1000}s`
      : e.cause?.code ? `${e.message} (${e.cause.code})` : e.message;
    return { status: null, error: scrubError(why || 'send failed', req) };
  }
};

/** Build and send one alert for one rule. Shared by the loop and "Send test". */
async function deliverOne(
  row: RuleRow, alert: AlertLike, store: SecretStore, send: Sender, now: Date,
): Promise<SendResult & { ok: boolean; retryable: boolean }> {
  let req: OutboundRequest;
  try {
    req = buildRequest(row.destination, JSON.parse(row.config || '{}'), store.get(row.id), alert, now);
  } catch (err) {
    return { ok: false, retryable: false, status: null, error: scrubError((err as Error).message) };
  }
  let r: SendResult;
  try {
    r = await send(req);
  } catch (err) {
    r = { status: null, error: (err as Error).message };
  }
  const ok = r.status !== null && r.status >= 200 && r.status < 300;
  return {
    ...r,
    error: r.error ? scrubError(r.error, req) : ok ? undefined : `HTTP ${r.status}`,
    ok,
    retryable: !ok && isRetryable(r.status),
  };
}

export interface DeliverySummary {
  rules: number;
  queued: number;
  sent: number;
  retrying: number;
  failed: number;
  rateLimited: number;
}

const DUE_PER_RULE_PER_TICK = 25;
const KEEP_DELIVERIES_DAYS = 30;

/**
 * One tick of our delivery loop. Queue alerts newer than each enabled
 * rule's starting point that match it (one row per alert and rule, so a
 * second tick queues nothing twice), then send what is due, oldest first.
 *
 * - 2xx: sent.
 * - network error, timeout, 408/425/429, 5xx: retried with backoff
 *   (backoffMs, honouring Retry-After) until MAX_ATTEMPTS, then failed.
 * - any other status: failed now; it will not answer differently later.
 * - over the rule's per-hour limit: rate_limited, not sent and not retried.
 *   A late alert about a spike an hour ago is noise; the limit is a flood
 *   guard, not a queue.
 */
export async function deliverDue(
  db: Db,
  store: SecretStore,
  send: Sender = httpSend,
  now: Date = new Date(),
): Promise<DeliverySummary> {
  const summary: DeliverySummary = { rules: 0, queued: 0, sent: 0, retrying: 0, failed: 0, rateLimited: 0 };
  const rules = db.prepare('SELECT * FROM alert_delivery_rules WHERE enabled = 1 ORDER BY id').all() as RuleRow[];
  summary.rules = rules.length;
  if (!rules.length) return summary;
  const iso = now.toISOString();

  // An alert cleared before we reached it has nothing left to say.
  db.prepare(
    `UPDATE alert_deliveries SET status = 'failed', error = 'alert cleared before delivery', next_retry_at = NULL, updated_at = ?
     WHERE status = 'pending' AND alert_id IS NOT NULL AND alert_id NOT IN (SELECT id FROM alerts)`,
  ).run(iso);

  const enqueue = db.prepare(
    `INSERT OR IGNORE INTO alert_deliveries (alert_id, rule_id, status, next_retry_at, created_at, updated_at)
     SELECT a.id, @rule, 'pending', @now, @now, @now FROM alerts a
     WHERE a.id > @since
       AND (@metric IS NULL OR a.metric = @metric)
       AND (@window IS NULL OR a.window_minutes = @window)
       AND (@project IS NULL OR a.project_name = @project
            OR a.project_name IN (SELECT name FROM projects WHERE display_name = @project))`,
  );
  const due = db.prepare(
    `SELECT d.id AS delivery_id, d.attempts, a.* FROM alert_deliveries d JOIN alerts a ON a.id = d.alert_id
     WHERE d.rule_id = ? AND d.status = 'pending' AND d.next_retry_at <= ?
     ORDER BY d.id LIMIT ?`,
  );
  const sentInHour = db.prepare(
    `SELECT COUNT(*) AS c FROM alert_deliveries
     WHERE rule_id = ? AND is_test = 0 AND status = 'sent' AND delivered_at >= ?`,
  );
  const mark = db.prepare(
    `UPDATE alert_deliveries SET status = @status, http_status = @http, error = @error, attempts = @attempts,
       next_retry_at = @next, delivered_at = @delivered, updated_at = @now WHERE id = @id`,
  );

  for (const rule of rules) {
    summary.queued += enqueue.run({
      rule: rule.id, now: iso, since: rule.since_alert_id,
      metric: rule.match_metric, window: rule.match_window, project: rule.match_project,
    }).changes;

    const rows = due.all(rule.id, iso, DUE_PER_RULE_PER_TICK) as Array<AlertLike & { delivery_id: number; attempts: number }>;
    if (!rows.length) continue;
    let sentThisHour = (sentInHour.get(rule.id, new Date(now.getTime() - 3600_000).toISOString()) as { c: number }).c;

    for (const row of rows) {
      const base = { id: row.delivery_id, now: iso, delivered: null as string | null, next: null as string | null };
      if (sentThisHour >= rule.rate_limit_per_hour) {
        mark.run({ ...base, status: 'rate_limited', http: null, attempts: row.attempts,
          error: `over this rule's limit of ${rule.rate_limit_per_hour} per hour` });
        summary.rateLimited++;
        continue;
      }
      const r = await deliverOne(rule, row, store, send, now);
      const attempts = row.attempts + 1;
      if (r.ok) {
        mark.run({ ...base, status: 'sent', http: r.status, error: null, attempts, delivered: iso });
        sentThisHour++;
        summary.sent++;
      } else if (r.retryable && attempts < MAX_ATTEMPTS) {
        const next = new Date(now.getTime() + backoffMs(attempts, r.retryAfterMs)).toISOString();
        mark.run({ ...base, status: 'pending', http: r.status, error: r.error ?? null, attempts, next });
        summary.retrying++;
      } else {
        mark.run({ ...base, status: 'failed', http: r.status, error: r.error ?? null, attempts });
        summary.failed++;
      }
    }
  }

  db.prepare(`DELETE FROM alert_deliveries WHERE status != 'pending' AND updated_at < ?`)
    .run(new Date(now.getTime() - KEEP_DELIVERIES_DAYS * 86_400_000).toISOString());
  return summary;
}

export interface TestResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

/**
 * "Send test": a synthetic alert through the same build, sign and send as
 * a real one, once, no retry. Recorded as a test attempt so the rule's
 * last-result line reflects it; it never counts against the rate limit.
 * Works on a disabled rule, so a destination can be checked before it is on.
 */
export async function sendTestAlert(
  db: Db, store: SecretStore, ruleId: number, send: Sender = httpSend, now: Date = new Date(),
): Promise<TestResult | null> {
  const row = getRuleRow(db, ruleId);
  if (!row) return null;
  const r = await deliverOne(row, syntheticAlert(now), store, send, now);
  const iso = now.toISOString();
  db.prepare(
    `INSERT INTO alert_deliveries (alert_id, rule_id, is_test, status, http_status, error, attempts, created_at, updated_at, delivered_at)
     VALUES (NULL, ?, 1, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(ruleId, r.ok ? 'sent' : 'failed', r.status, r.error ?? null, iso, iso, r.ok ? iso : null);
  return { ok: r.ok, status: r.status, error: r.error ?? null };
}

/** Cheap check for the worker: skip the whole tick while nobody has a rule. */
export function hasEnabledRules(db: Db): boolean {
  return Boolean(db.prepare('SELECT 1 FROM alert_delivery_rules WHERE enabled = 1 LIMIT 1').get());
}
