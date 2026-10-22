import { describe, it, expect } from 'vitest';
import { sameBox, sshHostMatchesMesh, sshHostForMesh, resolveMeshHostname, findSameBox } from './hostname-match';

// Verbatim from ~/.ssh/config. ryu's alias and HostName share nothing but
// the domain; 4090-ai's HostName is the tail of its alias, not a prefix.
const ryu = { name: 'ai-3060.foxhop.net', hostname: 'ryu.foxhop.net' };
const ai = { name: '4090-ai.foxhop.net', hostname: 'ai.foxhop.net' };
const neoblanka = { name: 'neoblanka', hostname: '192.168.1.20' };
const cammy = { name: 'cammy.foxhop.net', hostname: 'cammy.foxhop.net' };
const ssh = [ryu, ai, neoblanka, cammy];

describe('sameBox', () => {
  it('is a name against itself or against itself with a domain, either way round', () => {
    expect(sameBox('cammy', 'cammy')).toBe(true);
    expect(sameBox('cammy', 'cammy.foxhop.net')).toBe(true);
    expect(sameBox('cammy.foxhop.net', 'cammy')).toBe(true);
    expect(sameBox('Cammy.FOXHOP.net', 'cammy')).toBe(true);
  });

  it('is not a shared prefix that stops short of a dot, nor an empty name', () => {
    expect(sameBox('cam', 'cammy')).toBe(false);
    expect(sameBox('ai', '4090-ai.foxhop.net')).toBe(false);
    expect(sameBox('', '')).toBe(false);
    expect(sameBox(undefined, 'cammy')).toBe(false);
  });
});

describe('sshHostMatchesMesh', () => {
  it('matches ryu by its alias, which is what the sampler keys rows by', () => {
    expect(sshHostMatchesMesh(ryu, 'ai-3060.foxhop.net')).toBe(true);
    expect(sshHostMatchesMesh(ryu, 'ryu.foxhop.net')).toBe(true);
    expect(sshHostMatchesMesh(ryu, 'ryu')).toBe(true);
    expect(sshHostMatchesMesh(ryu, 'ai-3060')).toBe(true);
    expect(sshHostMatchesMesh(ryu, 'ai')).toBe(false);
  });

  it('matches a short mesh hostname to its fully qualified SSH entry, and the reverse', () => {
    expect(sshHostMatchesMesh({ name: 'cammy.foxhop.net' }, 'cammy')).toBe(true);
    expect(sshHostMatchesMesh({ name: 'cammy' }, 'cammy.foxhop.net')).toBe(true);
    expect(sshHostMatchesMesh({ name: 'cammy.foxhop.net' }, '')).toBe(false);
  });
});

describe('sshHostForMesh', () => {
  it('takes a literal match over an earlier fuzzy one', () => {
    const hosts = [{ name: 'ai.foxhop.net' }, { name: 'ai' }];
    expect(sshHostForMesh(hosts, 'ai')).toBe(hosts[1]);
    expect(sshHostForMesh(ssh, 'ai.foxhop.net')).toBe(ai);
  });

  it('finds ryu from either name and nothing for a stranger', () => {
    expect(sshHostForMesh(ssh, 'ai-3060.foxhop.net')).toBe(ryu);
    expect(sshHostForMesh(ssh, 'ryu')).toBe(ryu);
    expect(sshHostForMesh(ssh, 'ken')).toBeUndefined();
    expect(sshHostForMesh(ssh, '')).toBeUndefined();
  });
});

describe('findSameBox', () => {
  it('reads any number of names per item', () => {
    const rows = [{ a: 'x', b: 'ryu.foxhop.net' }];
    expect(findSameBox(rows, 'ryu', r => [r.a, r.b])).toBe(rows[0]);
  });
});

describe('resolveMeshHostname', () => {
  const mesh = [{ hostname: 'ai-3060.foxhop.net' }, { hostname: '4090-ai.foxhop.net' }, { hostname: 'neoblanka' }, { hostname: 'cammy' }];

  it('keeps a host the mesh already names', () => {
    expect(resolveMeshHostname('neoblanka', mesh, ssh)).toBe('neoblanka');
  });

  it('maps ryu\'s HostName, the one the fleet page links by, to the alias the mesh samples under', () => {
    expect(resolveMeshHostname('ryu.foxhop.net', mesh, ssh)).toBe('ai-3060.foxhop.net');
  });

  it('maps an SSH HostName back to the alias the mesh probed under', () => {
    expect(resolveMeshHostname('ai.foxhop.net', mesh, ssh)).toBe('4090-ai.foxhop.net');
    expect(resolveMeshHostname('192.168.1.20', mesh, ssh)).toBe('neoblanka');
    expect(resolveMeshHostname('cammy.foxhop.net', mesh, ssh)).toBe('cammy');
  });

  it('hands back what it was given when nothing matches or nothing loaded yet', () => {
    expect(resolveMeshHostname('nowhere.example', mesh, ssh)).toBe('nowhere.example');
    expect(resolveMeshHostname('ai.foxhop.net', undefined, ssh)).toBe('ai.foxhop.net');
    expect(resolveMeshHostname('ai.foxhop.net', mesh, undefined)).toBe('ai.foxhop.net');
  });
});
