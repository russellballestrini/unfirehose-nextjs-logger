// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';

const answers: Record<string, unknown> = {};
const mutate = vi.fn();
vi.mock('swr', () => ({ default: (key: string) => ({ data: answers[key], error: undefined, mutate }) }));
const { AlertDelivery, describeMatch } = await import('./AlertDelivery');

const rule = (over: Record<string, unknown> = {}) => ({
  id: 1, name: 'phone', enabled: true, destination: 'slack', config: {},
  match: { metric: null, window: null, project: null }, rate_limit_per_hour: 10,
  secrets: { webhookUrl: 'https://hooks.slack.com/••••abcd' },
  last: null, sent_24h: 0, failed_24h: 0, ...over,
});

afterEach(() => {
  cleanup();
  for (const k of Object.keys(answers)) delete answers[k];
  vi.unstubAllGlobals();
});

describe('AlertDelivery', () => {
  it('says nothing is sent until a rule exists', () => {
    answers['/api/alerts/delivery'] = { rules: [] };
    const { container } = render(<AlertDelivery />);
    expect(container.querySelector('[data-empty]')!.textContent).toContain('No delivery rules yet');
  });

  it('shows each rule with its match, masked destination and last result', () => {
    answers['/api/alerts/delivery'] = {
      rules: [
        rule({ last: { status: 'failed', http_status: 404, error: 'HTTP 404: no_service', at: new Date().toISOString(), is_test: false }, failed_24h: 1 }),
        rule({ id: 2, name: 'lan', destination: 'ntfy', config: { server: 'http://ntfy.lan', topic: 'fox' }, secrets: { token: null }, match: { metric: 'output_tokens', window: 15, project: null } }),
      ],
    };
    const { container } = render(<AlertDelivery />);
    const one = container.querySelector('[data-rule="1"]')!;
    expect(one.textContent).toContain('all alerts');
    expect(one.textContent).toContain('https://hooks.slack.com/••••abcd');
    expect(one.querySelector('[data-last]')!.textContent).toContain('failed (HTTP 404): HTTP 404: no_service');
    expect(container.querySelector('[data-rule="2"]')!.textContent).toContain('15 min · output tokens → http://ntfy.lan/fox');
  });

  it('sends a test and shows what came back', async () => {
    answers['/api/alerts/delivery'] = { rules: [rule()] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, status: 200, error: null })));
    vi.stubGlobal('fetch', fetchMock);
    const { getByText, container } = render(<AlertDelivery />);
    fireEvent.click(getByText('Send test'));
    await waitFor(() => expect(container.querySelector('[data-test-result="1"]')!.textContent).toBe('Delivered (HTTP 200)'));
    expect(fetchMock).toHaveBeenCalledWith('/api/alerts/delivery/1/test', { method: 'POST' });
  });

  it('creates an ntfy rule for one threshold and shows field errors from the server', async () => {
    answers['/api/alerts/delivery'] = { rules: [] };
    answers['/api/alerts?filter=thresholds'] = [{ id: 7, window_minutes: 60, metric: 'input_tokens', enabled: 1 }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Invalid rule', errors: { topic: 'topic is 1 to 64 letters, digits, - or _' } }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const { getByText, getByLabelText, container } = render(<AlertDelivery />);
    fireEvent.click(getByText('Add rule'));
    fireEvent.change(getByLabelText('Destination'), { target: { value: 'ntfy' } });
    fireEvent.change(getByLabelText('Topic'), { target: { value: 'bad topic' } });
    fireEvent.change(getByLabelText('Access token (optional)'), { target: { value: 'tk_secret' } });
    fireEvent.change(getByLabelText('Which alerts'), { target: { value: 'threshold' } });
    fireEvent.change(getByLabelText('Threshold'), { target: { value: '60:input_tokens' } });
    fireEvent.click(getByText('Save rule'));
    await waitFor(() => expect(container.querySelector('[data-error="topic"]')).not.toBeNull());
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent).toMatchObject({
      destination: 'ntfy', config: { server: 'https://ntfy.sh', topic: 'bad topic' },
      secrets: { token: 'tk_secret' }, match: { window: 60, metric: 'input_tokens' }, rate_limit_per_hour: 10,
    });
    fireEvent.change(getByLabelText('Topic'), { target: { value: 'fox' } });
    fireEvent.click(getByText('Save rule'));
    await waitFor(() => expect(container.querySelector('[data-form]')).toBeNull());
    expect(mutate).toHaveBeenCalled();
  });

  it('edits with secret fields blank, showing what is stored, and does not resend a destination', async () => {
    answers['/api/alerts/delivery'] = { rules: [rule()] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);
    const { getByText, getByLabelText } = render(<AlertDelivery />);
    fireEvent.click(getByText('Edit'));
    const secret = getByLabelText('Webhook URL') as HTMLInputElement;
    expect(secret.value).toBe('');
    expect(secret.placeholder).toBe('stored https://hooks.slack.com/••••abcd; leave blank to keep');
    expect((getByLabelText('Destination') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(getByText('Save rule'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/alerts/delivery/1');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body);
    expect(body.destination).toBeUndefined();
    expect(body.secrets).toEqual({});
  });
});

describe('describeMatch', () => {
  it('reads a match the way a person would say it', () => {
    expect(describeMatch({ metric: null, window: null, project: null })).toBe('all alerts');
    expect(describeMatch({ metric: 'output_tokens', window: 60, project: null })).toBe('60 min · output tokens');
    expect(describeMatch({ metric: null, window: null, project: 'unfirehose' })).toBe('project unfirehose');
  });
});
