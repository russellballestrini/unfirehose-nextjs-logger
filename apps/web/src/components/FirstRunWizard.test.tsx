// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

/**
 * The first run: what a person sees before anything is ingested, while it
 * is, and the moment it hands over. Every state comes from /api/onboarding,
 * so each test is one answer from it.
 */

let answer: Record<string, unknown> | undefined;
vi.mock('swr', () => ({
  default: () => ({ data: answer, error: undefined, isLoading: !answer, mutate: vi.fn() }),
}));

const { FirstRunWizard, wizardStage } = await import('./FirstRunWizard');

const harness = (id: string, over: Record<string, unknown> = {}) => ({
  id, label: id, root: `/home/fox/.${id}`, doc: `harnesses/${id}.md`,
  found: false, readable: false, files: 0, newestMs: null, truncated: false, sessions: 0, lastMessageAt: null,
  ...(id === 'claude-code' ? { start: 'cd ~/your/repo && claude' } : {}),
  ...over,
});
const state = (over: Record<string, unknown> = {}) => ({
  harnesses: [harness('claude-code'), harness('fetch'), harness('uncloseai'), harness('agnt')],
  sessions: 0, projects: 0, messages: 0, lastIngestAt: null, payloadAt: null, workerAlive: false,
  ...over,
});

afterEach(() => { cleanup(); answer = undefined; });

describe('FirstRunWizard', () => {
  it('says it is looking before the first answer', () => {
    const { container } = render(<FirstRunWizard />);
    expect(container.querySelector('[data-stage]')!.getAttribute('data-stage')).toBe('loading');
    expect(container.textContent).toContain('Looking…');
  });

  it('on a machine with no harness: every harness not found, the one command, and the adapter docs', () => {
    answer = state();
    const { container } = render(<FirstRunWizard />);
    expect(container.querySelector('[data-stage]')!.getAttribute('data-stage')).toBe('no-harness');
    expect([...container.querySelectorAll('[data-harness]')].map((e) => e.getAttribute('data-found'))).toEqual(['no', 'no', 'no', 'no']);
    expect(container.querySelector('pre')!.textContent).toBe('cd ~/your/repo && claude');
    expect(container.querySelector('a[href^="/schema?doc="]')).not.toBeNull();
  });

  it('detecting: a harness on disk with its files and newest age, and a worker that has not reported', () => {
    answer = state({ harnesses: [harness('claude-code', { found: true, readable: true, files: 42, newestMs: Date.now() - 3 * 3600_000 })] });
    const { container } = render(<FirstRunWizard />);
    expect(container.querySelector('[data-stage]')!.getAttribute('data-stage')).toBe('waiting-worker');
    expect(container.querySelector('[data-harness="claude-code"]')!.textContent).toContain('42 session files, newest 3 hours ago');
    expect(container.querySelector('[data-worker]')!.getAttribute('data-worker')).toBe('down');
    expect(container.textContent).toContain('make dev');
  });

  it('ingesting: the worker is alive and the counts are the ones it has read so far', () => {
    answer = state({
      harnesses: [harness('claude-code', { found: true, readable: true, files: 42 })],
      workerAlive: true, lastIngestAt: new Date(Date.now() - 30_000).toISOString(), messages: 1234, projects: 2,
    });
    const { container } = render(<FirstRunWizard />);
    expect(container.querySelector('[data-stage]')!.getAttribute('data-stage')).toBe('ingesting');
    expect(container.querySelector('[data-count="messages"]')!.textContent).toBe('1,234');
    expect(container.textContent).toContain('last pass 30 seconds ago');
    expect(container.querySelector('[data-step="2"]')!.getAttribute('data-state')).toBe('active');
  });

  it('done: hands off to the dashboard once, when the first session lands', () => {
    const onDone = vi.fn();
    answer = state({ harnesses: [harness('claude-code', { found: true, readable: true, files: 1 })], workerAlive: true, sessions: 1 });
    const { container, rerender } = render(<FirstRunWizard onDone={onDone} />);
    expect(container.querySelector('[data-stage]')!.getAttribute('data-stage')).toBe('done');
    rerender(<FirstRunWizard onDone={onDone} />);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('flags a harness it found but cannot read', () => {
    answer = state({ harnesses: [harness('fetch', { found: true, readable: false })] });
    expect(render(<FirstRunWizard />).container.textContent).toContain('found, but this process cannot read it');
  });

  it('classifies an answer without rendering', () => {
    expect(wizardStage(undefined)).toBe('loading');
    expect(wizardStage(state({ sessions: 3 }))).toBe('done');
  });
});
