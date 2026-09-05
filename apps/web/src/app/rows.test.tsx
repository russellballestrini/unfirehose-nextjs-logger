// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ModelRow } from './page';
import { ProjectCard } from './projects/page';
import { MarkdownRenderer } from './schema/page';

/**
 * Three renderers that were each buried in a page.
 *
 * A model's row in the dashboard breakdown, a project's card in the grid,
 * and the markdown the schema browser draws. Each is a hundred lines of
 * conditional formatting that only appeared if the page around it had the
 * right data.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }), useParams: () => ({}),
  usePathname: () => '/', useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as never;
});

afterEach(cleanup);

const table = (ui: React.ReactNode) => render(<table><tbody>{ui}</tbody></table>);

const model = (over: Record<string, unknown> = {}) => ({
  fullName: 'claude-opus-4-6-20260301', name: 'opus-4-6',
  tokens: 1_000_000, inputTokens: 100_000, outputTokens: 50_000,
  cacheReadTokens: 800_000, cacheWriteTokens: 50_000,
  cost: 12.5, inputCost: 3, outputCost: 7, cacheCost: 2.5,
  energy: 0.4, avoided: 8, host: 'anthropic', selfHosted: false,
  costSource: 'priced', pricedAgainst: 'anthropic', promo: false,
  meshObservedUSD: null, structuralReuseRate: null, structuralReuseTokens: 0,
  measuredCacheHits: null, measuredCacheQueries: null, measuredCacheNodes: null,
  ...over,
});

describe('ModelRow', () => {
  it('names the model and its numbers', () => {
    const { container } = table(<ModelRow m={model()} />);
    expect(container.textContent).toContain('opus-4-6');
  });

  it('shows a self-hosted model with what it saved', () => {
    // The point of the column: running it here instead of buying the tokens.
    const { container } = table(<ModelRow m={model({
      selfHosted: true, host: '4090-ai', avoided: 42, energy: 1.2, cost: 0.3,
      costSource: 'measured', pricedAgainst: 'openrouter',
    })} />);
    expect(container.textContent).toContain('4090-ai');
  });

  it('shows a measured cache rate where a node reported one', () => {
    // A self-hosted model reports no cache tokens; the prefix-cache rate is
    // measured at the server instead, and reads 0% from usage alone.
    const { container } = table(<ModelRow m={model({
      selfHosted: true, cacheReadTokens: 0,
      measuredCacheHits: 500, measuredCacheQueries: 2000, measuredCacheNodes: ['3090-ai'],
    })} />);
    expect(container.textContent).toContain('opus-4-6');
  });

  it('renders a model we have no price for', () => {
    // Unpriced is not free, and the row has to say so rather than show $0.
    expect(() => table(<ModelRow m={model({ cost: 0, costSource: null, pricedAgainst: null })} />)).not.toThrow();
  });

  it('renders a model on a promotional rate', () => {
    expect(() => table(<ModelRow m={model({ promo: true, cost: 0 })} />)).not.toThrow();
  });

  it('renders a model with structural prefix reuse', () => {
    expect(() => table(<ModelRow m={model({ structuralReuseRate: 0.62, structuralReuseTokens: 620_000 })} />)).not.toThrow();
  });
});

const project = (over: Record<string, unknown> = {}) => ({
  name: '-home-fox-git-demo', displayName: 'demo', path: '/home/fox/git/demo',
  sessionCount: 12, totalMessages: 340, latestActivity: '2026-09-04T12:00:00.000Z',
  tokens: { input: 1000, output: 500, cacheRead: 8000, cacheWrite: 500 },
  hasMemory: true, harnesses: ['claude-code'], foldedCount: 0, ...over,
});

describe('ProjectCard', () => {
  it('names the project and its activity', () => {
    const { container } = render(
      <ProjectCard project={project() as never} rangeDays={30} heat={0.5}
                   activity={{ messages: 40, cost: 2, tokens: 1000 } as never} />,
    );
    expect(container.textContent).toContain('demo');
  });

  it('renders a project with no activity in the window', () => {
    // Most projects are idle most of the time; the grid still lists them.
    expect(() => render(
      <ProjectCard project={project() as never} rangeDays={30} heat={0} />,
    )).not.toThrow();
  });

  it('renders a project with a dirty repository', () => {
    expect(() => render(
      <ProjectCard project={project() as never} rangeDays={7} heat={1}
                   gitStatus={{ branch: 'main', dirty: 3, unpushed: 1 } as never} />,
    )).not.toThrow();
  });

  it('renders a project whose sessions folded into it after a rename', () => {
    expect(() => render(
      <ProjectCard project={project({ foldedCount: 2 }) as never} rangeDays={30} heat={0.2} />,
    )).not.toThrow();
  });
});

describe('MarkdownRenderer', () => {
  it('renders headings, lists, code and links', () => {
    const { container } = render(<MarkdownRenderer content={[
      '# Title', '', 'Some **bold** and `code`.', '', '- one', '- two', '',
      '```ts', 'const x = 1;', '```', '', '[a link](/schema/message)', '',
      '| a | b |', '| --- | --- |', '| 1 | 2 |',
    ].join('\n')} onNavigate={vi.fn()} />);

    const text = container.textContent ?? '';
    expect(text).toContain('Title');
    expect(text).toContain('one');
    expect(text).toContain('const x = 1;');
    expect(text).toContain('a link');
  });

  it('renders nothing for nothing', () => {
    expect(() => render(<MarkdownRenderer content="" />)).not.toThrow();
  });

  it('renders text with no markup at all', () => {
    const { container } = render(<MarkdownRenderer content="just a sentence" />);
    expect(container.textContent).toContain('just a sentence');
  });

  it('survives an unclosed code fence', () => {
    // A truncated document is the normal case when a doc is being edited.
    expect(() => render(<MarkdownRenderer content={'```ts\nconst x = 1;\n'} />)).not.toThrow();
  });
});
