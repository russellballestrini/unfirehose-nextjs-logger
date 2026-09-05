// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import { HarnessPicker } from './HarnessPicker';
import { harnessesFor } from '@/lib/harnesses';

/**
 * The grid two pages use to install a harness.
 *
 * A machine we ssh to and an unsandbox container both drew this
 * themselves, in the same sixty lines twice, which is how they came to
 * disagree about which tags a card shows. It is one component now, and
 * what the pages still choose is only the line above the grid.
 */

const harnesses = harnessesFor('node');
afterEach(cleanup);

const show = (over: Record<string, unknown> = {}) => {
  const onBoot = vi.fn();
  const setFilter = vi.fn();
  const view = render(
    <HarnessPicker
      harnesses={harnesses}
      filter="" setFilter={setFilter}
      statuses={{}} onBoot={onBoot}
      header={<span>target: cammy</span>}
      {...over as never}
    />,
  );
  return { ...view, onBoot, setFilter };
};
const button = (re: RegExp) =>
  [...document.querySelectorAll('button')].filter(b => re.test(b.textContent ?? ''));

describe('HarnessPicker', () => {
  it('shows every harness with what installing it will run', () => {
    // The install line is the whole contract: it is a shell command that
    // will run on somebody's machine.
    const { container } = show();
    expect(container.textContent).toContain('Claude Code');
    expect(container.textContent).toContain('curl -fsSL https://claude.ai/install.sh');
  });

  it('says which key a harness will want before anyone installs it', () => {
    // Otherwise it installs, starts, and fails at the first request.
    expect(show().container.textContent).toContain('requires:');
  });

  it('filters by name', () => {
    const { container } = show({ filter: 'aider' });
    expect(container.textContent).toContain('Aider');
    expect(container.textContent).not.toContain('Claude Code');
  });

  it('filters by tag, since people search for what a thing is', () => {
    const { container } = show({ filter: 'gpu' });
    expect(container.textContent).toContain('vLLM');
    expect(container.textContent).not.toContain('Aider');
  });

  it('ignores case and surrounding space in a filter', () => {
    expect(show({ filter: '  AIDER ' }).container.textContent).toContain('Aider');
  });

  it('shows nothing rather than everything for a filter that matches none', () => {
    expect(show({ filter: 'zzzz' }).container.querySelectorAll('button')).toHaveLength(0);
  });

  it('reports what was typed rather than filtering itself', () => {
    // The pages keep this in their own state so it survives a tab change.
    const { setFilter, container } = show();
    fireEvent.change(container.querySelector('input')!, { target: { value: 'vllm' } });
    expect(setFilter).toHaveBeenCalledWith('vllm');
  });

  it('installs the harness whose button was pressed', () => {
    // Every card shares one handler; the wrong one installs something
    // nobody asked for on a machine they were not looking at.
    const { onBoot } = show({ filter: 'aider' });
    act(() => { button(/Verify & Install/)[0].click(); });
    expect(onBoot).toHaveBeenCalledTimes(1);
    expect(onBoot.mock.calls[0][0].id).toBe('aider');
  });

  it('will not install one already in flight', () => {
    const { container } = show({ filter: 'aider', statuses: { aider: { state: 'verifying' } } });
    expect((container.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain('Verifying');
  });

  it('offers to re-verify one already installed, and shows its version', () => {
    const { container } = show({
      filter: 'aider', statuses: { aider: { state: 'success', version: 'aider 0.60.1' } },
    });
    expect(container.textContent).toContain('Re-verify');
    expect(container.textContent).toContain('aider 0.60.1');
  });

  it('shows why one failed, next to the harness that failed', () => {
    const { container } = show({
      filter: 'aider', statuses: { aider: { state: 'error', detail: 'pip: command not found' } },
    });
    expect(container.textContent).toContain('pip: command not found');
  });

  it('leaves the footer to the page, which knows what the target is', () => {
    // An ssh node keeps its credentials; an unsandbox container
    // self-destructs. Same grid, different consequence.
    expect(show({ footer: 'The container self-destructs after verification.' })
      .container.textContent).toContain('self-destructs');
  });

  it('draws with no footer at all', () => {
    expect(show().container.textContent).not.toContain('undefined');
  });
});
