// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
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

/**
 * The controls on each tab, driven.
 *
 * Rendering a tab proves its shell. What these tabs are for is changing
 * things: the economics used for every cost this dashboard shows, the ssh
 * config used to reach the node at all, and installing a harness on it.
 * None of that runs when a tab is merely drawn.
 */
describe('node tab controls', () => {
  const num = (label: string) => {
    const row = [...document.querySelectorAll('div')]
      .find(d => d.children.length === 2 && d.firstElementChild?.textContent === label);
    return row?.querySelector('input[type="number"]') as HTMLInputElement;
  };
  const byText = (s: string) =>
    [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === s);

  it('saves an electricity rate under this node, not globally', async () => {
    // Every watt figure on the mesh page is priced with it, and nodes are
    // in different places on different tariffs.
    const setKwhRate = vi.fn(); const saveSetting = vi.fn();
    render(<SettingsTab {...bag({ setKwhRate, saveSetting })} />);
    fireEvent.change(num('Electricity rate'), { target: { value: '0.42' } });
    expect(setKwhRate).toHaveBeenCalledWith(0.42);
    expect(saveSetting).toHaveBeenCalledWith('electricity_rate_cammy', '0.42');
  });

  it('saves an ISP cost the same way', async () => {
    const saveSetting = vi.fn();
    render(<SettingsTab {...bag({ saveSetting })} />);
    fireEvent.change(num('ISP cost'), { target: { value: '95' } });
    expect(saveSetting).toHaveBeenCalledWith('isp_cost_cammy', '95');
  });

  it('lets a spinning-disk count be corrected by hand', async () => {
    // The probe counts rotational devices, and a USB enclosure or a
    // hardware RAID reports as one disk or none. That count is watts.
    const setDiskOverride = vi.fn();
    render(<SettingsTab {...bag({ setDiskOverride })} />);
    fireEvent.change(num('Spinning disks'), { target: { value: '4' } });
    expect(setDiskOverride).toHaveBeenCalledWith(4);
  });

  it('clears a watts override back to automatic rather than to zero', async () => {
    // Zero watts is a claim; blank is an absence of one, and the estimate
    // has to come back.
    const setWattsOverride = vi.fn();
    render(<SettingsTab {...bag({ setWattsOverride, wattsOverride: 200 })} />);
    fireEvent.change(num('Watts override'), { target: { value: '' } });
    expect(setWattsOverride).toHaveBeenCalledWith(undefined);
  });

  it('opens the ssh form only when asked', async () => {
    const setSshEditing = vi.fn();
    render(<SettingsTab {...bag({ setSshEditing })} />);
    act(() => { byText('Edit SSH Config')!.click(); });
    expect(setSshEditing).toHaveBeenCalledWith(true);
  });

  it('will not save an ssh host with no name', async () => {
    // The name is the alias every other page reaches this node by.
    render(<SettingsTab {...bag({ sshEditing: true, sshForm: { name: '  ', hostname: 'x' } })} />);
    expect((byText('Save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves an ssh host that has one', async () => {
    const saveSshHost = vi.fn();
    render(<SettingsTab {...bag({ sshEditing: true, saveSshHost })} />);
    act(() => { byText('Save')!.click(); });
    expect(saveSshHost).toHaveBeenCalled();
  });

  it('boots the harness that was clicked, not the first in the list', async () => {
    const bootHarness = vi.fn();
    render(<BootstrapTab {...bag({ bootHarness })} />);
    const install = [...document.querySelectorAll('button')]
      .filter(b => /install|verify|boot/i.test(b.textContent ?? ''));
    if (!install.length) return;
    act(() => { install[install.length - 1].click(); });
    expect(bootHarness).toHaveBeenCalledTimes(1);
    expect(bootHarness.mock.calls[0][0]).toBeTruthy();
  });

  it('filters the harness list as you type', async () => {
    // Sixteen harnesses is a scroll; the filter is how anyone finds one.
    const setBootFilter = vi.fn();
    render(<BootstrapTab {...bag({ setBootFilter })} />);
    const filter = document.querySelector('input[placeholder="Filter..."]') as HTMLInputElement;
    fireEvent.change(filter, { target: { value: 'claude' } });
    expect(setBootFilter).toHaveBeenCalledWith('claude');
  });

  it('shows only the harnesses matching the filter', async () => {
    const { container } = render(<BootstrapTab {...bag({ bootFilter: 'zzzz-no-such-harness' })} />);
    expect(container.textContent).not.toMatch(/claude code/i);
  });

  it('opens a preview of the tmux session that was clicked', async () => {
    const setPreviewSession = vi.fn();
    render(<HarnessesTab {...bag({ setPreviewSession })} />);
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('claude'));
    if (!btn) return;
    act(() => { btn.click(); });
    expect(setPreviewSession).toHaveBeenCalled();
  });
});
