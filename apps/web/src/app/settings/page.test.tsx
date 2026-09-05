// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';

/**
 * Settings, which is a page of writes.
 *
 * Nothing here reports; every control changes something the rest of the
 * dashboard reads. The save is optimistic — it merges into the SWR cache
 * without revalidating, deliberately, so a text input does not reset out
 * from under someone mid-type — which means a save that never reached the
 * server looks exactly like one that did.
 *
 * The vault is mocked as unlocked. No key material is real.
 */

let settings: Record<string, string>;
vi.mock('swr', () => {
  const useSWR = (key: string) => ({
    data: key?.startsWith('/api/settings') ? settings
      : key?.startsWith('/api/llm/providers') ? { providers: [
          { id: 'claude-max', name: 'Claude Max', source: 'filesystem', ready: true },
          { id: 'qwen-mesh', name: 'Qwen on our mesh', source: 'mesh', ready: true },
        ] }
      : undefined,
    error: undefined, isLoading: false, mutate: vi.fn(),
  });
  return { default: useSWR, useSWRConfig: () => ({ mutate: vi.fn() }), mutate: vi.fn() };
});

const vaultKeys: Record<string, string> = {};
const preferred: string[] = [];
vi.mock('@unturf/unfirehose-ui/VaultProvider', () => ({
  useVault: () => ({
    ready: true, unlocked: true, exists: true, data: {},
    getKey: (id: string) => vaultKeys[id] ?? '',
    setKey: (id: string, v: string) => { vaultKeys[id] = v; },
    removeKey: (id: string) => { delete vaultKeys[id]; },
    setPreferred: (id: string) => { preferred.push(id); },
    lock: vi.fn(), unlock: vi.fn(),
  }),
  VaultProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/settings', useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/UPlotTimeChart', () => ({ UPlotTimeChart: () => null, default: () => null }));

const SettingsPage = (await import('./page')).default;

/** Every setting written, as [key, value] in order. */
const saved = () => (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
  .filter(([url]) => String(url) === '/api/settings')
  .map(([, init]) => JSON.parse((init as { body: string }).body))
  .filter(b => b.action === 'set')
  .map(b => [b.key, b.value] as [string, string]);

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  window.matchMedia ??= ((q: string) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {},
  })) as never;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1024 });
});

beforeEach(() => {
  settings = {
    unfirehose_display_name: 'fox', theme_accent_color: '#d40000',
    llm_commit_endpoint: '', llm_commit_model: '', display_currency: 'USD',
  };
  vaultKeys.openai = ''; preferred.length = 0;
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' })) as never;
});
afterEach(cleanup);

const show = async () => {
  const view = render(<SettingsPage />);
  await act(async () => { await Promise.resolve(); });
  return view;
};

const tab = async (name: string) => {
  const el = [...document.querySelectorAll('button')].find(b => b.textContent?.trim().endsWith(name));
  await act(async () => { el!.click(); });
};

const byText = (s: string) =>
  [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === s);

describe('settings', () => {
  it('opens on General with the values it was given', async () => {
    await show();
    expect(screen.getByDisplayValue('fox')).toBeInTheDocument();
  });

  it('writes a setting through the same action for every control', async () => {
    // One action name, one route. A second shape here is a second thing to
    // keep in step with the reader.
    await show();
    const input = screen.getByDisplayValue('fox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'russell' } });
    fireEvent.blur(input);
    await waitFor(() => expect(saved()).toContainEqual(['unfirehose_display_name', 'russell']));
  });

  it('confirms a save, since the page shows no other sign of one', async () => {
    await show();
    const input = screen.getByDisplayValue('fox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'russell' } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
  });

  it('moves between tabs', async () => {
    await show();
    await tab('Appearance');
    await tab('Mesh');
    await tab('API Keys');
    expect(screen.getByText('LLM Providers')).toBeInTheDocument();
  });
});

describe('LLM providers', () => {
  const openTab = async () => { await show(); await tab('API Keys'); };

  it('lists providers found on this machine, and does not ask for a key for them', async () => {
    // A Claude Max token already on disk needs nothing typed in. Showing a
    // key field for it invites someone to paste one that is never used.
    await openTab();
    expect(screen.getByText('Auto-detected')).toBeInTheDocument();
    expect(screen.getByText('Claude Max')).toBeInTheDocument();
  });

  it('fills in the endpoint when a preset is chosen', async () => {
    // Typing an endpoint by hand is where a wrong path gets in, and a
    // wrong path fails as an auth error.
    await openTab();
    await act(async () => { byText('OpenAI')!.click(); });
    await waitFor(() => expect(saved()).toContainEqual(
      ['llm_commit_endpoint', 'https://api.openai.com/v1/chat/completions'],
    ));
  });

  it('sets a default model with the endpoint, so the pair is never half-configured', async () => {
    await openTab();
    await act(async () => { byText('OpenAI')!.click(); });
    await waitFor(() => expect(saved()).toContainEqual(['llm_commit_model', 'gpt-4o-mini']));
  });

  it('remembers which provider was chosen', async () => {
    await openTab();
    await act(async () => { byText('Groq')!.click(); });
    expect(preferred).toContain('groq');
  });

  it('leaves the endpoint blank for a custom provider rather than inventing one', async () => {
    await openTab();
    await act(async () => { byText('Custom endpoint')!.click(); });
    expect(saved().some(([k]) => k === 'llm_commit_endpoint')).toBe(false);
  });

  it('clearing a provider removes its endpoint, model and key together', async () => {
    // Leaving any one of the three behind is a half-configured provider
    // that fails at call time rather than here.
    settings.llm_commit_endpoint = 'https://api.openai.com/v1/chat/completions';
    settings.llm_commit_model = 'gpt-4o-mini';
    vaultKeys.openai = 'sk-fake-for-tests';
    await openTab();
    await act(async () => { byText('Clear')!.click(); });
    expect(saved()).toEqual(expect.arrayContaining([
      ['llm_commit_endpoint', ''], ['llm_commit_model', ''],
    ]));
    expect(vaultKeys.openai).toBeUndefined();
  });

  it('recognises a configured endpoint as its preset rather than as custom', async () => {
    // A key is stored in the vault under the preset's id. Opening as
    // Custom would look for it under the wrong name and silently ask for
    // one that is already there.
    settings.llm_commit_endpoint = 'https://api.deepseek.com/v1/chat/completions';
    await openTab();
    // The chosen preset's panel names it and offers to clear it.
    expect(byText('Clear')).toBeTruthy();
  });
});
