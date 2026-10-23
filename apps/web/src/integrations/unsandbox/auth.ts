import { createHmac } from 'crypto';

/**
 * Signing a request to the unsandbox API.
 *
 * Three routes each carried their own copy of this — the proxy, the
 * transcript sync and the shell stream — identical but for a parameter
 * name. Signing code is the worst thing in a repo to have three of: the
 * signed string covers the timestamp, the method, the path and the body,
 * so any drift between copies produces a signature the server rejects,
 * and a rejected signature is indistinguishable from a stale key. It
 * sends somebody to rotate a credential that was never the problem.
 */

/** Where the unsandbox API lives. One base, for the same reason. */
export const UNSANDBOX_API_BASE = 'https://api.unsandbox.com';
export const UNSANDBOX_WSS_BASE = 'wss://api.unsandbox.com';

/**
 * The signature for one request.
 *
 * The timestamp is seconds, not milliseconds, and it is part of what is
 * signed — so a machine with a wrong clock fails every request and looks
 * exactly like a machine with a wrong key.
 */
export function sign(
  secretKey: string,
  method: string,
  path: string,
  body = '',
): { timestamp: string; signature: string } {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = `${timestamp}:${method}:${path}:${body}`;
  return {
    timestamp,
    signature: createHmac('sha256', secretKey).update(message).digest('hex'),
  };
}

/** Headers for one signed request, including the body it was signed over. */
export function authHeaders(
  publicKey: string,
  secretKey: string,
  method: string,
  path: string,
  body = '',
): Record<string, string> {
  const { timestamp, signature } = sign(secretKey, method, path, body);
  return {
    'Authorization': `Bearer ${publicKey}`,
    'X-Timestamp': timestamp,
    'X-Signature': signature,
    'Content-Type': 'application/json',
  };
}
