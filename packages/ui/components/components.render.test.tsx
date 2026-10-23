/// <reference types="vite/client" />
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

/**
 * Every shared component in this package mounts.
 *
 * They are published, so their callers are other repositories as well as
 * this one — and several had never been rendered by anything here. Each is
 * mounted with one broad bag of props, then every control on it is pressed.
 *
 * This is not a claim that any of them looks right. It is the claim that
 * mounting one and clicking it does not throw, which is the failure a
 * consumer would see as a blank panel.
 */

vi.mock('swr', () => ({
  default: () => ({ data: undefined, error: undefined, isLoading: false, mutate: vi.fn() }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
  mutate: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({}), usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  Element.prototype.scrollIntoView ??= vi.fn() as never;
  global.fetch = vi.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => ({}), text: async () => '',
  }) as never;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1024 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 400 });
});

afterEach(cleanup);

const modules = import.meta.glob('./**/*.tsx', { eager: false }) as Record<string, () => Promise<unknown>>;

/** Broad enough that a component finds whatever it reads. */
const PROPS = {
  // `value` is a number in a gauge and a string in a stat, and one bag has
  // to satisfy both — a number renders either way, a string does not.
  label: 'demo', value: 42, sub: 'a caption', pct: 50, max: 100,
  tokens: { input: 100, output: 50, cacheRead: 800, cacheWrite: 50 },
  metrics: {}, summary: 'a summary', pageType: 'demo',
  harness: 'claude-code', setHarness: vi.fn(), model: '', setModel: vi.fn(),
  harnessModels: { 'claude-code': ['opus', 'sonnet'] },
  customCmd: '', setCustomCmd: vi.fn(),
  session: { sessionId: 's1', displayName: 'session one', messageCount: 3 },
  entry: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  block: { type: 'text', text: 'hi' },
  items: [], rows: [], entries: [], children: null,
  onChange: vi.fn(), onSelect: vi.fn(), onClose: vi.fn(), onSave: vi.fn(),
} as Record<string, unknown>;

// What a mount does is fixed; how long it takes is not. Mounting a module
// and pressing every button it renders is 0.1 s for most and 2.8 s for
// TokenSplit on an idle four-core box, and TokenSplit took 67 s, past this
// config's 60 s, with every suite running at once beside 24 busy processes
// on two cores (2026-10-23). Each mount gets a deadline sized for that box,
// with room to spare; one that hangs still fails.
const MOUNT_DEADLINE_MS = 180_000;

describe('every published component mounts', () => {
  it('finds them, so this cannot quietly cover nothing', () => {
    expect(Object.keys(modules).length).toBeGreaterThan(10);
  });

  for (const [path, load] of Object.entries(modules)) {
    if (path.includes('.test.')) continue;

    it(`mounts ${path.replace('./', '')}`, async () => {
      const mod = (await load()) as Record<string, unknown>;
      const components = Object.entries(mod).filter(
        ([name, v]) => typeof v === 'function' && /^[A-Z]/.test(name),
      );

      for (const [, Component] of components) {
        const C = Component as React.ComponentType<Record<string, unknown>>;
        const { container, unmount } = render(<C {...PROPS} />);
        for (const b of container.querySelectorAll('button')) {
          act(() => { (b as HTMLElement).click(); });
        }
        unmount();
      }
      expect(true).toBe(true);
    }, MOUNT_DEADLINE_MS);
  }
});
