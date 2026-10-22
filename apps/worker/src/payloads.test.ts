import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { storedBeyond, refreshRanges } from './payloads';
import { superviseChild } from './sampler-supervisor';

describe('storedBeyond', () => {
  it('keeps the ranges a request stored that no warm tick owns, once each', () => {
    expect(storedBeyond(() => ['7d', '90d', 'all', '90d', '28d'], ['24h', '7d'], ['28d'])).toEqual(['90d', 'all']);
  });
});

describe('refreshRanges', () => {
  it('logs a rebuild, says nothing for a skip, and carries on past a failure', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    refreshRanges('dashboard', (range) => {
      seen.push(range);
      if (range === 'bad') throw new Error('locked');
      return range === 'skip' ? null : {};
    }, ['7d', 'skip', 'bad', 'all'], 1000);
    expect(seen).toEqual(['7d', 'skip', 'bad', 'all']);
    expect(log.mock.calls.map((c) => String(c[0]).split(' in ')[0])).toEqual(['[payloads] dashboard 7d', '[payloads] dashboard all']);
    expect(err).toHaveBeenCalledTimes(1);
  });
});

describe('superviseChild', () => {
  it('forks with its flag set and starts the child again when it exits', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'uf-child-'));
    const entry = path.join(dir, 'child.mjs');
    // Exits at once unless the flag is set, so a run without it shows as no restart line.
    writeFileSync(entry, "if (process.env.UF_TEST_CHILD === '1') process.exit(3);\n");
    const lines: string[] = [];
    const sup = superviseChild('probe', entry, 'UF_TEST_CHILD', (l) => lines.push(l));
    await vi.waitFor(() => expect(lines.some((l) => l.includes('probe exited (code 3)'))).toBe(true), { timeout: 5000 });
    sup.stop();
    rmSync(dir, { recursive: true, force: true });
    expect(lines[0]).toMatch(/^\[worker\] probe started \(pid \d+\)$/);
  });
});
