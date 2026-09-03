import { describe, it, expect } from 'vitest';
import { detectRateLimit, isRateLimited, parseRetryAfter } from './rate-limits.js';

// Positives are real machine output from ~/.unfirehose/unfirehose.db.
// Negatives are real prose from the same table — the reason a naive
// substring match on "429" or "rate limit" would report throttling that
// never happened. 20,053 blocks mention one or the other; almost none are
// events.

describe('real throttling events', () => {
  it('Claude Code: server-side limiting, explicitly not our usage limit', () => {
    const e = detectRateLimit(
      'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
    )!;
    expect(e.kind).toBe('overloaded');
    expect(e.provider).toBe('anthropic');
    expect(e.rule).toBe('anthropic-temporary');
  });

  it('unsandbox: concurrency limit, which is not a per-minute rate limit', () => {
    const e = detectRateLimit(
      'Error: HTTP 429 {"details":{"error":"concurrency_limit_reached"},"error":"concurrency_limit_reached","message":"Concurrent execution limit reached"}',
    )!;
    expect(e.kind).toBe('concurrency');
    expect(e.status).toBe(429);
  });

  it('uncloseai-cli: bracketed tag from a failed tool call', () => {
    const e = detectRateLimit(
      'vision call failed: LLM unreachable after 3 attempts [rate_limit]: HTTP Error 429: Too Many Requests',
    )!;
    expect(e.kind).toBe('rate_limit');
    expect(e.provider).toBe('uncloseai');
    expect(e.status).toBe(429);
  });

  it('arborist vault: 429 TOO_MANY_ATTEMPTS is a service we run, not a model', () => {
    const e = detectRateLimit('429 TOO_MANY_ATTEMPTS — vault is rate-limited to 1 /open per 3.0s. Next attempt allowed in 2.1s')!;
    expect(e.kind).toBe('rate_limit');
    expect(e.status).toBe(429);
    expect(e.target).toBe('service');
    expect(e.provider).toBe('vault');
    expect(detectRateLimit('(HTTP 429 TOO_MANY_ATTEMPTS) on POST /open/__PHONE_1__. Prior attempts (0000000000)')!.target).toBe('service');
  });

  it('uncloseai-cli: failover and retry lines', () => {
    expect(detectRateLimit('[rate_limit] on https://openrouter.ai/api/v1 — retrying on nous, same model)')!.upstream).toBe('openrouter');
    expect(detectRateLimit('[rate_limit]: 429 too many requests, retrying in 1.2s...')!.kind).toBe('rate_limit');
  });

  it('uncloseai-cli: giving up on a 5xx before it reported its own refusals', () => {
    const e = detectRateLimit('chat call failed: LLM unreachable after 3 attempts [server_error]: HTTP Error 502: Bad Gateway')!;
    expect(e.kind).toBe('server_error');
    expect(e.provider).toBe('uncloseai');
    expect(e.status).toBe(502);
  });

  it('the bench prompt describing the vault limit is an instruction, not a refusal', () => {
    expect(isRateLimited('The vault answers bursts with 429 TOO_MANY_ATTEMPTS with a Retry-After header. Brute forcing is not viable — reason about the code.')).toBe(false);
    expect(isRateLimited('429\nTOO_MANY_ATTEMPTS with a Retry-After header. Brute forcing is not viable')).toBe(false);
  });

  it('the bracket tag in code or prose is not a refusal', () => {
    expect(isRateLimited('[rate_limit] error')).toBe(false);
    expect(isRateLimited('`[rate_limit]`. Re-check after a run that actually hits a provider')).toBe(false);
    expect(isRateLimited('`[rate_limit]`, `[server_error]`, etc.')).toBe(false);
    expect(isRateLimited('LLM unreachable after 3 attempts [unknown]: empty response from LLM')).toBe(false);
  });

  it('a JSON error body', () => {
    const e = detectRateLimit('{"error":{"type":"rate_limit_error","message":"slow down"}}')!;
    expect(e.kind).toBe('rate_limit');
  });

  it('an overloaded provider is distinguished from our own usage', () => {
    expect(detectRateLimit('{"type":"overloaded_error"}')!.kind).toBe('overloaded');
  });

  it('Claude Code 2026-09-03 outage: the status sits between Error: and Overloaded', () => {
    const e = detectRateLimit(
      'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.',
    )!;
    expect(e.kind).toBe('overloaded');
    expect(e.provider).toBe('anthropic');
    expect(e.status).toBe(529);
    expect(e.rule).toBe('anthropic-overloaded');
  });

  it('Claude Code cannot reach the API at all — an outage with no status', () => {
    const e = detectRateLimit('API Error: Unable to connect to API (ENOTIMP)')!;
    expect(e.kind).toBe('server_error');
    expect(e.provider).toBe('anthropic');
    expect(e.status).toBeNull();
  });

  it('Claude Code 500 is a server error, not an overload', () => {
    const e = detectRateLimit('API Error: 500 Internal server error')!;
    expect(e.kind).toBe('server_error');
    expect(e.status).toBe(500);
  });

  it('Claude Code session window exhausted is quota, like the older wording', () => {
    const e = detectRateLimit("You've hit your session limit · resets 11:30am (America/New_York)")!;
    expect(e.kind).toBe('quota');
    expect(e.provider).toBe('anthropic');
    expect(detectRateLimit("You've reached your Fable 5 limit. Run /usage-credits to continue")!.kind).toBe('quota');
  });

  it('a quota exhaustion is not the same as a rate limit', () => {
    const e = detectRateLimit('Claude usage limit reached. Your limit will reset at 3pm.')!;
    expect(e.kind).toBe('quota');
    expect(e.provider).toBe('anthropic');
  });

  it('Matrix M_LIMIT_EXCEEDED when it is the error, not the topic', () => {
    expect(detectRateLimit('RoomSendError: M_LIMIT_EXCEEDED Too Many Requests')!.provider).toBe('matrix');
  });
});

describe('prose about rate limits is not a rate limit', () => {
  // Every one of these is a real block from our database.
  const NEGATIVES = [
    '[main e7f7567] Retry file send on Matrix rate limit errors  1 file changed, 19 insertions(+), 11 deletions(-)',
    '[main 2545184] Fix purge rate limiting: retry on M_LIMIT_EXCEEDED, prevent concurrent runs  3 files changed, 38 insertions(+)',
    'Fixed three things:  1. `delete_message_by_id` now retries — extracts `retry after Xms` from the rate limit error',
    'No Matrix rate limit errors at all — the 1s delay is working.',
    '<task-notification> <task-id>b2fv3r813</task-id> <summary>Monitor event: "attempt 7 — 12 workers"</summary>',
    'ai-server-report.md CLAUDE.md cmd cors-proxy dns docs egress go.mod go.sum ingress LICENSE Makefile pkg',
  ];

  for (const [i, text] of NEGATIVES.entries()) {
    it(`negative ${i + 1}: ${text.slice(0, 46)}…`, () => {
      expect(isRateLimited(text)).toBe(false);
    });
  }

  it('ignores a whole-file dump that happens to contain 429', () => {
    const big = `${'x'.repeat(25000)}\nHTTP 429\n`;
    expect(isRateLimited(big)).toBe(false);
  });

  it('ignores empty input', () => {
    expect(detectRateLimit('')).toBeNull();
    expect(detectRateLimit(null)).toBeNull();
    expect(detectRateLimit(undefined)).toBeNull();
  });

  it('does not fire on a port or byte count that contains 429', () => {
    expect(isRateLimited('listening on 127.0.0.1:4290')).toBe(false);
    expect(isRateLimited('wrote 42900 bytes')).toBe(false);
  });
});

describe('retry hints', () => {
  it('reads milliseconds and converts to seconds', () => {
    expect(parseRetryAfter('rate limited, retry after 4200ms')).toBe(4);
  });
  it('reads a Retry-After header in seconds', () => {
    expect(parseRetryAfter('Retry-After: 30')).toBe(30);
  });
  it('reads a prose hint', () => {
    expect(parseRetryAfter('slow down, try again in 12 seconds')).toBe(12);
  });
  it('returns null when the provider said nothing', () => {
    expect(parseRetryAfter('HTTP 429 Too Many Requests')).toBeNull();
  });
  it('is carried on the detected event', () => {
    const e = detectRateLimit('HTTP 429 Too Many Requests. Retry-After: 60')!;
    expect(e.retryAfterSeconds).toBe(60);
  });
});

describe('one event per block', () => {
  it('does not count the message, its retry line and its stack as three', () => {
    const e = detectRateLimit([
      'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
      '  retrying in 5s...',
      '  at fetchWithRetry (client.js:112)',
    ].join('\n'));
    expect(e).not.toBeNull();
    expect(e!.detail).not.toContain('at fetchWithRetry');
  });
});
