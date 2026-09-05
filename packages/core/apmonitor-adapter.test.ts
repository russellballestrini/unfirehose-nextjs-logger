import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** What the one ssh call returns, per test. */
let sshOutput: string | Error = new Error('ssh: Could not resolve hostname');
vi.mock('child_process', () => ({
  execSync: () => { if (sshOutput instanceof Error) throw sshOutput; return sshOutput; },
}));

const { toResources, readAPMonitorState, readRemoteAPMonitorState } =
  await import('./apmonitor-adapter');

/**
 * Reading APMonitor's statefile.
 *
 * APMonitor is a separate tool under its own licence; nothing of it is
 * embedded here. This reads the JSON it leaves on disk, the same way we
 * read /proc or the output of an ssh command — so the failures are a
 * missing file, a half-written one, and a host that will not answer, and
 * each of those has to read as "no data" rather than take a page down.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apmonitor-'));
const statefile = path.join(dir, 'apmonitor-statefile.json');

const STATE = {
  'unturf.com': {
    is_up: true, last_checked: '2026-09-04T12:00:00Z', last_response_time_ms: 128,
    down_count: 0, notified_count: 0, ports_state: { 443: 'open' },
  },
  'proxy.uncloseai.com': {
    is_up: false, last_checked: '2026-09-04T12:00:00Z', error_reason: 'connection refused',
    down_count: 3, notified_count: 1, last_notified: '2026-09-04T11:55:00Z',
    last_alarm_started: '2026-09-04T11:40:00Z',
  },
};

beforeAll(() => fs.writeFileSync(statefile, JSON.stringify(STATE)));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('toResources', () => {
  it('turns the statefile into one row per resource', () => {
    const rows = toResources(STATE);
    expect(rows.map(r => r.name)).toEqual(['unturf.com', 'proxy.uncloseai.com']);
    expect(rows[0]).toMatchObject({ isUp: true, lastResponseTimeMs: 128, portsState: { 443: 'open' } });
    expect(rows[1]).toMatchObject({ isUp: false, errorReason: 'connection refused', downCount: 3 });
  });

  it('defaults a counter a healthy resource never wrote', () => {
    // A resource that has never gone down omits these entirely. Passing
    // undefined through renders a blank where a zero belongs.
    const [row] = toResources({ 'a.example': { is_up: true } });
    expect(row).toMatchObject({ downCount: 0, notifiedCount: 0, lastNotified: null, portsState: null });
  });

  it('reads a missing is_up as down, since only true means up', () => {
    expect(toResources({ 'a.example': {} })[0].isUp).toBe(false);
  });

  it('has nothing to say about a statefile that is not an object', () => {
    expect(toResources(null)).toEqual([]);
    expect(toResources('{}')).toEqual([]);
  });
});

describe('readAPMonitorState', () => {
  it('reads the file and reports when it was written', () => {
    const state = readAPMonitorState(statefile);
    expect(state.error).toBeNull();
    expect(state.resources).toHaveLength(2);
    expect(state.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('says the statefile is missing rather than that everything is down', () => {
    // An empty resource list from a missing file would show a monitoring
    // page with nothing wrong on it.
    const state = readAPMonitorState(path.join(dir, 'nope.json'));
    expect(state.error).toBe('Statefile not found');
    expect(state.resources).toEqual([]);
  });

  it('reports a half-written file as an error, not as no resources', () => {
    // The file is rewritten in place by another process, so a read can
    // land mid-write.
    const partial = path.join(dir, 'partial.json');
    fs.writeFileSync(partial, '{"unturf.com": {"is_u');
    const state = readAPMonitorState(partial);
    expect(state.error).toBeTruthy();
    expect(state.resources).toEqual([]);
  });
});

describe('readRemoteAPMonitorState', () => {
  it('parses the file and the mtime out of one ssh call', () => {
    // Two calls would be two connections; the marker is how one command
    // returns both.
    sshOutput = `${JSON.stringify(STATE)}\n---STAT---\n1757000000\n`;
    const state = readRemoteAPMonitorState('cammy', '/var/tmp/apmonitor-statefile.json');
    expect(state.resources).toHaveLength(2);
    expect(state.statefilePath).toBe('cammy:/var/tmp/apmonitor-statefile.json');
    expect(state.lastModified).toBe(new Date(1757000000 * 1000).toISOString());
  });

  it('names the host in the path, so two nodes are told apart', () => {
    sshOutput = new Error('ssh: connect to host unreachable-node port 22: No route to host');
    const state = readRemoteAPMonitorState('unreachable-node');
    expect(state.statefilePath).toMatch(/^unreachable-node:/);
  });

  it('says a node did not answer rather than that it is healthy', () => {
    // Silence from a monitoring host is not an all-clear.
    sshOutput = new Error('ETIMEDOUT');
    const state = readRemoteAPMonitorState('unreachable-node.invalid');
    expect(state.error).toBe('Connection timed out');
    expect(state.resources).toEqual([]);
  });
});
