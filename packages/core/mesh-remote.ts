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
import { buildProbeScript, POWERSHELL_SCRIPT } from './userland';

/**
 * Probe a remote node over one SSH connection.
 *
 * The script goes to `sh` on stdin rather than as a command argument, so
 * the remote login shell never parses it — csh on an old BSD would choke
 * on the first `2>/dev/null`. Which userland's plugin runs is decided on
 * the far side by the script itself (see packages/core/userland).
 *
 * A Windows sshd hands us cmd.exe or pwsh, where `sh` is not a program;
 * that failure has a recognisable shape, and the second attempt feeds the
 * same wire format to PowerShell.
 */
const SSH_OPTS = ['-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes'];
const PROBE_TIMEOUT_MS = 15000;

const NO_SH = /not recognized as an internal or external command|The term 'sh' is not recognized|sh: (command )?not found|sh: No such file|CommandNotFoundException/i;

function sshRun(host: string, command: string[], stdin: string): Promise<{ err: Error | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile('ssh', [...SSH_OPTS, host, ...command],
      { encoding: 'utf-8', timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ err: err as Error | null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    );
    // Test doubles return nothing; a real child has a stdin to feed.
    const input = (child as any)?.stdin;
    if (input) {
      input.on('error', () => {});
      input.end(stdin);
    }
  });
}

export async function probeRemote(host: string): Promise<MeshNode> {
  const first = await sshRun(host, ['sh'], buildProbeScript());
  let { err, stdout, stderr } = first;

  if (!stdout.includes('uf=1') && NO_SH.test(stderr + stdout)) {
    const second = await sshRun(host, ['powershell', '-NoProfile', '-NonInteractive', '-Command', '-'], POWERSHELL_SCRIPT);
    if (second.stdout.includes('uf=1')) ({ err, stdout, stderr } = second);
  }

  if (err && !stdout.includes('uf=1')) {
    const msg = err.message ?? '';
    return {
      hostname: host,
      reachable: false,
      error: msg.includes('ETIMEDOUT') || /timed out/i.test(msg) ? 'Connection timed out'
        : NO_SH.test(stderr + stdout) ? 'No POSIX shell or PowerShell on remote'
        : 'Unreachable',
    };
  }

  try {
    return parseRemoteProbe(host, stdout);
  } catch (parseErr: any) {
    return { hostname: host, reachable: false, error: parseErr.message };
  }
}
