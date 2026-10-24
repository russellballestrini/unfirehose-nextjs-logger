#!/usr/bin/env node
// @ts-check
/**
 * Start `next dev` or `next start` on the address our settings pick.
 *
 *   node scripts/serve.mjs dev  [next args…]     (npm run dev)
 *   node scripts/serve.mjs start [next args…]    (npm run start, the systemd unit)
 *
 * `next` listens on every interface unless given `-H`, and our dashboard has
 * no login, so this adds `-H 127.0.0.1` unless Settings → Phone opted in to
 * the network or UNFIREHOSE_HOST says otherwise (rules: src/lib/bind-host.mjs).
 * An explicit `-H` / `--hostname` among the args wins and is passed through.
 *
 * The bind is fixed when the server starts; a changed choice takes effect on
 * the next start (make dev again, or make service-restart).
 */

import { spawn } from 'child_process';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { resolveBind, hostFromArgs, isLoopback } from '../src/lib/bind-host.mjs';

/**
 * @param {'dev' | 'start'} mode
 * @param {string[]} args
 * @param {{ host: string }} bind
 * @returns {{ argv: string[], host: string, explicit: boolean }}
 */
export function nextArgs(mode, args, bind) {
  const given = hostFromArgs(args);
  if (given) return { argv: [mode, ...args], host: given, explicit: true };
  return { argv: [mode, '-H', bind.host, ...args], host: bind.host, explicit: false };
}

/**
 * One line saying where we listen and, off loopback, what that exposes.
 * @param {string} host
 * @param {string} source
 */
export function banner(host, source) {
  if (isLoopback(host)) {
    return `unfirehose web: listening on ${host}, this machine only (${source}). To open it to phones on your network: Settings → Phone.`;
  }
  return `unfirehose web: listening on ${host} (${source}). Anyone on this network can read every session, push commits and type into tmux: there is no login.`;
}

function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode !== 'dev' && mode !== 'start') {
    console.error('usage: node scripts/serve.mjs dev|start [next args…]');
    process.exit(2);
  }
  const bind = resolveBind();
  if (bind.warning) console.error(`unfirehose web: ${bind.warning}`);
  const { argv, host, explicit } = nextArgs(mode, rest, bind);
  const source = explicit ? '-H on the command line'
    : bind.source === 'env' ? `UNFIREHOSE_HOST`
    : bind.source === 'settings' ? `Settings → Phone, ${bind.file}`
    : 'default';
  console.log(banner(host, source));

  const next = createRequire(import.meta.url).resolve('next/dist/bin/next');
  const child = spawn(process.execPath, [next, ...argv], {
    stdio: 'inherit',
    env: { ...process.env, UNFIREHOSE_BOUND_HOST: host },
  });
  for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
    process.on(sig, () => { if (child.exitCode === null) child.kill(sig); });
  }
  child.on('exit', (code, signal) => {
    // Die of the same signal, so a supervisor reads what happened; our
    // forwarding handler would otherwise swallow it.
    if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); }
    else process.exit(code ?? 1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
