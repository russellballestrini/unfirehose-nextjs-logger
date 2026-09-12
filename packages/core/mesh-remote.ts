/**
 * Probe one node over ssh.
 *
 * This lived inside the /api/mesh route, and the worker reached it by
 * fetching /api/mesh?host=… from the web server every fifteen seconds per
 * node — a probe that could have run anywhere, routed through the process
 * whose job is to answer pages. It lives here now, where both the route and
 * the worker can call it, and the worker no longer needs a web server up to
 * take a sample.
 */
import { execFile } from 'child_process';
import { parseRemoteProbe, type MeshNode } from './mesh-probe';
import { speakers, nextSpeakers, type Speaker } from './userland/speakers';

/**
 * Probe a remote node over SSH.
 *
 * The Bourne script goes to `sh` on stdin rather than as a command
 * argument, so the remote login shell never parses it — csh on an old BSD
 * would choke on the first `2>/dev/null`. Which userland's plugin runs is
 * decided on the far side by the script itself (see packages/core/userland).
 *
 * Where `sh` is not a program — Windows, network gear — the failure has a
 * recognisable shape and names the next speaker to try (userland/speakers):
 * PowerShell, cmd, a network OS's own command line. Each try is a round
 * trip, so the walk continues only while ssh itself connected (exit 255
 * is ssh failing to reach the box; anything else is the box answering),
 * and the speaker that answered is remembered per host for the next poll.
 */
const SSH_OPTS = ['-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes'];
const PROBE_TIMEOUT_MS = 15000;

interface SshResult { err: Error | null; code: number | null; stdout: string; stderr: string }

function sshRun(host: string, speaker: Speaker): Promise<SshResult> {
  return new Promise((resolve) => {
    const args = [...SSH_OPTS, ...(speaker.tty ? ['-tt'] : []), host, ...speaker.command];
    const child = execFile('ssh', args,
      { encoding: 'utf-8', timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        err: err as Error | null,
        code: (err as any)?.code ?? (err ? -1 : 0),
        stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
      }),
    );
    // Test doubles return nothing; a real child has a stdin to feed.
    const input = (child as any)?.stdin;
    if (input) {
      input.on('error', () => {});
      input.end(speaker.stdin);
    }
  });
}

/** The speaker each host last answered with, so a poll goes straight to it. */
const remembered = new Map<string, string>();

/** For tests and for a host that changed OS: forget what it spoke. */
export function forgetSpeaker(host?: string): void {
  if (host) remembered.delete(host); else remembered.clear();
}

const answered = (r: SshResult, sp: Speaker) => {
  const wire = sp.translate ? sp.translate(r.stdout) : r.stdout;
  return wire.includes('uf=1') ? wire : null;
};

/** The wire a host answered with, and who spoke it — or why nobody did. */
export type WireAnswer = { wire: string; speaker: string } | { wire: null; error: string };

export async function probeRemoteWire(host: string): Promise<WireAnswer> {
  const all = speakers();
  const known = remembered.get(host);
  const start = all.find(sp => sp.id === known) ?? all[0]!;

  let sp: Speaker = start;
  let r = await sshRun(host, sp);
  let wire = answered(r, sp);
  let sawCli = false;

  // Walk the chain. ssh's own exit 255 means it never reached a shell —
  // a box that is down, refusing, or refusing our key — and nothing
  // further would help.
  while (!wire && r.code !== 255) {
    const said = r.stderr + '\n' + r.stdout;
    const next: Speaker | undefined = nextSpeakers(all, sp, said)[0];
    sawCli = sawCli || /unknown command|% Invalid input|bad command name/i.test(said);
    if (!next) break;
    sp = next;
    r = await sshRun(host, sp);
    wire = answered(r, sp);
  }
  // A remembered speaker that stopped answering: start over next time.
  if (!wire && known) remembered.delete(host);

  if (!wire) {
    const msg = r.err?.message ?? '';
    return {
      wire: null,
      error: msg.includes('ETIMEDOUT') || /timed out/i.test(msg) ? 'Connection timed out'
        : r.code === 255 ? 'Unreachable'
        : sawCli ? 'Command line not understood (network OS?) — no speaker answered'
        : 'No shell, PowerShell or cmd answered on remote',
    };
  }

  remembered.set(host, sp.id);
  return { wire, speaker: sp.id };
}

export async function probeRemote(host: string): Promise<MeshNode> {
  const a = await probeRemoteWire(host);
  if (a.wire === null) return { hostname: host, reachable: false, error: a.error };
  try {
    return parseRemoteProbe(host, a.wire);
  } catch (parseErr: any) {
    return { hostname: host, reachable: false, error: parseErr.message };
  }
}
