// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { UnsandboxProbeBody, UnsandboxServiceBody, UnsandboxNodeCard } from './NodeCard';
import { UnsandboxPanel } from './MeshPanel';

/**
 * The cloud account as a node card on the mesh page, and its keys panel.
 * Moved here from app/permacomputer/panels.test.tsx with the components.
 */

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: vi.fn() })), useParams: () => ({}),
  usePathname: () => '/permacomputer', useSearchParams: () => new URLSearchParams(),
}));

vi.mock('swr', () => ({
  default: () => ({ data: undefined, error: undefined, isLoading: false, mutate: vi.fn() }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
  mutate: vi.fn(),
}));

afterEach(cleanup);

const status = { connected: true, tier: 13, rateLimit: 91, maxSessions: 4, burst: 91 };

describe('unsandbox on the mesh page', () => {
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
      const { unmount } = render(<UnsandboxNodeCard {...(props as React.ComponentProps<typeof UnsandboxNodeCard>)} />);
      unmount();
    }
    expect(true).toBe(true);
  });

  it('renders the keys panel', () => {
    expect(() => render(<UnsandboxPanel />)).not.toThrow();
  });
});
