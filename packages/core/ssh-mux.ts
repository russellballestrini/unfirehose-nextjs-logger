/**
 * ssh options shared by everything that reaches a node: the mesh probe and
 * the vLLM sampler.
 *
 * Every probe used to be a fresh connection — key exchange, authentication,
 * a new session — six of them every fifteen seconds, on both ends, to say
 * the same thing to the same boxes. ControlMaster keeps one connection per
 * host open and multiplexes the rest through it; a probe is then one
 * channel open, not a handshake. The master persists CONTROL_PERSIST_S past
 * its last use, so a sampler on a 15 s cadence holds it indefinitely and a
 * one-off command lets it go. ServerAlive tears down a master whose peer
 * went away, so a rebooted node is reconnected rather than waited on.
 *
 * The sockets live in the data directory, never in /tmp: the directory is
 * created 0700, and ssh makes the sockets 0600.
 */

import { mkdirSync, chmodSync } from 'fs';
import path from 'path';
import { UNFIREHOSE_DIR } from './db/schema';

export const CONTROL_PERSIST_S = 120;
export const SSH_CONTROL_DIR = path.join(UNFIREHOSE_DIR, 'ssh');

let ready = false;

/** The -o options for a multiplexed connection, or none when the socket dir cannot be made. */
export function sshMuxOpts(): string[] {
  if (process.env.UNFIREHOSE_SSH_MUX === '0') return [];
  if (!ready) {
    try {
      mkdirSync(SSH_CONTROL_DIR, { recursive: true, mode: 0o700 });
      chmodSync(SSH_CONTROL_DIR, 0o700);
      ready = true;
    } catch {
      return [];
    }
  }
  return [
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${path.join(SSH_CONTROL_DIR, '%C')}`,
    '-o', `ControlPersist=${CONTROL_PERSIST_S}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
  ];
}

/** Every option a probe passes to ssh: the connection rules, then the multiplexing. */
export function sshBaseOpts(): string[] {
  return ['-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', ...sshMuxOpts()];
}
