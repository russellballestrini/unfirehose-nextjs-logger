// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { OverviewTab, HarnessesTab, ProcessesTab, BootstrapTab, SettingsTab } from './tabs';

/**
 * The five tabs of a node's detail page.
 *
 * Split out of NodeDetailPage earlier today — seventy-nine branches in one
 * function — which made each readable but still only reachable by opening
 * the page against a machine that answers an SSH probe. Given the bag of
 * state the page hands them, each renders on its own.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }), useParams: () => ({ node: 'cammy' }),
  usePathname: () => '/permacomputer/cammy', useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/components/UPlotTimeChart', () => ({ UPlotTimeChart: () => null, default: () => null }));

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  window.confirm ??= (() => true) as never;
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as never;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1024 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 400 });
});

afterEach(cleanup);

const ref = <T,>(v: T) => ({ current: v });

const bag = (over: Record<string, unknown> = {}) => ({
  host: 'cammy',
  isLocal: false,
  node: {
    hostname: 'cammy', reachable: true, cpuCores: 32, memTotalGB: 377.8, memUsedGB: 94.4,
    uptime: '29d 10h', powerWatts: 142, gpuPowerWatts: 11, powerSource: 'tdp',
    cpuTdpWatts: 115, loadAvg: [9.3, 8, 7], harnessCounts: { claude: 2 }, claudeProcesses: 2,
  },
  probe: {
    system: { cpuModel: 'Intel Xeon E5-2670', cpuCores: 32, cpuMhz: 1200, arch: 'x86_64',
              kernel: '6.6.44', os: 'Debian GNU/Linux 12', cpuCache: '20480 KB' },
    memory: { totalGB: 377.8, usedGB: 94.4, availableGB: 283, buffers: 0, cached: 0.7, shmem: 0.1 },
    // Populated on purpose: each of these drives a whole panel, and an
    // empty list renders the tab's shell and none of its content.
    disks: [{ device: '/dev/sda1', mount: '/', sizeGB: 1800, usedGB: 1600, usePct: 89, fs: 'ext4' }],
    network: [{ iface: 'eno1', addresses: ['192.168.1.18/24', 'fe80::1/64'], up: true }],
    containers: [{ name: 'open-webui', image: 'ghcr.io/open-webui:0.6', status: 'Up 4 weeks (healthy)', ports: '8080/tcp' }],
    harnessProcesses: [{ pid: 1234, harness: 'claude', cpu: 2.1, mem: 1.4, command: '/home/fox/.local/bin/claude', user: 'fox' }],
    claudeProcesses: [{ pid: 1234, cpu: 2.1, mem: 1.4, command: 'claude' }],
    harnessCounts: { claude: 1 },
    uptimeSeconds: 2540000,
  },
  probeLoading: false,
  sys: { cpuModel: 'Intel Xeon E5-2670', cpuCores: 32, cpuMhz: 1200, arch: 'x86_64',
         kernel: '6.6.44', os: 'Debian GNU/Linux 12', cpuCache: '20480 KB' },
  mem: { totalGB: 377.8, usedGB: 94.4, availableGB: 283, swapTotalGB: 8, swapUsedGB: 0,
         buffers: 0, cached: 0.7, shmem: 0.1 },
  memPct: 25,
  loadPerCore: 0.29,
  chartData: [
    { tsMs: 1757000000000, timestamp: '2026-09-04 12:00:00', watts: 142, cpuWatts: 131, gpuWatts: 11,
      load: 9.3, cores: 32, memUsedGB: 94, memTotalGB: 378, memCapGB: 384, claudes: 2, agents: 2,
      gpuUtil: 0, gpuMemUsedGB: 0, gpuMemTotalGB: 24, elecCostPerHour: 0.04 },
    { tsMs: 1757000060000, timestamp: '2026-09-04 12:01:00', watts: 150, cpuWatts: 138, gpuWatts: 12,
      load: 8.1, cores: 32, memUsedGB: 95, memTotalGB: 378, memCapGB: 384, claudes: 2, agents: 2,
      gpuUtil: 5, gpuMemUsedGB: 1, gpuMemTotalGB: 24, elecCostPerHour: 0.05 },
  ],
  chartDataRef: ref([]), chartEngine: 'recharts', toggleEngine: vi.fn(),
  range: '24h', setRange: vi.fn(), rangeRef: ref('24h'),
  zoomDomain: null, setZoomDomain: vi.fn(), applyZoom: vi.fn(),
  closestRangeForZoom: () => '24h', zoomDrivenRangeRef: ref(false),
  viewMinRef: ref(0), viewMaxRef: ref(0), liveDataMinMaxRef: ref({ min: 0, max: 0 }),
  hoverTimerRef: ref(null), setHoverInfo: vi.fn(),
  tmuxData: { sessions: ['claude', 'agent-1'] },
  previewSession: null, setPreviewSession: vi.fn(), previewContent: '', previewRef: ref(null),
  kwhRate: 0.31, setKwhRate: vi.fn(), ispCost: 110, setIspCost: vi.fn(),
  wattsOverride: null, setWattsOverride: vi.fn(),
  diskOverride: null, setDiskOverride: vi.fn(),
  saveSetting: vi.fn(), saveSshHost: vi.fn(), sshSaving: false,
  sshEditing: false, setSshEditing: vi.fn(),
  sshForm: { name: 'cammy', hostname: 'cammy.foxhop.net', port: '22', user: 'fox' },
  setSshForm: vi.fn(),
  bootHost: 'cammy', bootHarness: vi.fn(), bootFilter: '', setBootFilter: vi.fn(),
  bootStatuses: {},
  ...over,
});

const tabs = {
  Overview: OverviewTab, Harnesses: HarnessesTab, Processes: ProcessesTab,
  Bootstrap: BootstrapTab, Settings: SettingsTab,
};

describe('every node tab renders', () => {
  for (const [name, Tab] of Object.entries(tabs)) {
    it(`renders ${name} for a node that answered`, () => {
      expect(() => render(<Tab {...bag()} />)).not.toThrow();
    });

    it(`renders ${name} for a node that did not`, () => {
      // Half the fleet is asleep at any time, and the page still has to draw.
      expect(() => render(<Tab {...bag({
        node: { hostname: 'cammy', reachable: false, error: 'Connection timed out' },
        probe: null, sys: null, mem: null, probeLoading: false,
      })} />)).not.toThrow();
    });
  }

  it('shows the CPU a node reported', () => {
    expect(render(<OverviewTab {...bag()} />).container.textContent).toContain('Xeon');
  });

  it('says a probe failed rather than showing an empty system panel', () => {
    const { container } = render(<OverviewTab {...bag({ probe: null, sys: null, mem: null })} />);
    expect(container.textContent).toMatch(/Probe failed|unreachable|Probing/i);
  });

  it('shows the ssh form on the settings tab', () => {
    expect(render(<SettingsTab {...bag()} />).container.textContent).toContain('cammy.foxhop.net');
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
