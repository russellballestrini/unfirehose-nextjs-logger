// Detecting rate-limit events in harness output.
//
// When a provider throttles us the harness prints it, we ingest the text, and
// then nothing ever looks at it again — 20,053 content blocks in our database
// mention 429 or rate_limit and not one of them is queryable as an event. So
// "how often are we throttled, by whom, and when" has no answer, which is the
// wrong state for a system whose whole cost strategy is routing work between
// providers.
//
// Precision matters more than recall here. Most of those 20,053 blocks are not
// events at all: they are commit messages about fixing rate limiting, file
// listings that happen to contain "429", and agents discussing M_LIMIT_EXCEEDED
// in prose. A detector that counted those would report throttling that never
// happened. Every pattern below is anchored to something a machine emits.

export type RateLimitKind =
  // Throttles proper — the provider is limiting us.
  | 'rate_limit'      // too many requests per unit time
  | 'concurrency'     // too many in flight at once
  | 'quota'           // plan or credit exhausted
  | 'overloaded'      // provider capacity, not our usage
  // The other ways a call is refused. Detectors here never produce these:
  // they arrive as harness-reported throttle records, which is the only
  // place the upstream is known. Kept in one union because they land in
  // one table and the page filters by kind — splitting them would fracture
  // the dedupe that keeps a text-scanned event from double-counting a
  // harness-reported one.
  | 'model_gone'      // 404/410 — this host no longer serves that model
  | 'server_error'    // 5xx from the provider
  | 'timeout'         // no answer within the deadline
  | 'content_policy'; // a safety filter refused

/**
 * What was throttling us.
 *
 * `inference` is the one that costs money and shapes routing: an LLM provider
 * refused the call. `web` is a site we crawled returning 429 — real, worth
 * seeing, and not a signal about our own API budget. Folding them together
 * buried 57 Anthropic throttles under 3,473 HTML error pages.
 */
export type RateLimitTarget = 'inference' | 'web' | 'service';

export interface RateLimitEvent {
  kind: RateLimitKind;
  target: RateLimitTarget;
  /** Provider we were throttled BY, when the text names one. */
  provider: string | null;
  /**
   * The upstream that actually refused — openrouter, nous, x-ai, anthropic.
   *
   * Null for anything detected HERE, and that is a property of text scanning
   * rather than a gap: the error string a harness prints does not carry the
   * route. "LLM unreachable after 3 attempts [rate_limit]: HTTP Error 429"
   * names no provider, and none of the five it might have been.
   *
   * The upstream arrives instead on `type: "throttle"` records, which are
   * written at the moment of failure where the route is still known — see
   * packages/schema/docs/throttling.md. uncloseai-cli emits those, and since
   * 2026-08-26 emits them for every refusal kind rather than only the two
   * throttle classes it used to map. Null is still rendered as
   * "not reported" so a text-scanned event is visibly less informative than
   * a reported one instead of looking like no data.
   */
  upstream: string | null;
  /**
   * Which call was refused — vision, chat, embed. uncloseai-cli names the
   * operation even when it omits the provider, and it narrows the fix: a
   * throttled vision endpoint points at UNCLOSE_VISION_MODEL, not at the
   * chat model.
   */
  operation: string | null;
  /** HTTP status when the text carries one. */
  status: number | null;
  /** Seconds to wait, when the provider told us. */
  retryAfterSeconds: number | null;
  /** The matched line, trimmed — enough to recognise it, not the whole payload. */
  detail: string;
  /** Which pattern fired, so a wrong match can be traced to its rule. */
  rule: string;
}

interface Rule {
  name: string;
  kind: RateLimitKind;
  provider: string | null;
  target: RateLimitTarget;
  re: RegExp;
}

/**
 * Marks of an HTML error page rather than an API error.
 *
 * A crawled site returning 429 lands in a tool result as a whole HTML
 * document. Those are the majority of 429s in our history — 3,473 of 4,059 —
 * and attributing them to an inference provider would make it look as though
 * our LLM budget was being throttled constantly when it was not.
 */
const HTML_PAGE = /<\/(?:title|head|html|body)>|<!DOCTYPE html|<html[\s>]/i;

// Anchored to machine output. Each was written against a real captured line.
const RULES: Rule[] = [
  {
    // Claude Code, 57 occurrences: the provider is shielding itself, and says
    // explicitly that this is NOT the account's usage limit.
    name: 'anthropic-temporary',
    kind: 'overloaded',
    provider: 'anthropic',
    target: 'inference',
    re: /API Error:\s*Server is temporarily limiting requests[^\n]*/i,
  },
  {
    name: 'anthropic-usage-limit',
    kind: 'quota',
    provider: 'anthropic',
    target: 'inference',
    re: /(?:Claude )?usage limit reached[^\n]*|You(?:'|’)ve (?:hit|reached) your [^\n]{0,40}\blimit\b[^\n]*/i,
  },
  {
    // Claude Code during the 2026-09-03 outage, 12 rows: the harness prints
    // the status between "Error:" and the word, so the generic overloaded
    // rule below never saw it. Anchored to Claude Code's exact prefix.
    name: 'anthropic-overloaded',
    kind: 'overloaded',
    provider: 'anthropic',
    target: 'inference',
    re: /API Error:\s*(?:529|503)?\s*Overloaded\b[^\n]*/i,
  },
  {
    // Any other 5xx Claude Code reports, plus the transport-level failure it
    // prints when the API cannot be reached at all — which is what a full
    // outage looks like from here, no status attached.
    name: 'anthropic-server-error',
    kind: 'server_error',
    provider: 'anthropic',
    target: 'inference',
    re: /API Error:\s*5\d\d\b[^\n]*|API Error:\s*Unable to connect to API[^\n]*/i,
  },
  {
    // unsandbox: HTTP 429 with a concurrency_limit_reached body.
    name: 'concurrency-limit-reached',
    kind: 'concurrency',
    provider: null,
    target: 'service',
    re: /concurrency_limit_reached|Concurrent execution limit[^\n]*/i,
  },
  {
    // arborist's vault answers a burst of opens with 429 TOO_MANY_ATTEMPTS. A
    // service we run, not a model — before http-429 so it is not filed as
    // inference against whichever harness happened to be driving.
    name: 'vault-too-many-attempts',
    kind: 'rate_limit',
    provider: 'vault',
    target: 'service',
    // Two response shapes only. The bench prompt itself says "429
    // TOO_MANY_ATTEMPTS with a Retry-After header. Brute forcing is not
    // viable" once per session — 3,769 sessions' worth of instruction that
    // a looser pattern counted as refusals.
    re: /HTTP\s+429\s+TOO_MANY_ATTEMPTS\b[^\n]*|429\s+TOO_MANY_ATTEMPTS\s+[—-]+\s+vault is rate-limited[^\n]*/,
  },
  {
    // uncloseai-cli, three shapes it actually prints: the final give-up
    // (`LLM unreachable after 3 attempts [rate_limit]: HTTP Error 429`), the
    // failover line (`[rate_limit] on https://openrouter.ai/api/v1 — retrying
    // on nous`) and the retry line (`[rate_limit]: 429 too many requests,
    // retrying in 1.2s`). A bare `\[rate_limit\]` matched 34 blocks of
    // `[rate_limit] error` from test files and every backticked mention of the
    // tag in prose about this very detector.
    name: 'uncloseai-bracket-tag',
    kind: 'rate_limit',
    provider: 'uncloseai',
    target: 'inference',
    re: /(?:LLM unreachable after \d+ attempts? \[rate_limit\]|\[rate_limit\] on https?:\/\/\S+ [—-]+ retrying|\[rate_limit\]:\s*(?:HTTP Error )?429\b)[^\n]*/i,
  },
  {
    // Same harness giving up on a 5xx. 116 such lines sit in sessions from
    // before uncloseai-cli reported its own refusals (2026-08-26); after that
    // the harness-reported row wins and this is skipped by the dedupe.
    name: 'uncloseai-bracket-server-error',
    kind: 'server_error',
    provider: 'uncloseai',
    target: 'inference',
    re: /(?:LLM unreachable after \d+ attempts? \[(?:server_error|overloaded)\]|\[(?:server_error|overloaded)\] on https?:\/\/\S+ [—-]+ retrying)[^\n]*/i,
  },
  {
    // Deliberately strict. A loose `\b429\b` matched 3,857 blocks of which
    // 3,758 were log dumps, numbered file reads and prose that merely
    // contained the number — "crt.sh is either rate-limiting us (429)" is a
    // sentence, not an event. The 429 has to look like a response: attached to
    // HTTP, assigned to a status field, or starting its own line.
    name: 'http-429',
    kind: 'rate_limit',
    provider: null,
    target: 'inference',
    re: /(?:^|[\s(])HTTP(?:\/1\.[01])?[\s:]*(?:Error[\s:]*)?429\b[^\n]*|(?:^|[\s"',{])(?:status|status_code|statusCode|code|http_status)["']?\s*[:=]\s*["']?429\b[^\n]*|^[\s>*-]*429\s+(?:Too Many Requests|TOO_MANY_ATTEMPTS)\b[^\n]*|\bHTTPError\b[^\n]{0,20}429[^\n]*/mi,
  },
  {
    // JSON error bodies: {"error": {"type": "rate_limit_error", ...}}
    name: 'json-rate-limit-error',
    kind: 'rate_limit',
    provider: null,
    target: 'inference',
    re: /"(?:type|error|code)"\s*:\s*"(?:rate_limit_error|rate_limit_exceeded|too_many_requests)"[^\n]*/i,
  },
  {
    name: 'matrix-limit-exceeded',
    kind: 'rate_limit',
    provider: 'matrix',
    target: 'service',
    re: /\bM_LIMIT_EXCEEDED\b[^\n]*/,
  },
  {
    name: 'overloaded',
    kind: 'overloaded',
    provider: null,
    target: 'inference',
    re: /"type"\s*:\s*"overloaded_error"[^\n]*|\bError:\s*Overloaded\b[^\n]*/i,
  },
];

/**
 * Text that mentions a rate limit without being one.
 *
 * Commit subjects, code, and agents talking about throttling all trip a naive
 * match. Checked before the rules so a discussion of M_LIMIT_EXCEEDED does not
 * become a throttling event.
 */
const NEGATIVES: RegExp[] = [
  /^\s*\[[0-9a-f]+\s+[0-9a-f]{7}\]/i,          // `[main e7f7567] Fix rate limiting`
  /\bfiles? changed\b/i,                        // git commit summary
  /^\s*(?:Fix|Retry|Handle|Add|Slow|Prevent)\b[^\n]{0,80}\brate limit/i,
  /\bretry on\b/i,
  /<task-notification>/,
  /\bgrep\b|\brg\b\s|\bripgrep\b/i,
];

/** Seconds from a retry hint: `retry after 4200ms`, `Retry-After: 30`. */
export function parseRetryAfter(text: string): number | null {
  const ms = /retry[ _-]?after[^0-9]{0,8}(\d+)\s*ms\b/i.exec(text);
  if (ms) return Math.round(Number(ms[1]) / 1000);
  const s = /retry[ _-]?after[^0-9]{0,8}(\d+)(?:\s*(?:s|sec|seconds?))?\b/i.exec(text);
  if (s) return Number(s[1]);
  const inS = /\btry again in\s+(\d+)\s*(?:s|sec|seconds?)\b/i.exec(text);
  if (inS) return Number(inS[1]);
  return null;
}

/**
 * Upstream host or provider named in the text, if any.
 *
 * Matches hostnames first because an error body that quotes a URL is telling
 * us exactly who answered, then falls back to provider words that only count
 * when they sit next to the failure.
 */
const UPSTREAM_HOSTS: Array<[RegExp, string]> = [
  [/\bopenrouter\.ai\b/i, 'openrouter'],
  [/\binference-api\.nousresearch\.com\b|\bportal\.nousresearch\.com\b/i, 'nous'],
  [/\bapi\.anthropic\.com\b/i, 'anthropic'],
  [/\bapi\.x\.ai\b/i, 'x-ai'],
  [/\bapi\.openai\.com\b/i, 'openai'],
  [/\bgenerativelanguage\.googleapis\.com\b/i, 'google'],
  [/\bai\.foxhop\.net\b/i, 'qwen'],
  [/\b3090-ai\.foxhop\.net\b/i, 'hermes'],
  [/\bapi\.unsandbox\.com\b/i, 'unsandbox'],
];

export function parseUpstream(text: string): string | null {
  for (const [re, name] of UPSTREAM_HOSTS) {
    if (re.test(text)) return name;
  }
  // A structured claim only. `via <word>` was tried and produced nothing but
  // false positives — "via bash", "via pandoc", and a Claude message quoting a
  // proposed uncloseai status line all matched. A hostname or a provider field
  // is evidence; a preposition in prose is not.
  const named = /"(?:provider|upstream)"\s*:\s*"([a-z0-9_.-]{2,24})"/i.exec(text);
  if (named) return named[1].toLowerCase();
  return null;
}

/** The operation that was refused, when the harness names it. */
export function parseOperation(text: string): string | null {
  const m = /\b([a-z_]{2,16})\s+call failed\b/i.exec(text);
  if (m) return m[1].toLowerCase();
  return null;
}

function parseStatus(text: string): number | null {
  const m = /\b(429|500|502|503|504|529)\b/.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * Find the rate-limit event in a block of harness output, or null.
 *
 * Returns at most one event per block: a single throttle usually prints a
 * message, a retry line and a stack, and counting those as three would
 * overstate how often we are actually limited.
 */
export function detectRateLimit(text: string | null | undefined): RateLimitEvent | null {
  if (!text) return null;
  const t = String(text);
  if (t.length > 20000) return null;   // whole-file dumps are not events
  if (NEGATIVES.some((re) => re.test(t))) return null;

  for (const rule of RULES) {
    const m = rule.re.exec(t);
    if (!m) continue;
    const detail = m[0].trim().slice(0, 300);
    // An HTML body means a crawled page answered 429, whatever the rule
    // guessed — never an inference provider.
    const isHtml = HTML_PAGE.test(t);
    return {
      kind: rule.kind,
      target: isHtml ? 'web' : rule.target,
      provider: isHtml ? 'web' : rule.provider,
      upstream: parseUpstream(t),
      operation: parseOperation(t),
      status: parseStatus(detail) ?? parseStatus(t),
      retryAfterSeconds: parseRetryAfter(t),
      detail,
      rule: rule.name,
    };
  }
  return null;
}

/** True when a block looks like a throttling event. */
export function isRateLimited(text: string | null | undefined): boolean {
  return detectRateLimit(text) !== null;
}
