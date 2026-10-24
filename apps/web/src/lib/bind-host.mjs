// @ts-check
/**
 * Which address our dashboard listens on. One rule, read by two sides:
 * `scripts/serve.mjs`, which starts `next dev` / `next start` with `-H`, and
 * GET /api/lan, which tells Settings → Phone what a restart would pick.
 *
 * Plain ESM with JSDoc rather than TypeScript, so the launcher runs under bare
 * node (a systemd unit, a production box without tsx) and still shares this
 * file with the app.
 *
 * Our dashboard has no login and can push commits, boot agents and type into
 * tmux, so this machine only (127.0.0.1) is our default. In order:
 *
 *   1. UNFIREHOSE_HOST, when set: decides alone (Settings cannot change it).
 *      A value that is not an address or a host name is refused, and we fall
 *      back to 127.0.0.1 rather than guess.
 *   2. $UNFIREHOSE_DIR/web-bind.json, written by Settings → Phone:
 *      `{"lan": true}` binds 0.0.0.0 (every interface).
 *   3. 127.0.0.1.
 *
 * A file that is missing, unreadable or not that shape reads as "this
 * machine only": a broken opt-in never opens anything.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export const LOCAL_HOST = '127.0.0.1';
export const LAN_HOST = '0.0.0.0';
export const BIND_FILE = 'web-bind.json';

/**
 * Our data directory, the same rule as packages/core/db/data-dir.ts, repeated
 * here because the launcher runs before (and without) our TypeScript.
 * @param {Record<string, string | undefined>} [env]
 */
export function dataDir(env = process.env) {
  return env.UNFIREHOSE_DIR || path.join(os.homedir(), '.unfirehose');
}

/** @param {Record<string, string | undefined>} [env] */
export function bindFilePath(env = process.env) {
  return path.join(dataDir(env), BIND_FILE);
}

/**
 * Loopback: reachable from this machine only.
 * @param {string} host
 */
export function isLoopback(host) {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * An IPv4 or IPv6 literal, or a host name: what `next -H` can bind.
 * @param {string} host
 */
export function isValidHost(host) {
  if (!host || host.length > 253) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host.split('.').every((o) => Number(o) <= 255);
  if (host.includes(':')) return /^[0-9a-f:.]+$/i.test(host);
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(host);
}

/**
 * @typedef {{ lan: boolean, setAt: string | null }} SavedChoice
 */

/**
 * What Settings → Phone saved. Anything but `{"lan": true}` is "this machine only".
 * @param {string | null} text  the file's contents, or null when there is none
 * @returns {SavedChoice}
 */
export function parseSaved(text) {
  if (text == null) return { lan: false, setAt: null };
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return { lan: v.lan === true, setAt: typeof v.setAt === 'string' ? v.setAt : null };
    }
  } catch { /* fall through: unreadable is local */ }
  return { lan: false, setAt: null };
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function readOrNull(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/**
 * @typedef {object} Bind
 * @property {string} host          what to pass to `next -H`
 * @property {boolean} lan          whether that host is reachable from other machines
 * @property {'env' | 'settings' | 'default'} source
 * @property {string | null} override  UNFIREHOSE_HOST as given, when set
 * @property {SavedChoice} saved    what Settings → Phone saved, whatever decided
 * @property {string} file          where that choice lives
 * @property {string | null} warning  why a value was ignored, for the launcher to print
 */

/**
 * @param {{ env?: Record<string, string | undefined>, read?: (file: string) => string | null }} [opts]
 * @returns {Bind}
 */
export function resolveBind(opts = {}) {
  const env = opts.env ?? process.env;
  const read = opts.read ?? readOrNull;
  const file = bindFilePath(env);
  const saved = parseSaved(read(file));
  const raw = (env.UNFIREHOSE_HOST ?? '').trim();

  if (raw) {
    if (isValidHost(raw)) return { host: raw, lan: !isLoopback(raw), source: 'env', override: raw, saved, file, warning: null };
    return {
      host: LOCAL_HOST, lan: false, source: 'env', override: raw, saved, file,
      warning: `UNFIREHOSE_HOST=${JSON.stringify(raw)} is not an address or host name; listening on ${LOCAL_HOST} only`,
    };
  }
  if (saved.lan) return { host: LAN_HOST, lan: true, source: 'settings', override: null, saved, file, warning: null };
  return { host: LOCAL_HOST, lan: false, source: 'default', override: null, saved, file, warning: null };
}

/**
 * Save the choice Settings → Phone makes: 0600, written whole then renamed,
 * so a launcher reading it mid-write sees the old choice or the new one.
 * @param {boolean} lan
 * @param {{ env?: Record<string, string | undefined>, now?: Date }} [opts]
 * @returns {SavedChoice}
 */
export function saveChoice(lan, opts = {}) {
  const env = opts.env ?? process.env;
  const file = bindFilePath(env);
  const choice = { lan, setAt: (opts.now ?? new Date()).toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(choice) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return choice;
}

/**
 * The address the running server was started on: our launcher passes it
 * down as UNFIREHOSE_BOUND_HOST (our Docker image sets it too). Null when
 * started some other way, e.g. a bare `npx next dev`.
 * @param {Record<string, string | undefined>} [env]
 */
export function runningHost(env = process.env) {
  return env.UNFIREHOSE_BOUND_HOST || null;
}

/**
 * Whether `args` (to `next dev` / `next start`) already name a host, in which
 * case the person typing them decides and we add nothing.
 * @param {string[]} args
 * @returns {string | null}
 */
export function hostFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-H' || a === '--hostname') return args[i + 1] ?? null;
    const m = /^(?:-H|--hostname)=(.+)$/.exec(a);
    if (m) return m[1];
  }
  return null;
}
