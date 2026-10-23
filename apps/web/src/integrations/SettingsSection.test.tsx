// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { INTEGRATIONS } from './catalog';

/**
 * Settings → Integrations.
 *
 * One toggle per integration, off by default. Turning one on is a POST to
 * /api/integrations, and an integration the environment decides is shown
 * locked rather than offering a toggle that the next request would ignore.
 */

let list: Record<string, unknown>[];
vi.mock('swr', () => ({
  default: (key: string) => ({
    data: key === '/api/integrations' ? { integrations: list } : undefined,
    error: undefined, isLoading: false, mutate: vi.fn(),
  }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }), usePathname: () => '/settings', useSearchParams: () => new URLSearchParams(),
}));

const { IntegrationsSettings } = await import('./SettingsSection');
const first = INTEGRATIONS[0];

beforeEach(() => {
  list = [{ ...first, enabled: false, source: 'default' }];
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })) as never;
});
afterEach(cleanup);

const box = () => document.querySelector(`input[aria-label="Enable ${first.name}"]`) as HTMLInputElement;

describe('Settings → Integrations', () => {
  it('lists each integration, off, with how to turn it on', () => {
    const { container } = render(<IntegrationsSettings />);
    expect(container.textContent).toContain(first.name);
    expect(container.textContent).toContain('UNFIREHOSE_INTEGRATIONS');
    expect(box().checked).toBe(false);
  });

  it('turns one on through /api/integrations', async () => {
    render(<IntegrationsSettings />);
    await act(async () => { fireEvent.click(box()); });
    await waitFor(() => {
      const [url, init] = (global.fetch as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls[0];
      expect(url).toBe('/api/integrations');
      expect(JSON.parse(init.body)).toEqual({ id: first.id, enabled: true });
    });
  });

  it('shows the environment\'s decision locked', () => {
    list = [{ ...first, enabled: true, source: 'env' }];
    const { container } = render(<IntegrationsSettings />);
    expect(box().disabled).toBe(true);
    expect(container.textContent).toMatch(/unset it to toggle here/);
  });

  it('says why a toggle did not save', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'env decides' }) })) as never;
    const { container } = render(<IntegrationsSettings />);
    await act(async () => { fireEvent.click(box()); });
    await waitFor(() => expect(container.textContent).toContain('env decides'));
  });
});
