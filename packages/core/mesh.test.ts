import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Which machines our mesh is made of, read from ssh config.
 *
 * There is no registry — a node is a machine somebody can already ssh to,
 * which is why this file is the source of truth. The rule that matters is
 * collapsing aliases: two Host blocks pointing at the same HostName are
 * one machine, and counting both doubles that machine's cores, memory and
 * watts in every total on the Permacomputer page.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'unfirehose-ssh-'));
fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home };
});

const { discoverNodes } = await import('./mesh');

const config = (text: string) =>
  fs.writeFileSync(path.join(home, '.ssh', 'config'), text);

beforeEach(() => config(''));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe('discoverNodes', () => {
  it('always includes this machine', () => {
    // Every mesh has at least the box the dashboard is running on.
    expect(discoverNodes()).toEqual(['localhost']);
  });

  it('takes a bare name as a node', () => {
    config('Host cammy\n  HostName cammy.foxhop.net\n  User fox\n');
    expect(discoverNodes()).toEqual(['localhost', 'cammy']);
  });

  it('takes a name on our own domain', () => {
    config('Host guile.foxhop.net\n  User fox\n');
    expect(discoverNodes()).toContain('guile.foxhop.net');
  });

  it('collapses two aliases for one machine', () => {
    // Counting both doubles that machine's cores and watts in every
    // total on the mesh page.
    config([
      'Host cammy',
      '  HostName cammy.foxhop.net',
      '',
      'Host cammy-vpn',
      '  HostName cammy.foxhop.net',
      '',
    ].join('\n'));
    expect(discoverNodes()).toEqual(['localhost', 'cammy']);
  });

  it('keeps the first block in file order when two collide', () => {
    config('Host a\n  HostName same.foxhop.net\n\nHost b\n  HostName same.foxhop.net\n');
    expect(discoverNodes()).toEqual(['localhost', 'a']);
  });

  it('takes every name on one Host line', () => {
    config('Host neoblanka nb\n  HostName 10.0.0.4\n');
    expect(discoverNodes()).toEqual(['localhost', 'neoblanka']);
  });

  it('ignores a pattern, which is settings rather than a machine', () => {
    config('Host *\n  ServerAliveInterval 60\n\nHost *.internal\n  User fox\n');
    expect(discoverNodes()).toEqual(['localhost']);
  });

  it('ignores git forges, which answer ssh but are not nodes', () => {
    // git.unturf.com and github.com are in everyone's config, and probing
    // them as compute reports a mesh node that will never answer.
    config('Host git.unturf.com\n  Port 2222\n\nHost github.com\n  User git\n');
    expect(discoverNodes()).toEqual(['localhost']);
  });

  it('ignores an unrelated host on someone else\'s domain', () => {
    config('Host jump.example.com\n  User fox\n');
    expect(discoverNodes()).toEqual(['localhost']);
  });

  it('does not add localhost twice', () => {
    config('Host localhost\n  HostName 127.0.0.1\n');
    expect(discoverNodes()).toEqual(['localhost']);
  });

  it('matches HostName case-insensitively when collapsing', () => {
    config('Host a\n  HostName Cammy.Foxhop.Net\n\nHost b\n  HostName cammy.foxhop.net\n');
    expect(discoverNodes()).toEqual(['localhost', 'a']);
  });

  it('takes a block with no HostName at its own name', () => {
    config('Host solo\n  User fox\n');
    expect(discoverNodes()).toEqual(['localhost', 'solo']);
  });

  it('reports just this machine when there is no ssh config', () => {
    fs.rmSync(path.join(home, '.ssh', 'config'));
    expect(discoverNodes()).toEqual(['localhost']);
  });
});
