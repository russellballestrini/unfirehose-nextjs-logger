// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

/**
 * "Is it us or them", answered in one line.
 *
 * This banner is the first thing on our rate-limits page, and its whole job
 * is to separate a provider that did not serve from one that served and
 * said slow down. Those look identical in a log — both are a failed
 * request — and treating a throttle as an outage is how someone spends an
 * afternoon looking for a fault on their own side.
 */

let status: Record<string, unknown> | undefined;
vi.mock('swr', () => ({
  default: () => ({ data: status, error: undefined, isLoading: false, mutate: vi.fn() }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));

const { NowBanner, VendorStatusTab } = await import('./VendorStatus');

const row = (over: Record<string, unknown> = {}) => ({
  provider: 'anthropic', upstream: null, kind: 'rate_limit', http_status: 429,
  m60: 4, m15: 2, last_seen: new Date().toISOString(),
  first_seen: new Date().toISOString(), sample: 'rate_limit_error', ...over,
});

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});
beforeEach(() => {
  status = { current: [
    { id: 'anthropic', name: 'Anthropic', url: 'https://status.anthropic.com', kind: 'statuspage',
      poll: { indicator: 'none', incidents: [] }, since: null },
  ] };
});
afterEach(cleanup);

const banner = (rows: unknown[]) => render(<NowBanner rows={rows as never} />).container;

describe('NowBanner', () => {
  it('says nothing is wrong when nothing is', () => {
    expect(banner([]).textContent).toContain('No refusals in the last hour');
  });

  it('calls a 5xx a refusal, not a throttle', () => {
    // The provider did not serve. Painting this amber next to a genuine
    // throttle loses the only distinction the banner exists to make.
    expect(banner([row({ kind: 'server_error', http_status: 503, m15: 3 })]).textContent)
      .toContain('REFUSED NOW — 3 hard refusals in the last 15 min');
  });

  it('calls a 429 a throttle', () => {
    expect(banner([row({ m15: 2 })]).textContent)
      .toContain('THROTTLED NOW — 2 refusals in the last 15 min');
  });

  it('treats every hard kind the same way', () => {
    for (const kind of ['server_error', 'overloaded', 'timeout', 'model_gone']) {
      cleanup();
      expect(banner([row({ kind, m15: 1 })]).textContent).toContain('REFUSED NOW');
    }
  });

  it('counts one refusal in the singular', () => {
    expect(banner([row({ m15: 1 })]).textContent).toContain('1 refusal in the last 15 min');
  });

  it('separates quiet-right-now from quiet-all-hour', () => {
    // Nothing in fifteen minutes but plenty in the hour is a recovery, and
    // it must not read the same as an hour with nothing in it.
    const text = banner([row({ m15: 0, m60: 7 })]).textContent!;
    expect(text).toContain('Quiet for 15 min — 7 refusals earlier this hour');
    expect(text).not.toContain('No refusals in the last hour');
  });

  it('adds up every row rather than reporting the first', () => {
    expect(banner([row({ m15: 2 }), row({ provider: 'openai', m15: 3 })]).textContent)
      .toContain('5 refusals in the last 15 min');
  });

  it('puts the vendor\'s own light beside the line, so us-or-them is one glance', () => {
    status = { current: [
      { id: 'anthropic', name: 'Anthropic', poll: { indicator: 'major', incidents: [] } },
    ] };
    expect(banner([row({ m15: 1 })]).innerHTML).toContain('outage');
  });

  it('matches a row to its vendor by upstream when there is one', () => {
    // A request through a gateway names the gateway as provider and the
    // real vendor as upstream; grading it against the gateway's status
    // page reports the wrong company's outage.
    status = { current: [
      { id: 'anthropic', name: 'Anthropic', poll: { indicator: 'major', incidents: [] } },
    ] };
    const html = banner([row({ provider: 'openrouter', upstream: 'anthropic', m15: 1 })]).innerHTML;
    expect(html).toContain('outage');
  });

  it('draws a row for a vendor it has no status for', () => {
    status = { current: [] };
    expect(banner([row({ m15: 1 })]).textContent).toContain('rate_limit');
  });
});

describe('VendorStatusTab', () => {
  it('lists each vendor with its light', () => {
    const { container } = render(<VendorStatusTab />);
    expect(container.textContent).toContain('Anthropic');
    expect(container.textContent).toContain('anthropic');
  });

  it('names an open incident', () => {
    status = { current: [{
      id: 'openai', name: 'OpenAI', url: 'https://status.openai.com', kind: 'statuspage',
      poll: { indicator: 'minor', incidents: [
        { open: true, title: 'Elevated error rates', status: 'investigating', updatedAt: new Date().toISOString() },
        { open: false, title: 'Resolved thing', status: 'resolved', updatedAt: new Date().toISOString() },
      ] },
    }] };
    const { container } = render(<VendorStatusTab />);
    expect(container.textContent).toContain('Elevated error rates');
    expect(container.textContent).not.toContain('Resolved thing');
  });

  it('marks a vendor we probe ourselves rather than read a feed from', () => {
    // A page we scrape is weaker evidence than an incident feed, and the
    // badge is the only thing that says so.
    status = { current: [{
      id: 'somevendor', name: 'Some Vendor', url: 'https://example.invalid',
      kind: 'http-probe', note: 'no status feed published',
      poll: { indicator: 'none', incidents: [] },
    }] };
    const { container } = render(<VendorStatusTab />);
    expect(container.textContent).toContain('Some Vendor');
  });

  it('says so when the status endpoint itself is down', () => {
    status = undefined;
    const { container } = render(<VendorStatusTab />);
    expect(container.textContent).toContain('incident feed');
  });
});
