// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import { useRouter } from 'next/navigation';
import {
  MeshSummaryBar, NodeCard, FleetMetricsChart, FleetMetricsPanel, MeshEconomicsPanel, AddNodeButton,
} from './page';

/**
 * The panels the mesh page is made of.
 *
 * Each needs a fleet behind it — nodes that answer, a timeline of
 * snapshots — so none of them rendered under a page test against an empty
 * machine. Panels an integration adds are tested in its own directory.
 */

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: vi.fn() })), useParams: () => ({}),
  usePathname: () => '/permacomputer', useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/components/UPlotTimeChart', () => ({ UPlotTimeChart: () => null, default: () => null }));

const timeline = [0, 1, 2].map((i) => ({
  timestamp: `2026-09-04 12:0${i}:00`, totalWatts: 1200 + i, cpuWatts: 500, gpuWatts: 700,
  avgLoad: 0.2, totalLoad: 6, totalCores: 32, memUsedGB: 300, memTotalGB: 670,
  gpuUtil: 60, gpuMemUsedGB: 44, gpuMemTotalGB: 72, claudes: 3, nodeCount: 6,
  nodes: { cammy: { watts: 140, gpuWatts: 11, load: 9, cores: 32, memUsed: 94, claudes: 2, agents: 2 } },
}));

vi.mock('swr', () => ({
  default: () => ({
    data: { timeline, hostnames: ['cammy'], nodes: [], rates: {} },
    error: undefined, isLoading: false, mutate: vi.fn(),
  }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
  mutate: vi.fn(),
}));

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  window.confirm ??= (() => true) as never;
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as never;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1024 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 400 });
});

afterEach(cleanup);

const econ = {
  ispCostMonthly: 110, electricityCostKwh: 0.31, location: 'New London, CT',
  provider: 'home', linkMbps: 1000, lat: 41.35, lon: -72.1, notes: '',
};

const node = {
  hostname: 'cammy', reachable: true, cpuCores: 32, memTotalGB: 377.8, memUsedGB: 94.4,
  loadAvg: [9.3, 8, 7], uptime: '29d 10h', powerWatts: 142, gpuPowerWatts: 11,
  powerSource: 'tdp', cpuTdpWatts: 115, harnessCounts: { claude: 2 }, claudeProcesses: 2,
  gpuUtil: 0, gpuMemTotalMB: 24576, gpuMemUsedMB: 0, swapUsedGB: 3.3,
};


describe('mesh panels', () => {
  it('summarises the fleet', () => {
    const { container } = render(
      <MeshSummaryBar
        summary={{ reachable: 6, total: 6, agents: 8, cores: 132, memUsedGB: 306, memTotalGB: 673, allGreen: true }}
        geoipLoading={false} geoipCount={6}
      />,
    );
    expect(container.textContent).toContain('6');
  });

  it('renders a node card for a machine that answered', () => {
    const { container } = render(
      <NodeCard node={node} sshHost={{ name: 'cammy', hostname: 'cammy.foxhop.net' }}
                econ={econ} geoip={{ city: 'New London', countryCode: 'US', isp: 'Breezeline' }}
                egressGroups={new Map([['1.2.3.4', ['cammy', 'guile']]])} onHide={vi.fn()} />,
    );
    expect(container.textContent).toContain('cammy');
    expect(container.textContent).toContain('Breezeline');
  });

  it('offers the Containers tab from the card when the node runs any', () => {
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({ push } as never);
    const { container } = render(
      <NodeCard node={{ ...node, containers: 4, containersRunning: 3 }} sshHost={{ name: 'guile', hostname: 'guile.foxhop.net' }} econ={econ} />,
    );
    const pill = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '3/4 containers')!;
    expect(pill).toBeTruthy();
    act(() => { fireEvent.click(pill); });
    expect(push).toHaveBeenCalledWith('/permacomputer/guile.foxhop.net#Containers');
  });

  it('says nothing about containers on a node without a runtime', () => {
    const { container } = render(<NodeCard node={node} econ={econ} />);
    expect(container.textContent).not.toContain('container');
  });

  it('renders a node card for one that did not', () => {
    const { container } = render(
      <NodeCard node={{ hostname: 'asleep', reachable: false, error: 'Connection timed out' }}
                sshHost={{ name: 'asleep', user: 'fox', port: '2222' }} econ={econ} />,
    );
    expect(container.textContent).toContain('timed out');
  });

  it('renders a node that has not been probed at all', () => {
    expect(() => render(<NodeCard node={undefined} sshHost={{ name: 'new' }} econ={econ} />)).not.toThrow();
  });

  it('charts the fleet', () => {
    expect(() => render(<FleetMetricsChart blendedKwhRate={0.31} />)).not.toThrow();
  });

  it('shows how much of the fleet draw is GPU', () => {
    // 1202W total of which 700W GPU in the fixture timeline.
    const { container } = render(<FleetMetricsChart blendedKwhRate={0.31} />);
    expect(container.textContent).toContain('1202W now · 700W gpu');
  });

  it('prices electricity per hour at the blended rate', () => {
    // 1.202 kW × $0.31 = $0.37/hr
    const { container } = render(<FleetMetricsChart blendedKwhRate={0.31} />);
    expect(container.textContent).toContain('$0.37/hr now');
  });

  it('still prices electricity when no node has reported watts yet', () => {
    // A blended rate of 0 means "nobody answered", not "power is free".
    const { container } = render(<FleetMetricsChart blendedKwhRate={0} />);
    expect(container.textContent).toContain('/hr now');
    expect(container.textContent).not.toContain('$0/hr now');
  });

  it('breaks the all-in monthly cost down by provider', () => {
    // 153W × 720h × $0.31/kWh = $34 electricity, plus $110 ISP = $144. The
    // provider row must carry the same $144 as the headline, with the split.
    const nodes = [{ key: 'cammy', hostname: 'cammy', econ, meshNode: node }];
    const { container } = render(
      <MeshEconomicsPanel allNodes={nodes} meshNodes={[node]}
                          getNodeEcon={() => econ} geoipNodes={[]} />,
    );
    expect(container.textContent).toContain('$34 elec + $110 isp');
    const row = container.querySelector('[title="$34 elec + $110 isp"]')!;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain('Home ISP');
    expect(row.textContent).toContain('$144/mo');
  });

  it('prices the mesh without charting it', () => {
    // Charts moved below the node grid; the economics card is headline
    // numbers only so it stays above the fold.
    const nodes = [{ key: 'cammy', hostname: 'cammy', econ, meshNode: node }];
    const { container } = render(
      <MeshEconomicsPanel allNodes={nodes} meshNodes={[node]}
                          getNodeEcon={() => econ} geoipNodes={[]} />,
    );
    expect(container.textContent).toContain('Mesh Economics');
    expect(container.textContent).not.toContain('Fleet Metrics');
  });

  it('charts the fleet in its own card', () => {
    const nodes = [{ key: 'cammy', hostname: 'cammy', econ, meshNode: node }];
    const { container } = render(
      <FleetMetricsPanel allNodes={nodes} meshNodes={[node]}
                         getNodeEcon={() => econ} geoipNodes={[]} />,
    );
    expect(container.textContent).toContain('Fleet Metrics');
  });

  it('renders the add-node control', () => {
    expect(() => render(
      <AddNodeButton hosts={[]} keys={['~/.ssh/id_ed25519']} configHash="abc"
                     mutate={vi.fn()} seedEcon={vi.fn()} settings={{}} />,
    )).not.toThrow();
  });

  it('leaves the controls on each panel pressable', () => {
    const { container } = render(
      <NodeCard node={node} sshHost={{ name: 'cammy' }} econ={econ} onHide={vi.fn()} />,
    );
    for (const b of container.querySelectorAll('button')) act(() => { (b as HTMLElement).click(); });
    expect(true).toBe(true);
  });
});
