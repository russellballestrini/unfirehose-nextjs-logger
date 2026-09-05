import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { sign, authHeaders, UNSANDBOX_API_BASE } from './unsandbox-auth';

/**
 * Signing a request to the unsandbox API.
 *
 * Three routes each carried their own copy of this. Signing code is the
 * worst thing to have three of: the signed string covers the timestamp,
 * the method, the path and the body, so drift between copies produces a
 * signature the server rejects — and a rejected signature is
 * indistinguishable from a stale key. It sends somebody to rotate a
 * credential that was never the problem.
 *
 * The key material below is fabricated.
 */

const KEY = 'sk_test_not_a_real_key';
afterEach(() => vi.useRealTimers());

describe('sign', () => {
  it('signs the timestamp, method, path and body, in that order', () => {
    // Recomputed independently rather than compared to a golden string,
    // so this test says what the format IS rather than what it was.
    vi.useFakeTimers({ now: 1_757_000_000_000 });
    const { timestamp, signature } = sign(KEY, 'POST', '/sessions', '{"a":1}');
    expect(timestamp).toBe('1757000000');
    const expected = createHmac('sha256', KEY)
      .update('1757000000:POST:/sessions:{"a":1}').digest('hex');
    expect(signature).toBe(expected);
  });

  it('counts seconds, not milliseconds', () => {
    // The server compares against its own clock in seconds. Sending
    // milliseconds is a timestamp a thousand times in the future, which
    // it rejects as skew.
    vi.useFakeTimers({ now: 1_757_000_000_123 });
    expect(sign(KEY, 'GET', '/x').timestamp).toBe('1757000000');
  });

  it('signs an empty body when there is none', () => {
    vi.useFakeTimers({ now: 1_757_000_000_000 });
    expect(sign(KEY, 'GET', '/x').signature).toBe(sign(KEY, 'GET', '/x', '').signature);
  });

  it('signs two paths differently', () => {
    // The path is in the string. A signature reused across endpoints is
    // rejected exactly as a wrong key would be.
    vi.useFakeTimers({ now: 1_757_000_000_000 });
    expect(sign(KEY, 'GET', '/sessions').signature)
      .not.toBe(sign(KEY, 'GET', '/services').signature);
  });

  it('signs two methods differently', () => {
    vi.useFakeTimers({ now: 1_757_000_000_000 });
    expect(sign(KEY, 'GET', '/x').signature).not.toBe(sign(KEY, 'DELETE', '/x').signature);
  });

  it('signs two bodies differently', () => {
    vi.useFakeTimers({ now: 1_757_000_000_000 });
    expect(sign(KEY, 'POST', '/x', '{"a":1}').signature)
      .not.toBe(sign(KEY, 'POST', '/x', '{"a":2}').signature);
  });

  it('signs differently a second later, so a signature cannot be replayed', () => {
    vi.useFakeTimers({ now: 1_757_000_000_000 });
    const a = sign(KEY, 'GET', '/x').signature;
    vi.setSystemTime(1_757_000_001_000);
    expect(sign(KEY, 'GET', '/x').signature).not.toBe(a);
  });

  it('signs differently under a different key', () => {
    vi.useFakeTimers({ now: 1_757_000_000_000 });
    expect(sign(KEY, 'GET', '/x').signature)
      .not.toBe(sign('sk_test_other', 'GET', '/x').signature);
  });
});

describe('authHeaders', () => {
  it('carries the public key as a bearer and the signature beside it', () => {
    vi.useFakeTimers({ now: 1_757_000_000_000 });
    const h = authHeaders('pk_test', KEY, 'GET', '/keys/self');
    expect(h).toEqual({
      'Authorization': 'Bearer pk_test',
      'X-Timestamp': '1757000000',
      'X-Signature': sign(KEY, 'GET', '/keys/self').signature,
      'Content-Type': 'application/json',
    });
  });

  it('signs the body it says it is sending', () => {
    // Headers built over one body and sent with another is the drift this
    // module exists to prevent.
    vi.useFakeTimers({ now: 1_757_000_000_000 });
    const body = JSON.stringify({ command: 'ls' });
    expect(authHeaders('pk_test', KEY, 'POST', '/execute', body)['X-Signature'])
      .toBe(sign(KEY, 'POST', '/execute', body).signature);
  });

  it('names one API base, so a path is signed for where it is sent', () => {
    expect(UNSANDBOX_API_BASE).toBe('https://api.unsandbox.com');
  });
});
