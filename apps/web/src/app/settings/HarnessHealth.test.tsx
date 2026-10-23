// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

let answer: Record<string, unknown> | undefined;
vi.mock('swr', () => ({ default: () => ({ data: answer, error: undefined }) }));
const { HarnessHealth } = await import('./HarnessHealth');

const h = (id: string, over: Record<string, unknown>) => ({
  id, label: id, root: `/home/fox/.${id}`, doc: `harnesses/${id}.md`,
  found: false, readable: false, files: 0, newestMs: null, truncated: false, sessions: 0, lastMessageAt: null, ...over,
});

afterEach(() => { cleanup(); answer = undefined; });

describe('HarnessHealth', () => {
  it('gives each harness its path, disk state, rows and last message, and says how to fix the broken ones', () => {
    answer = {
      workerAlive: true, lastIngestAt: new Date(Date.now() - 60_000).toISOString(),
      harnesses: [
        h('claude-code', { found: true, readable: true, files: 12, sessions: 9, lastMessageAt: new Date(Date.now() - 120_000).toISOString(), start: 'cd ~/your/repo && claude' }),
        h('fetch', { found: true, readable: false }),
        h('agnt', {}),
        h('orcestra', { found: true, readable: true, files: 2 }),
      ],
    };
    const { container } = render(<HarnessHealth />);
    const card = (id: string) => container.querySelector(`[data-harness="${id}"]`)!;
    expect([...container.querySelectorAll('[data-status]')].map((e) => e.getAttribute('data-status')))
      .toEqual(['ingesting', 'unreadable', 'missing', 'found']);
    expect(card('claude-code').textContent).toContain('12 session files');
    expect(card('claude-code').textContent).toContain('9 sessions');
    expect(card('claude-code').textContent).toContain('2 minutes ago');
    expect(card('fetch').textContent).toContain('chmod -R u+rX /home/fox/.fetch');
    expect(card('agnt').querySelector('a')!.getAttribute('href')).toBe('/schema?doc=harnesses%2Fagnt.md');
    expect(card('orcestra').textContent).toContain('picks it up on its next pass');
    expect(container.textContent).toContain('last pass 1 minute ago');
  });

  it('says when our worker has not reported', () => {
    answer = { workerAlive: false, harnesses: [] };
    expect(render(<HarnessHealth />).container.textContent).toContain('make doctor');
  });
});
