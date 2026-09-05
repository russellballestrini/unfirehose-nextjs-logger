// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import {
  MeshSummaryBar, NodeCard, UnsandboxProbeBody, UnsandboxServiceBody,
  UnsandboxNodeCard, FleetMetricsChart, MeshEconomicsPanel, UnsandboxPanel, AddNodeButton,
} from './page';

/**
 * The panels the mesh page is made of.
 *
 * Each needs a fleet behind it — nodes that answer, an unsandbox account, a
 * timeline of snapshots — so none of them rendered under a page test against
 * an empty machine.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }), useParams: () => ({}),
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

const status = { connected: true, tier: 13, rateLimit: 91, maxSessions: 4, burst: 91 };

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

  it('shows what a cloud container reported', () => {
    const { container } = render(
      <UnsandboxProbeBody status={status} probe={{
        cpuCores: 4, memTotalGB: 8, memUsedGB: 2, loadAvg: [0.2, 0.1, 0.1],
        uptime: '3h', cpuModel: 'AMD EPYC', gpuModel: 'NVIDIA L4', gpuMemTotalMB: 24576,
        gpuPowerWatts: 40, swapUsedGB: 0,
      }} />,
    );
    expect(container.textContent).toContain('L4');
  });

  it('shows a deployed service that has not answered a probe', () => {
    const { container } = render(
      <UnsandboxServiceBody status={status} running
        service={{ name: 'unfirehose', status: 'running', domain: 'demo.unsandbox.com' }} />,
    );
    expect(container.textContent).toContain('unfirehose');
  });

  it('renders the cloud card in each of its three states', () => {
    for (const props of [
      { status },
      { status, service: { name: 'unfirehose', status: 'running' } },
      { status: { ...status, connected: false } },
    ]) {
      const { unmount } = render(<UnsandboxNodeCard {...props as never} />);
      unmount();
    }
    expect(true).toBe(true);
  });

  it('charts the fleet', () => {
    expect(() => render(<FleetMetricsChart blendedKwhRate={0.31} />)).not.toThrow();
  });

  it('prices the mesh', () => {
    const nodes = [{ hostname: 'cammy', econ, meshNode: node }];
    expect(() => render(
      <MeshEconomicsPanel allNodes={nodes} meshNodes={[node]}
                          getNodeEcon={() => econ} geoipNodes={[]} />,
    )).not.toThrow();
  });

  it('renders the unsandbox panel and the add-node control', () => {
    expect(() => render(<UnsandboxPanel />)).not.toThrow();
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
