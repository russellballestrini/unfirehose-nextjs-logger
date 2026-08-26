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

  it('arborist vault: 429 TOO_MANY_ATTEMPTS', () => {
    const e = detectRateLimit('429 TOO_MANY_ATTEMPTS — vault refused')!;
    expect(e.kind).toBe('rate_limit');
    expect(e.status).toBe(429);
  });

  it('a JSON error body', () => {
    const e = detectRateLimit('{"error":{"type":"rate_limit_error","message":"slow down"}}')!;
    expect(e.kind).toBe('rate_limit');
  });

  it('an overloaded provider is distinguished from our own usage', () => {
    expect(detectRateLimit('{"type":"overloaded_error"}')!.kind).toBe('overloaded');
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
