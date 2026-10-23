// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createTestDb } from '@unturf/unfirehose/test/db-helper';

/**
 * Pages rendered from payloads our demo seed built.
 *
 * render.smoke.test.tsx hands every page one hand-written fixture. This one
 * seeds an in-memory database with seedDemo, builds the stored payloads
 * through the same refresh functions the worker runs, and feeds those to the
 * dashboard, tokens and projects pages. A builder that changes shape without
 * its page following shows up here as a throw or a missing row, which a
 * fixture written to match the page can never show.
 */

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));
// The project list also walks ~/.claude/projects; the seed is the whole
// fixture, so the disk side is empty.
vi.mock('@unturf/unfirehose/claude-paths', async (importOriginal) => {
  const real = await importOriginal<typeof import('@unturf/unfirehose/claude-paths')>();
  return { ...real, claudePaths: { ...real.claudePaths, projects: '/nonexistent/claude-projects' } };
});
// An empty price book would start a background sync with public feeds.
vi.mock('@unturf/unfirehose/pricing-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@unturf/unfirehose/pricing-sync')>()),
  ensurePricingHydrated: () => {},
}));

/** URL prefix -> what that route would serve. Anything else is still loading. */
const served: Record<string, unknown> = {};
vi.mock('swr', () => {
  const useSWR = (key: string | null) => {
    const hit = typeof key === 'string'
      ? Object.entries(served).find(([prefix]) => key.startsWith(prefix))
      : undefined;
    return { data: hit?.[1], error: undefined, isLoading: !hit, isValidating: false, mutate: vi.fn() };
  };
  return { default: useSWR, useSWRConfig: () => ({ mutate: vi.fn() }), mutate: vi.fn() };
});
vi.mock('@/components/UPlotTimeChart', () => ({ UPlotTimeChart: () => null, default: () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  notFound: vi.fn(),
}));

let dashboard: any;
let tokens: any;
let projects: any[];

beforeAll(async () => {
  const { seedDemo, buildDemoPayloads } = await import('@unturf/unfirehose/demo-seed');
  const { readDashboard } = await import('@unturf/unfirehose/dashboard');
  const { readTokensPayload } = await import('@unturf/unfirehose/tokens');
  const { readProjectList } = await import('@unturf/unfirehose/projects-list');
  seedDemo(db);
  await buildDemoPayloads();
  dashboard = readDashboard('7d', Infinity)!.payload;
  tokens = readTokensPayload('7d', Infinity)!.payload;
  projects = readProjectList(Infinity)!.payload;
  served['/api/dashboard'] = dashboard;
  served['/api/tokens'] = tokens;
  served['/api/projects'] = projects;

  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  window.scrollTo ??= vi.fn() as never;
  global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}), text: async () => '' }) as never;
});

afterEach(cleanup);

describe('the demo seed builds payloads a page can show', () => {
  it('builds non-empty dashboard, tokens and projects payloads', () => {
    expect(dashboard.summary.sessions).toBeGreaterThan(0);
    expect(dashboard.summary.totalCost).toBe(0);
    expect(dashboard.modelBreakdown.length).toBeGreaterThan(0);
    expect(JSON.stringify(tokens)).toContain('demo-model');
    expect(projects).toHaveLength(2);
  });

  it('renders the dashboard with the demo models in it', async () => {
    const { default: Page } = await import('./page');
    const { container } = render(<Page />);
    expect(container.textContent).toContain('demo-model');
  });

  it('renders the tokens page with the demo models in it', async () => {
    const { default: Page } = await import('./tokens/page');
    const { container } = render(<Page />);
    expect(container.textContent).toContain('demo-model');
  });

  it('renders both demo projects', async () => {
    const { default: Page } = await import('./projects/page');
    const { container } = render(<Page />);
    expect(container.textContent).toContain('demo-api');
    expect(container.textContent).toContain('demo-web');
  });
});
