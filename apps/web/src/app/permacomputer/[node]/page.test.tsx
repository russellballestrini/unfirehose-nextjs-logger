// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/react';

/**
 * One machine on the mesh.
 *
 * The page itself is a shell around five tabs: it decides which tab is
 * open, gathers what the tabs read, and owns the shared chart cursor that
 * keeps eight charts locked together. That cursor is the interesting part
 * — it is a mousemove listener on the window with a binary search over the
 * series, and it has to survive a mouse that is between two cards.
 */

let mesh: Record<string, unknown> | undefined;
let history: Record<string, unknown> | undefined;
let probe: Record<string, unknown> | undefined;
let settings: Record<string, string> | undefined;
let sshConfig: Record<string, unknown> | undefined;
let tmuxData: Record<string, unknown> | undefined;

vi.mock('swr', () => ({
  default: (key: string | null) => {
    const k = String(key);
    return {
      data: k.includes('/api/mesh/history') ? history
        : k.includes('/api/mesh/node') ? probe
        : k.startsWith('/api/mesh') ? mesh
        : k.startsWith('/api/settings') ? settings
        : k.startsWith('/api/ssh-config') ? sshConfig
        : k.includes('tmux') ? tmuxData
        : undefined,
      error: undefined, isLoading: false, mutate: vi.fn(),
    };
  },
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ node: 'cammy' }),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/permacomputer/cammy',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/UPlotTimeChart', () => ({ UPlotTimeChart: () => null, default: () => null }));

const NodeDetailPage = (await import('./page')).default;

const node = {
  hostname: 'cammy', reachable: true, cpuCores: 32, cpuModel: 'Intel Xeon E5-2670',
  cpuTdpWatts: 115, memTotalGB: 377.8, memUsedGB: 94.4, memCapGB: 384,
  memAvailableGB: 283, loadAvg: [9.3, 8, 7], uptime: '29d 10h', uptimeSeconds: 2_540_000,
  claudeProcesses: 2, harnessCounts: { claude: 2 }, powerWatts: 142, gpuPowerWatts: 11,
  powerSource: 'tdp', arch: 'x86_64', swapTotalGB: 8, swapUsedGB: 0,
  spinningDisks: 1, ssdCount: 2, cpuYear: 2014,
};

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  window.matchMedia ??= ((q: string) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {},
  })) as never;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1024 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 300 });
});

beforeEach(() => {
  window.location.hash = '';
  localStorage.clear();
  mesh = { nodes: [node], localHostname: 'neoblanka' };
  history = { timeline: [
    { tsMs: 1_757_000_000_000, timestamp: '2026-09-04 12:00:00', cammy: { watts: 142, load: 9.3 } },
    { tsMs: 1_757_000_060_000, timestamp: '2026-09-04 12:01:00', cammy: { watts: 150, load: 8.1 } },
  ], hostnames: ['cammy'] };
  probe = {
    hostname: 'cammy', reachable: true,
    system: { cpuModel: 'Intel Xeon E5-2670', cpuCores: 32, cpuMhz: 1200, arch: 'x86_64',
              kernel: '6.6.44', os: 'Debian GNU/Linux 12', cpuCache: '20480 KB' },
    memory: { totalGB: 377.8, usedGB: 94.4, availableGB: 283, buffers: 0, cached: 0.7, shmem: 0.1 },
    disk: [{ device: '/dev/sda1', mount: '/', sizeGB: 1800, usedGB: 1600, usePct: 89, fs: 'ext4' }],
    network: { interfaces: [{ iface: 'eno1', addresses: ['192.168.1.18/24'], up: true }], throughput: [] },
    containers: [], processes: [], claudeProcesses: [], harnessProcesses: [],
    harnessCounts: { claude: 2 }, gpu: { hasGpu: false, nvidia: [], amd: [], nvidiaProcesses: [] },
    temperatures: [], sensors: [], throttle: null, cpuTopology: null,
    sessions: { tmux: [], screen: [] }, uptimeSeconds: 2_540_000, truncated: false,
  };
  settings = { mesh_default_electricity_kwh: '0.31' };
  sshConfig = { hosts: [{ name: 'cammy', hostname: 'cammy.foxhop.net', port: '22', user: 'fox' }] };
  tmuxData = { sessions: ['claude'] };
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })) as never;
});
afterEach(cleanup);

const show = async () => {
  const view = render(<NodeDetailPage />);
  await act(async () => { await Promise.resolve(); });
  return view;
};
const tab = async (name: string) => {
  const el = [...document.querySelectorAll('button')]
    .find(b => b.textContent?.trim().startsWith(name));
  if (el) await act(async () => { el.click(); });
};

describe('the node page', () => {
  it('shows the machine it was asked about', async () => {
    const { container } = await show();
    expect(container.textContent).toContain('cammy');
  });

  it('opens on the tab named in the url, since this page is linked to', async () => {
    window.location.hash = '#Settings';
    const { container } = await show();
    expect(container.textContent).toMatch(/electricity|ssh/i);
  });

  it('remembers the tab somebody chose', async () => {
    await show();
    await tab('Processes');
    expect(window.location.hash).toBe('#Processes');
  });

  it('renders every tab', async () => {
    const { container } = await show();
    for (const t of ['Harnesses', 'Processes', 'Bootstrap', 'Settings', 'Overview']) {
      await tab(t);
      expect(container.textContent!.length, t).toBeGreaterThan(200);
    }
  });

  it('draws a node the mesh has never heard of', async () => {
    // Somebody following an old link, or a node removed from ssh config.
    mesh = { nodes: [], localHostname: 'neoblanka' };
    probe = undefined;
    const { container } = await show();
    expect(container.textContent).not.toContain('undefined');
    expect(container.textContent).not.toContain('NaN');
  });

  it('draws a node that did not answer its probe', async () => {
    // Half the fleet is asleep at any time and the page still has to draw.
    mesh = { nodes: [{ hostname: 'cammy', reachable: false, error: 'Connection timed out' }] };
    probe = null as never;
    const { container } = await show();
    expect(container.textContent).toContain('cammy');
    expect(container.textContent).not.toContain('NaN');
  });

  it('draws before any history has arrived', async () => {
    history = undefined;
    const { container } = await show();
    expect(container.textContent!.length).toBeGreaterThan(100);
  });

  it('survives a mouse crossing the page with no chart under it', async () => {
    // The cursor listener is on the window and runs on every mousemove,
    // including the ones between two cards.
    await show();
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 5 }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 120)); });
    expect(document.body.textContent).not.toContain('NaN');
  });

  it('stops listening for the cursor when the page goes away', async () => {
    // A leaked mousemove listener runs on every frame of every later page.
    await show();
    cleanup();
    expect(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1, clientY: 1 }))).not.toThrow();
  });
});
