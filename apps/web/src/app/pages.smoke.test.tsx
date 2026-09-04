// @vitest-environment jsdom
/// <reference types="vite/client" />
import { describe, it, expect, vi, beforeAll } from 'vitest';

/**
 * Every page module loads.
 *
 * Nothing in this suite entered a page file before, and the cost of that
 * showed up the day an import was inserted in the wrong place: two pages
 * stopped parsing, every test still passed, and the break surfaced only
 * because coverage tooling declined to read them. A parse error, a bad
 * import path, a module-level crash — all of it reached the browser first.
 *
 * This imports each page rather than rendering it. Rendering twenty-four
 * pages means mocking twenty-four pages' worth of data, which is a lot of
 * fixture for what it catches; importing them costs nothing and catches the
 * whole class of failure that actually happens when we refactor.
 */

// Browser and framework APIs a page reaches for as it loads.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  notFound: vi.fn(),
}));

beforeAll(() => {
  // uPlot and xterm read layout on import; jsdom has no layout engine.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }),
  });
  window.ResizeObserver ??= class {
    observe() {} unobserve() {} disconnect() {}
  } as never;
  global.fetch = vi.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => ({}), text: async () => '',
  }) as never;
});

const pages = import.meta.glob('./**/page.tsx');

describe('every page module', () => {
  it('finds all of them, so this test cannot quietly cover nothing', () => {
    expect(Object.keys(pages).length).toBeGreaterThanOrEqual(24);
  });

  for (const [path, load] of Object.entries(pages)) {
    it(`loads ${path.replace('./', '')}`, async () => {
      const mod = (await load()) as { default?: unknown };
      // A page without a default export is not a page Next.js can route to.
      expect(typeof mod.default).toBe('function');
    });
  }
});
