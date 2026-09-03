/**
 * Vendor status pages, polled.
 *
 * Our refusals page says what WE hit; this says what the vendor admits to.
 * Side by side they answer "is it me or them" without six browser tabs.
 *
 * Scope is language-model vendors only — unfirehose measures model usage,
 * and a person's git host or CDN belongs to a different tool.
 *
 * Source of truth is the incident feed (`/history.atom`), not the Statuspage
 * JSON API: Atlassian's default robots.txt disallows `/api/` on several hosts
 * (status.claude.com among them) and our rule is that a disallow means we do
 * not fetch. The feed carries every incident with its update trail; what it
 * lacks is per-component state, so the indicator here is inferred from the
 * open incidents' titles rather than read from the vendor's own light.
 *
 * robots.txt is fetched per host, cached for a day, and honoured for every
 * path we touch. A target whose path becomes disallowed reads
 * `blocked_by_robots` on the page instead of being fetched.
 */

import type Database from 'better-sqlite3';

export type StatusIndicator =
  | 'none'        // no open incident
  | 'minor'       // open incident: degraded / elevated errors
  | 'major'       // open incident: outage / unavailable
  | 'unknown'     // fetched, could not parse
  | 'unreachable' // network error, timeout, non-2xx
  | 'blocked_by_robots';

export const INDICATOR_RANK: Record<StatusIndicator, number> = {
  none: 0, unknown: 1, blocked_by_robots: 1, unreachable: 2, minor: 2, major: 3,
};

export interface StatusTarget {
  /** Stable id, also the refusals `provider` / `upstream` name it maps to. */
  id: string;
  name: string;
  /** Human page. */
  url: string;
  /** What to fetch. `statuspage-feed` is an Atlassian Statuspage history.atom. */
  kind: 'statuspage-feed';
  feed: string;
  note?: string;
}

export interface StatusIncident {
  title: string;
  status: string;      // Investigating | Identified | Monitoring | Update | Resolved | ACTIVE | …
  updatedAt: string;
  link: string | null;
  open: boolean;
  /** The vendor's own severity word when the feed carries one (xAI: outage | degraded). */
  severity?: string;
}

export interface StatusPoll {
  targetId: string;
  timestamp: string;
  indicator: StatusIndicator;
  description: string;
  incidents: StatusIncident[];
  httpStatus: number | null;
  latencyMs: number | null;
}

/**
 * Feeds verified 2026-09-03. OpenRouter is listed so its absence is visible
 * rather than silent: status.openrouter.ai is not a Statuspage host and
 * reads `unreachable` until someone finds a machine path.
 */
export const DEFAULT_STATUS_TARGETS: StatusTarget[] = [
  { id: 'anthropic',  name: 'Anthropic',  url: 'https://status.claude.com',      kind: 'statuspage-feed', feed: 'https://status.claude.com/history.atom' },
  { id: 'openai',     name: 'OpenAI',     url: 'https://status.openai.com',      kind: 'statuspage-feed', feed: 'https://status.openai.com/history.atom' },
  // Custom Next.js site; the root is Cloudflare-walled but the RSS the page
  // advertises in its <head> is open. One item per affected component.
  { id: 'x-ai',       name: 'xAI / Grok', url: 'https://status.x.ai',            kind: 'statuspage-feed', feed: 'https://status.x.ai/feed.xml' },
  { id: 'openrouter', name: 'OpenRouter', url: 'https://status.openrouter.ai',   kind: 'statuspage-feed', feed: 'https://status.openrouter.ai/history.atom',
    note: 'Not an Atlassian Statuspage host; feed path unknown.' },
];

export const STATUS_TARGETS_SETTING = 'status_targets';

interface TargetOverrides { added?: StatusTarget[]; removed?: string[] }

/** Defaults plus the human's additions, minus their removals. */
export function resolveStatusTargets(overridesJson: string | null): StatusTarget[] {
  let o: TargetOverrides = {};
  try { o = overridesJson ? JSON.parse(overridesJson) : {}; } catch { o = {}; }
  const removed = new Set(o.removed ?? []);
  const byId = new Map<string, StatusTarget>();
  for (const t of DEFAULT_STATUS_TARGETS) if (!removed.has(t.id)) byId.set(t.id, t);
  for (const t of o.added ?? []) {
    if (!t || typeof t.id !== 'string' || typeof t.feed !== 'string') continue;
    if (removed.has(t.id)) continue;
    byId.set(t.id, { id: t.id, feed: t.feed, kind: 'statuspage-feed', url: t.url ?? t.feed, name: t.name ?? t.id, note: t.note });
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------- robots.txt

/**
 * Is `path` allowed for `User-agent: *`? Longest-match between Allow and
 * Disallow, per the de-facto rule; an empty Disallow allows everything. We
 * carry no agent name of our own, so the wildcard group is the one that
 * applies.
 */
export function robotsAllows(robotsTxt: string, path: string): boolean {
  let inStar = false;
  let best: { allow: boolean; len: number } | null = null;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') { inStar = val === '*'; continue; }
    if (!inStar) continue;
    if (key !== 'allow' && key !== 'disallow') continue;
    if (val === '') continue;
    const prefix = val.replace(/\$$/, '');
    const matches = val.endsWith('$') ? path === prefix : path.startsWith(prefix);
    if (!matches) continue;
    if (!best || prefix.length > best.len) best = { allow: key === 'allow', len: prefix.length };
  }
  return best ? best.allow : true;
}

type Fetcher = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ status: number; text(): Promise<string> }>;

const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const robotsCache = new Map<string, { at: number; txt: string | null }>();

async function robotsFor(host: string, fetchImpl: Fetcher, timeoutMs: number): Promise<string | null> {
  const hit = robotsCache.get(host);
  if (hit && Date.now() - hit.at < ROBOTS_TTL_MS) return hit.txt;
  let txt: string | null = null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetchImpl(`https://${host}/robots.txt`, { signal: ctl.signal, headers: UA });
    clearTimeout(t);
    txt = res.status >= 200 && res.status < 300 ? await res.text() : null;
  } catch { txt = null; }
  robotsCache.set(host, { at: Date.now(), txt });
  return txt;
}

/** Test hook. */
export function _resetRobotsCache() { robotsCache.clear(); }

const UA = { 'user-agent': 'unfirehose-status-poller (+https://unfirehose.com)' };

// ------------------------------------------------------------- feed parsing

const RESOLVED = /^(resolved|completed|postmortem)$/i;
const MAJOR_WORDS = /\b(outage|down|unavailable|offline|not available|major)\b/i;

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function stripCdata(s: string): string {
  return s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? stripCdata(m[1]).trim() : null;
}

/**
 * Parse an incident-history Atom feed. Two generators seen in the wild:
 *
 * - Atlassian Statuspage (status.claude.com): `<content>` is HTML listing
 *   updates newest first as `<strong>Status</strong> - text`; the first
 *   strong is the incident's current state.
 * - incident.io (status.openai.com): CDATA everywhere, `<b>Status:
 *   Investigating</b>` at the top of `<summary>`/`<content>`, and an
 *   "Affected components" list. Resolved incidents stay in the feed with
 *   `Status: Resolved`.
 */
export function parseStatuspageFeed(xml: string): StatusIncident[] {
  const out: StatusIncident[] = [];
  const entries = xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) ?? [];
  for (const e of entries) {
    const title = decodeEntities(tag(e, 'title') ?? '').replace(/<[^>]+>/g, '').trim();
    const updatedAt = tag(e, 'updated') ?? tag(e, 'published') ?? '';
    const link = /<link[^>]*href="([^"]+)"/i.exec(e)?.[1]?.replace(/(?<!:)\/\//g, '/') ?? null;
    const content = decodeEntities(tag(e, 'content') ?? tag(e, 'summary') ?? '');
    const status =
      /<strong>\s*([^<]{1,40}?)\s*<\/strong>/i.exec(content)?.[1]?.trim()
      ?? /<b>\s*Status:\s*([^<]{1,40}?)\s*<\/b>/i.exec(content)?.[1]?.trim()
      ?? 'Unknown';
    out.push({ title, status, updatedAt, link, open: !RESOLVED.test(status) });
  }
  // RSS 2.0 (status.x.ai, a custom site): one <item> per affected component,
  // `<h3>Status: ACTIVE</h3>` and `<p>Severity: outage</p>` in the
  // description, the state repeated as <category> tags.
  const items = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) ?? [];
  for (const it of items) {
    const title = decodeEntities(tag(it, 'title') ?? '').replace(/<[^>]+>/g, '').trim();
    const pub = tag(it, 'pubDate') ?? '';
    const ms = Date.parse(pub);
    const updatedAt = Number.isNaN(ms) ? pub : new Date(ms).toISOString();
    const link = tag(it, 'link');
    const desc = decodeEntities(tag(it, 'description') ?? '');
    const status = /Status:\s*([A-Za-z_ -]{1,40}?)\s*</i.exec(desc)?.[1]?.trim() ?? 'Unknown';
    const severity = /Severity:\s*([A-Za-z_ -]{1,40}?)\s*</i.exec(desc)?.[1]?.trim().toLowerCase();
    const cats = [...it.matchAll(/<category>([^<]+)<\/category>/gi)].map((m) => m[1].trim().toLowerCase());
    const open = cats.includes('resolved') ? false : cats.includes('active') ? true : !RESOLVED.test(status);
    out.push({ title, status: status.charAt(0).toUpperCase() + status.slice(1).toLowerCase(), updatedAt, link, open, severity });
  }
  return out;
}

/** Roll open incidents up to one light. Titles decide minor vs major. */
export function inferIndicator(incidents: StatusIncident[]): { indicator: StatusIndicator; description: string } {
  const open = incidents.filter((i) => i.open);
  if (open.length === 0) return { indicator: 'none', description: 'No open incidents' };
  const major = open.some((i) => i.severity ? /outage|major|critical/.test(i.severity) : MAJOR_WORDS.test(i.title));
  const lead = open[0];
  const more = open.length > 1 ? ` (+${open.length - 1} more)` : '';
  return { indicator: major ? 'major' : 'minor', description: `${lead.status}: ${lead.title}${more}` };
}

// ------------------------------------------------------------------ polling

export async function pollStatusTarget(
  target: StatusTarget,
  opts: { fetchImpl?: Fetcher; timeoutMs?: number; now?: Date } = {},
): Promise<StatusPoll> {
  const fetchImpl: Fetcher = opts.fetchImpl ?? (globalThis.fetch as unknown as Fetcher);
  const timeoutMs = opts.timeoutMs ?? 8000;
  const timestamp = (opts.now ?? new Date()).toISOString();
  const base = { targetId: target.id, timestamp, incidents: [] as StatusIncident[] };

  const u = new URL(target.feed);
  const robots = await robotsFor(u.host, fetchImpl, timeoutMs);
  if (robots !== null && !robotsAllows(robots, u.pathname)) {
    return { ...base, indicator: 'blocked_by_robots', description: `robots.txt disallows ${u.pathname}`, httpStatus: null, latencyMs: null };
  }

  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetchImpl(target.feed, { signal: ctl.signal, headers: UA });
    clearTimeout(t);
    const latencyMs = Date.now() - t0;
    if (res.status < 200 || res.status >= 300) {
      return { ...base, indicator: 'unreachable', description: `HTTP ${res.status}`, httpStatus: res.status, latencyMs };
    }
    const body = await res.text();
    if (!/<(?:feed|rss)[\s>]/i.test(body)) {
      return { ...base, indicator: 'unknown', description: 'Response is not an Atom or RSS feed', httpStatus: res.status, latencyMs };
    }
    const incidents = parseStatuspageFeed(body).slice(0, 20);
    const { indicator, description } = inferIndicator(incidents);
    return { ...base, indicator, description, incidents, httpStatus: res.status, latencyMs };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { ...base, indicator: 'unreachable', description: aborted ? `timeout after ${timeoutMs}ms` : String(err instanceof Error ? err.message : err).slice(0, 200), httpStatus: null, latencyMs: Date.now() - t0 };
  }
}

// ---------------------------------------------------------------- storage

export function recordStatusPoll(db: Database.Database, p: StatusPoll): void {
  db.prepare(`
    INSERT INTO status_polls (timestamp, target_id, indicator, description, http_status, latency_ms, incidents_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(p.timestamp, p.targetId, p.indicator, p.description, p.httpStatus, p.latencyMs, JSON.stringify(p.incidents));
}

export interface StatusCurrent extends StatusTarget {
  poll: StatusPoll | null;
  /** When the current indicator began — the oldest consecutive poll with it. */
  since: string | null;
}

export function getStatusTargets(db: Database.Database): StatusTarget[] {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(STATUS_TARGETS_SETTING) as { value: string } | undefined;
  return resolveStatusTargets(row?.value ?? null);
}

export function getStatusCurrent(db: Database.Database): StatusCurrent[] {
  const latest = db.prepare(`
    SELECT timestamp, target_id, indicator, description, http_status, latency_ms, incidents_json
      FROM status_polls WHERE target_id = ? ORDER BY timestamp DESC LIMIT 1
  `);
  // First poll of the current run of this indicator.
  const since = db.prepare(`
    SELECT MIN(timestamp) AS since FROM status_polls
     WHERE target_id = ? AND timestamp > COALESCE(
       (SELECT MAX(timestamp) FROM status_polls WHERE target_id = ? AND indicator != ?), '')
  `);
  return getStatusTargets(db).map((t) => {
    const r = latest.get(t.id) as any;
    if (!r) return { ...t, poll: null, since: null };
    const poll: StatusPoll = {
      targetId: t.id, timestamp: r.timestamp, indicator: r.indicator, description: r.description,
      httpStatus: r.http_status, latencyMs: r.latency_ms,
      incidents: (() => { try { return JSON.parse(r.incidents_json ?? '[]'); } catch { return []; } })(),
    };
    const s = since.get(t.id, t.id, r.indicator) as { since: string | null };
    return { ...t, poll, since: s?.since ?? r.timestamp };
  }).sort((a, b) => INDICATOR_RANK[b.poll?.indicator ?? 'unknown'] - INDICATOR_RANK[a.poll?.indicator ?? 'unknown']);
}

export function getStatusHistory(db: Database.Database, targetId: string, hours: number) {
  return db.prepare(`
    SELECT timestamp, indicator, description, http_status, latency_ms
      FROM status_polls
     WHERE target_id = ? AND timestamp >= datetime('now', '-' || ? || ' hours')
     ORDER BY timestamp
  `).all(targetId, Math.max(1, Math.min(hours, 24 * 28)));
}

/** Raw polls older than 28 days fold into one row per hour: the worst light. */
export function rollupStatusPolls(db: Database.Database, keepDays = 28): number {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
  return db.transaction(() => {
    db.prepare(`
      INSERT OR REPLACE INTO status_polls_hourly (hour, target_id, worst_indicator, polls, unreachable)
      SELECT substr(timestamp, 1, 13) AS hour, target_id,
             CASE MAX(CASE indicator WHEN 'major' THEN 3 WHEN 'minor' THEN 2 WHEN 'unreachable' THEN 2 WHEN 'none' THEN 0 ELSE 1 END)
               WHEN 3 THEN 'major' WHEN 2 THEN 'minor' WHEN 0 THEN 'none' ELSE 'unknown' END,
             COUNT(*),
             SUM(CASE WHEN indicator = 'unreachable' THEN 1 ELSE 0 END)
        FROM status_polls WHERE timestamp < ? GROUP BY hour, target_id
    `).run(cutoff);
    return db.prepare('DELETE FROM status_polls WHERE timestamp < ?').run(cutoff).changes;
  })();
}

/** One worker tick: poll every target, record each. Never throws. */
export async function pollAllStatusTargets(db: Database.Database, opts: { fetchImpl?: Fetcher } = {}): Promise<StatusPoll[]> {
  const targets = getStatusTargets(db);
  const polls = await Promise.all(targets.map((t) => pollStatusTarget(t, opts)));
  for (const p of polls) {
    try { recordStatusPoll(db, p); } catch { /* one bad row must not stop the tick */ }
  }
  return polls;
}
