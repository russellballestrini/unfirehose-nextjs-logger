// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import {
  OverviewTab, HarnessesTab, BootstrapTab, ServicesTab, SessionsTab, EphemeralTab,
} from './page';

/**
 * The six tabs of the unsandbox page, each on its own.
 *
 * They were extracted from one 63-branch component earlier today, which made
 * them separable but not reachable: a tab still only rendered if the page
 * put it there, and the page only did that against a live account. Given
 * the bag of state they read, each can be shown directly.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }), useParams: () => ({}),
  usePathname: () => '/permacomputer/unsandbox', useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  window.confirm ??= (() => true) as never;
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as never;
});

afterEach(cleanup);

/** What the page hands every tab. */
const bag = (over: Record<string, unknown> = {}) => ({
  status: { connected: true, tier: 13, rateLimit: 91, maxSessions: 4, burst: 91, expiresAtHuman: '30 days' },
  probe: {
    cpuCores: 4, memTotalGB: 8, memUsedGB: 2, memAvailGB: 6, loadAvg: [0.5, 0.4, 0.3],
    uptime: '2d 3h', cpuModel: 'AMD EPYC', arch: 'x86_64', swapUsedGB: 0,
  },
  probeError: null, probing: false, runProbe: vi.fn(),
  cpuCores: 4, memTotal: 8, memUsed: 2, memAvail: 6, memPct: 25,
  // load is the three loadavg figures, not one number.
  load: [0.5, 0.4, 0.3], loadPct: 12, loadPerCore: 0.125,
  serviceList: [{ id: 's1', name: 'unfirehose', status: 'running', domain: 'demo.unsandbox.com', ports: '8080' }],
  // The unsandbox API answers in snake_case; the page reads it as it comes.
  sessionList: [{
    id: 'sess-1', session_id: 'sess-1', image: 'ubuntu:24.04', status: 'running',
    created_at: '2026-09-04T12:00:00Z', shell: '/bin/bash',
  }],
  sessionProcs: {}, probeSessionProcesses: vi.fn(), probingSessions: {},
  unfirehoseService: null, deployUnfirehose: vi.fn(), deploying: false,
  deployResult: null, deployError: null, serviceLabel: '', setServiceLabel: vi.fn(),
  destroyService: vi.fn(), killSession: vi.fn(), killingSession: null, mutateSessions: vi.fn(),
  nicknames: {}, editingNick: null, setEditingNick: vi.fn(), saveNickname: vi.fn(),
  cmd: 'echo hi', setCmd: vi.fn(), cmdResult: null, cmdRunning: false, executeCommand: vi.fn(),
  network: 'semitrusted', setNetwork: vi.fn(),
  bootFilter: '', setBootFilter: vi.fn(), bootHarness: 'claude-code', bootStatuses: {},
  setActiveTab: vi.fn(),
  ...over,
});

const tabs = {
  Overview: OverviewTab, Harnesses: HarnessesTab, Bootstrap: BootstrapTab,
  Services: ServicesTab, Sessions: SessionsTab, Ephemeral: EphemeralTab,
};

describe('every unsandbox tab renders', () => {
  for (const [name, Tab] of Object.entries(tabs)) {
    it(`renders ${name}`, () => {
      expect(() => render(<Tab {...bag()} />)).not.toThrow();
    });

    it(`renders ${name} before the account has answered`, () => {
      // Every tab paints before the first probe returns.
      expect(() => render(
        <Tab {...bag({
          probe: null, serviceList: [], sessionList: [],
          cpuCores: 0, memTotal: 0, memUsed: 0, memAvail: 0, memPct: 0,
          load: [0, 0, 0], loadPct: 0, loadPerCore: 0,
        })} />,
      )).not.toThrow();
    });
  }

  it('shows the account tier on the overview', () => {
    expect(render(<OverviewTab {...bag()} />).container.textContent).toContain('13');
  });

  it('shows a deployed service', () => {
    expect(render(<ServicesTab {...bag()} />).container.textContent).toContain('unfirehose');
  });

  it('shows a running session', () => {
    expect(render(<SessionsTab {...bag()} />).container.textContent).toContain('sess-1');
  });

  it('reports a failed probe rather than an empty panel', () => {
    const { container } = render(<OverviewTab {...bag({ probe: null, probeError: 'timed out' })} />);
    expect(container.textContent).toContain('timed out');
  });

  it('leaves the controls on each tab pressable', () => {
    for (const Tab of Object.values(tabs)) {
      const { container, unmount } = render(<Tab {...bag()} />);
      for (const b of container.querySelectorAll('button')) act(() => { (b as HTMLElement).click(); });
      unmount();
    }
    expect(true).toBe(true);
  });
});
