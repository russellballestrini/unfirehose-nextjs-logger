import { buildProbeScript } from './index';
import { POWERSHELL_SCRIPT } from './powershell';
import { CMD_SCRIPT } from './cmd';
import { translateRouterOS, translateCiscoIOS, translateFortiOS } from './network';

/**
 * A speaker is one way of getting our wire out of a remote machine: the
 * program to run over ssh, what to feed it on stdin, and — for a device
 * whose command language cannot print `key=value` itself — a translator
 * that turns its native report into the wire on our side.
 *
 * The Bourne script covers every machine with a `sh`; the rest are the
 * environments where `sh` is not a program: PowerShell and cmd on
 * Windows, and the command lines of network gear, which are not shells at
 * all. Each costs one SSH round trip, so the chain is walked only while
 * the previous attempt proves the box is up and answering *something*.
 */
export interface Speaker {
  id: string;
  /** Remote argv after the hostname. */
  command: string[];
  /** Fed on stdin. */
  stdin: string;
  /** ssh needs a pty for this one (network CLIs refuse to run without). */
  tty?: boolean;
  /** Native report → wire. Absent when the speaker prints the wire itself. */
  translate?: (stdout: string) => string;
  /**
   * What the *previous* speaker's failure looks like when this one is the
   * right next try. A speaker with no hint is tried only when named.
   */
  after?: RegExp;
  /** Verified against a real device, or written from the manuals. */
  verified: boolean;
}

// What a Windows command processor says when asked to run `sh`.
const WINDOWS_NO_SH = /not recognized as an internal or external command|The term 'sh' is not recognized|CommandNotFoundException/i;
// What a Unix with no sh on PATH says (busybox images without the link).
const UNIX_NO_SH = /sh: (command )?not found|sh: No such file|exec: sh: not found/i;
// What a network OS says to a command it does not have. Junos: "unknown
// command". Cisco: "% Invalid input detected". RouterOS: "bad command name".
// Arista: "% Invalid input". Fortinet: "Unknown action 0".
const NETWORK_CLI = /unknown command|% Invalid input|bad command name|Unknown action|command not found\.$|syntax error, expecting/im;

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '-'];

export function speakers(): Speaker[] {
  const sh = buildProbeScript();
  return [
    { id: 'sh', command: ['sh'], stdin: sh, verified: true },
    // A Unix whose sh is missing from PATH but not from the box.
    { id: 'busybox-sh', command: ['busybox', 'sh'], stdin: sh, after: UNIX_NO_SH, verified: true },
    { id: 'bash', command: ['bash'], stdin: sh, after: UNIX_NO_SH, verified: true },
    { id: 'ksh', command: ['ksh'], stdin: sh, after: UNIX_NO_SH, verified: true },
    // Windows.
    { id: 'powershell', command: ['powershell', ...PS_ARGS], stdin: POWERSHELL_SCRIPT, after: WINDOWS_NO_SH, verified: true },
    { id: 'pwsh', command: ['pwsh', ...PS_ARGS], stdin: POWERSHELL_SCRIPT, after: WINDOWS_NO_SH, verified: true },
    { id: 'cmd', command: ['cmd'], stdin: CMD_SCRIPT, after: WINDOWS_NO_SH, verified: true },
    // Network operating systems with a Unix underneath: the CLI has a
    // word that drops to it, and our Bourne script runs there. JUNOS
    // reports uname -s JUNOS and is a FreeBSD; EOS and NX-OS are Linux.
    { id: 'junos', command: ['start', 'shell', 'sh'], stdin: sh, after: NETWORK_CLI, verified: false },
    { id: 'eos', command: ['bash'], stdin: sh, after: NETWORK_CLI, verified: false },
    { id: 'nxos', command: ['run', 'bash', 'sh'], stdin: sh, after: NETWORK_CLI, verified: false },
    // Network operating systems with no Unix to reach: their own report,
    // translated here. A single command over ssh for RouterOS; a pty
    // session with commands on stdin for the ones that only talk that way.
    { id: 'routeros', command: ['/system', 'resource', 'print', 'without-paging'], stdin: '', translate: translateRouterOS, after: NETWORK_CLI, verified: false },
    { id: 'cisco-ios', command: [], stdin: 'terminal length 0\nshow version\nshow processes cpu | include CPU utilization\nshow memory statistics\nshow inventory\nexit\n', tty: true, translate: translateCiscoIOS, after: NETWORK_CLI, verified: false },
    { id: 'fortios', command: [], stdin: 'get system status\nget system performance status\nexit\n', tty: true, translate: translateFortiOS, after: NETWORK_CLI, verified: false },
  ];
}

/** Which speakers to try after `failed` said `text`. */
export function nextSpeakers(all: Speaker[], failed: Speaker, text: string): Speaker[] {
  const i = all.indexOf(failed);
  return all.slice(i + 1).filter(s => s.after?.test(text));
}
