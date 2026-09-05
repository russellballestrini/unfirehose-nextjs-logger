// @vitest-environment jsdom
/// <reference types="vite/client" />
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

/**
 * Every shared component mounts, with nothing and with something.
 *
 * These are reached today only through whichever page happens to use them,
 * so a component used on one rarely-opened screen has never been rendered by
 * anything.
 *
 * Each is mounted with one broad bag of plausible props. Mounting them bare
 * as well was the first idea and it was wrong: a required prop is enforced by
 * its type at every call site, so a component throwing without one is
 * TypeScript working, not a defect.
 */

const PAYLOAD = Object.assign([] as unknown[], {
  rows: [], items: [], data: [], todos: [], nodes: [], series: [], entries: [],
  labels: [], values: [], columns: [], temps: [], fans: [], gpus: [],
  stats: {}, totals: {}, summary: {}, project: { displayName: 'demo' },
  value: 0, pct: 50, label: 'demo', title: 'demo', name: 'demo', host: 'localhost',
  count: 0, total: 0, max: 100, min: 0, loading: false, error: null,
  // A discriminated union a component switches on. Anything keyed by
  // `kind` needs a real one; undefined is not a state it can be in.
  state: { kind: 'idle' },
});
// `labels` above is an array, which is the right shape for the components
// that chart. The ones that key labels by state want a record, and both
// live on the same bag.
Object.assign(PAYLOAD.labels, { idle: 'do it', pending: 'doing', done: 'done', error: 'failed' });

vi.mock('swr', () => ({
  default: () => ({ data: PAYLOAD, error: undefined, isLoading: false, mutate: vi.fn() }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
  mutate: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

// Canvas charts measure themselves; jsdom can neither draw nor size them.
vi.mock('@/components/UPlotTimeChart', () => ({
  UPlotTimeChart: () => null, default: () => null,
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (q: string) => ({
      matches: false, media: q, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }),
  });
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  Element.prototype.scrollIntoView ??= vi.fn() as never;
  global.fetch = vi.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => PAYLOAD, text: async () => '',
  }) as never;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1024 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 768 });
});

afterEach(cleanup);

const modules = import.meta.glob('./*.tsx');

/** Props broad enough that a component finds whatever it reads. */
const PROPS = {
  ...PAYLOAD,
  // A card needs a card's worth of todo; KanbanCard is exported so its own
  // suite can reach it, and this harness mounts everything a module exports.
  todo: {
    id: 1, uuid: null, content: 'a task', status: 'pending', activeForm: null,
    source: 'claude', externalId: null, blockedBy: [], sessionUuid: null,
    sessionDisplay: null, projectName: 'demo', createdAt: '2026-09-04T12:00:00.000Z',
    updatedAt: '2026-09-04T12:00:00.000Z', completedAt: null, estimatedMinutes: null,
    tmuxSession: null, deployment: null, attachments: [],
  },
  meshNodes: [], onUpdate: vi.fn(), onDelete: vi.fn(), onBoot: vi.fn(),
  onDragStart: vi.fn(), onDragEnd: vi.fn(), booting: null, bootResult: null,
  isDragging: false, landed: false, projectPath: null,
  onClose: vi.fn(), onSave: vi.fn(), onChange: vi.fn(), onSelect: vi.fn(),
  onRun: vi.fn(), onHide: vi.fn(), mutate: vi.fn(), setValue: vi.fn(),
  children: null,
  // HarnessPicker takes a filter string and a catalogue. Its own suite
  // covers the grid; this one only proves the module mounts, and a
  // component whose type says `filter: string` should not have to defend
  // against not being given one.
  harnesses: [], filter: '', setFilter: vi.fn(), statuses: {}, header: null,
} as never;

describe('every shared component mounts', () => {
  it('finds them, so this cannot quietly cover nothing', () => {
    expect(Object.keys(modules).length).toBeGreaterThan(3);
  });

  for (const [path, load] of Object.entries(modules)) {
    if (path.includes('.test.')) continue;

    it(`mounts ${path.replace('./', '')}`, async () => {
      const mod = (await load()) as Record<string, unknown>;
      const exported = Object.entries(mod).filter(
        ([, v]) => typeof v === 'function' && /^[A-Z]/.test((v as { name?: string }).name ?? ''),
      );

      for (const [, Component] of exported) {
        const C = Component as (p: never) => React.ReactNode;
        act(() => { render(<C {...PROPS} />); });
        cleanup();
      }
      expect(true).toBe(true);
    });
  }
});
