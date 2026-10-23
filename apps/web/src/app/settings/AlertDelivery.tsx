'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '@unturf/unfirehose-ui/fetcher';
import { human as humanAgo } from '@unturf/unfirehose/ago';

/**
 * Settings → Alerts: where our usage alerts go.
 *
 * A rule picks alerts (all, one threshold, one project) and a destination:
 * a webhook, ntfy, Slack or Discord. Our worker sends; this panel saves
 * rules, shows each one's last result, and sends a test. Secrets typed
 * here go to our server once and only ever come back masked; a blank
 * secret field on an edit keeps what is stored. Nothing is sent until a
 * rule exists.
 */

type Destination = 'webhook' | 'ntfy' | 'slack' | 'discord';
type Scope = 'all' | 'threshold' | 'project';

interface Rule {
  id: number;
  name: string;
  enabled: boolean;
  destination: Destination;
  config: { url?: string; server?: string; topic?: string };
  match: { metric: string | null; window: number | null; project: string | null };
  rate_limit_per_hour: number;
  secrets: Record<string, string | null>;
  last: { status: string; http_status: number | null; error: string | null; at: string; is_test: boolean } | null;
  sent_24h: number;
  failed_24h: number;
}

interface Threshold { id: number; window_minutes: number; metric: string; enabled: number }

const DEST_LABEL: Record<Destination, string> = {
  webhook: 'Webhook (JSON POST)',
  ntfy: 'ntfy',
  slack: 'Slack incoming webhook',
  discord: 'Discord webhook',
};

const SECRET_LABEL: Record<string, string> = {
  webhookUrl: 'Webhook URL',
  hmacSecret: 'Signing secret (optional, HMAC-SHA256)',
  token: 'Access token (optional)',
};

const SECRET_FIELDS: Record<Destination, string[]> = {
  webhook: ['hmacSecret'],
  ntfy: ['token'],
  slack: ['webhookUrl'],
  discord: ['webhookUrl'],
};

const METRIC_LABEL: Record<string, string> = {
  input_tokens: 'input tokens', output_tokens: 'output tokens', total_tokens: 'total tokens', cost_usd: 'cost',
};

const inputCls = 'w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base';
const btnCls = 'px-3 py-1.5 rounded text-sm font-bold border border-[var(--color-border)] hover:border-[var(--color-accent)] cursor-pointer disabled:opacity-50';

interface Form {
  id: number | null;
  name: string;
  destination: Destination;
  url: string;
  server: string;
  topic: string;
  secrets: Record<string, string>;
  scope: Scope;
  threshold: string; // "window:metric"
  project: string;
  rate: string;
  enabled: boolean;
}

const emptyForm = (): Form => ({
  id: null, name: '', destination: 'webhook', url: '', server: 'https://ntfy.sh', topic: '',
  secrets: {}, scope: 'all', threshold: '', project: '', rate: '10', enabled: true,
});

function formFromRule(r: Rule): Form {
  const scope: Scope = r.match.project ? 'project' : r.match.metric || r.match.window ? 'threshold' : 'all';
  return {
    id: r.id, name: r.name, destination: r.destination,
    url: r.config.url ?? '', server: r.config.server ?? 'https://ntfy.sh', topic: r.config.topic ?? '',
    secrets: {}, scope,
    threshold: r.match.window && r.match.metric ? `${r.match.window}:${r.match.metric}` : '',
    project: r.match.project ?? '', rate: String(r.rate_limit_per_hour), enabled: r.enabled,
  };
}

export function describeMatch(m: Rule['match']): string {
  if (m.project) return `project ${m.project}`;
  if (m.metric || m.window) {
    const w = m.window ? `${m.window} min` : 'any window';
    return `${w} · ${m.metric ? METRIC_LABEL[m.metric] ?? m.metric : 'any metric'}`;
  }
  return 'all alerts';
}

function describeDestination(r: Rule): string {
  if (r.destination === 'webhook') return r.config.url ?? '';
  if (r.destination === 'ntfy') return `${r.config.server ?? ''}/${r.config.topic ?? ''}`;
  return r.secrets.webhookUrl ?? 'no webhook URL stored';
}

export function AlertDelivery() {
  const { data, error, mutate } = useSWR('/api/alerts/delivery', fetcher, { refreshInterval: 30_000 });
  const { data: thresholds } = useSWR('/api/alerts?filter=thresholds', fetcher);
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<Record<number, string>>({});

  if (error) return <p className="text-[var(--color-error)]">Could not read delivery rules: {String(error.message ?? error)}</p>;
  if (!data) return <p className="text-[var(--color-muted)]">Reading delivery rules…</p>;
  const rules: Rule[] = data.rules ?? [];
  const thresholdList: Threshold[] = Array.isArray(thresholds) ? thresholds : [];
  const editing = form?.id ? rules.find((r) => r.id === form.id) ?? null : null;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  async function save() {
    if (!form) return;
    setBusy(true);
    setErrors({});
    const [win, metric] = form.threshold.split(':');
    const body: Record<string, unknown> = {
      name: form.name,
      enabled: form.enabled,
      config: form.destination === 'webhook' ? { url: form.url } : form.destination === 'ntfy' ? { server: form.server, topic: form.topic } : {},
      secrets: form.secrets,
      match: form.scope === 'threshold' && form.threshold ? { window: Number(win), metric }
        : form.scope === 'project' ? { project: form.project } : {},
      rate_limit_per_hour: Number(form.rate),
    };
    if (!form.id) body.destination = form.destination;
    try {
      const res = await fetch(form.id ? `/api/alerts/delivery/${form.id}` : '/api/alerts/delivery', {
        method: form.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { setErrors(out.errors ?? { form: out.error ?? `HTTP ${res.status}` }); return; }
      setForm(null);
      await mutate();
    } finally {
      setBusy(false);
    }
  }

  async function toggle(r: Rule) {
    await fetch(`/api/alerts/delivery/${r.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !r.enabled }),
    });
    await mutate();
  }

  async function remove(r: Rule) {
    if (typeof window !== 'undefined' && !window.confirm(`Delete rule "${r.name}"?`)) return;
    await fetch(`/api/alerts/delivery/${r.id}`, { method: 'DELETE' });
    await mutate();
  }

  async function sendTest(r: Rule) {
    setTests((t) => ({ ...t, [r.id]: 'Sending…' }));
    try {
      const res = await fetch(`/api/alerts/delivery/${r.id}/test`, { method: 'POST' });
      const out = await res.json();
      const msg = out.ok ? `Delivered (HTTP ${out.status})` : `Failed: ${out.error ?? `HTTP ${out.status}`}`;
      setTests((t) => ({ ...t, [r.id]: msg }));
    } catch (err) {
      setTests((t) => ({ ...t, [r.id]: `Failed: ${(err as Error).message}` }));
    }
    await mutate();
  }

  const fieldError = (k: string) => errors[k] ? <p className="text-sm text-[var(--color-error)] mt-1" data-error={k}>{errors[k]}</p> : null;

  return (
    <div className="space-y-4">
      <p className="text-base text-[var(--color-muted)]">
        Send our usage alerts somewhere you will see them. Our worker delivers each new alert once per rule,
        retries a failed send with backoff, and holds each rule to its own per-hour limit.
        Nothing is sent until a rule exists. Secrets stay on this machine, in a file only your user can read, and show here masked.
      </p>

      {rules.length === 0 && !form && (
        <p className="text-base text-[var(--color-muted)]" data-empty>No delivery rules yet. Alerts show on the Usage page only.</p>
      )}

      <div className="space-y-3">
        {rules.map((r) => (
          <div key={r.id} data-rule={r.id}
               className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-base font-bold">{r.name} <span className="text-sm text-[var(--color-muted)] font-normal">{DEST_LABEL[r.destination]}</span></h3>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} className="accent-[var(--color-accent)]" aria-label={`Enable ${r.name}`} />
                <span className={r.enabled ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'}>{r.enabled ? 'on' : 'off'}</span>
              </label>
            </div>
            <p className="text-sm text-[var(--color-muted)] break-all">
              {describeMatch(r.match)} → <code>{describeDestination(r)}</code> · up to {r.rate_limit_per_hour}/hour
            </p>
            <p className="text-sm text-[var(--color-muted)]" data-last>
              {r.last
                ? <>Last {r.last.is_test ? 'test' : 'send'}: <span className={r.last.status === 'sent' ? 'text-[var(--color-accent)]' : 'text-[var(--color-error)]'}>{r.last.status}</span>
                    {r.last.http_status ? ` (HTTP ${r.last.http_status})` : ''}{r.last.error ? `: ${r.last.error}` : ''} · {humanAgo(r.last.at)}</>
                : 'Nothing sent yet.'}
              {' '}· 24h: {r.sent_24h} sent, {r.failed_24h} not delivered
            </p>
            <div className="flex flex-wrap gap-2 items-center">
              <button className={btnCls} onClick={() => sendTest(r)}>Send test</button>
              <button className={btnCls} onClick={() => { setErrors({}); setForm(formFromRule(r)); }}>Edit</button>
              <button className={btnCls} onClick={() => remove(r)}>Delete</button>
              {tests[r.id] && <span className="text-sm" data-test-result={r.id}>{tests[r.id]}</span>}
            </div>
          </div>
        ))}
      </div>

      {!form && <button className={btnCls} onClick={() => { setErrors({}); setForm(emptyForm()); }}>Add rule</button>}

      {form && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3" data-form>
          <h3 className="text-base font-bold text-[var(--color-muted)]">{form.id ? `Edit ${editing?.name ?? 'rule'}` : 'New rule'}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-sm text-[var(--color-muted)] block mb-1" htmlFor="ad-name">Name</label>
              <input id="ad-name" className={inputCls} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="phone, team channel…" />
            </div>
            <div>
              <label className="text-sm text-[var(--color-muted)] block mb-1" htmlFor="ad-dest">Destination</label>
              <select id="ad-dest" className={inputCls} value={form.destination} disabled={Boolean(form.id)}
                      onChange={(e) => setForm({ ...form, destination: e.target.value as Destination, secrets: {} })}>
                {(Object.keys(DEST_LABEL) as Destination[]).map((d) => <option key={d} value={d}>{DEST_LABEL[d]}</option>)}
              </select>
              {fieldError('destination')}
            </div>

            {form.destination === 'webhook' && (
              <div className="md:col-span-2">
                <label className="text-sm text-[var(--color-muted)] block mb-1" htmlFor="ad-url">URL</label>
                <input id="ad-url" className={inputCls} value={form.url} onChange={(e) => set('url', e.target.value)} placeholder="https://example.com/hooks/unfirehose" />
                {fieldError('url')}
              </div>
            )}
            {form.destination === 'ntfy' && (
              <>
                <div>
                  <label className="text-sm text-[var(--color-muted)] block mb-1" htmlFor="ad-server">Server</label>
                  <input id="ad-server" className={inputCls} value={form.server} onChange={(e) => set('server', e.target.value)} placeholder="https://ntfy.sh or your own" />
                  {fieldError('server')}
                </div>
                <div>
                  <label className="text-sm text-[var(--color-muted)] block mb-1" htmlFor="ad-topic">Topic</label>
                  <input id="ad-topic" className={inputCls} value={form.topic} onChange={(e) => set('topic', e.target.value)} placeholder="a hard-to-guess name" />
                  {fieldError('topic')}
                </div>
              </>
            )}
            {SECRET_FIELDS[form.destination].map((k) => {
              const stored = editing?.secrets[k] ?? null;
              return (
                <div key={k} className="md:col-span-2">
                  <label className="text-sm text-[var(--color-muted)] block mb-1" htmlFor={`ad-${k}`}>{SECRET_LABEL[k]}</label>
                  <input id={`ad-${k}`} type="password" autoComplete="off" className={inputCls}
                         value={form.secrets[k] ?? ''}
                         onChange={(e) => set('secrets', { ...form.secrets, [k]: e.target.value })}
                         placeholder={stored ? `stored ${stored}; leave blank to keep` : k === 'webhookUrl' ? 'https://…' : ''} />
                  {fieldError(k)}
                </div>
              );
            })}

            <div>
              <label className="text-sm text-[var(--color-muted)] block mb-1" htmlFor="ad-scope">Which alerts</label>
              <select id="ad-scope" className={inputCls} value={form.scope} onChange={(e) => set('scope', e.target.value as Scope)}>
                <option value="all">All alerts</option>
                <option value="threshold">One threshold</option>
                <option value="project">One project</option>
              </select>
              {fieldError('match')}
            </div>
            {form.scope === 'threshold' && (
              <div>
                <label className="text-sm text-[var(--color-muted)] block mb-1" htmlFor="ad-threshold">Threshold</label>
                <select id="ad-threshold" className={inputCls} value={form.threshold} onChange={(e) => set('threshold', e.target.value)}>
                  <option value="">Choose…</option>
                  {thresholdList.map((t) => (
                    <option key={t.id} value={`${t.window_minutes}:${t.metric}`}>
                      {t.window_minutes} min · {METRIC_LABEL[t.metric] ?? t.metric}{t.enabled ? '' : ' (off)'}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {form.scope === 'project' && (
              <div>
                <label className="text-sm text-[var(--color-muted)] block mb-1" htmlFor="ad-project">Project</label>
                <input id="ad-project" className={inputCls} value={form.project} onChange={(e) => set('project', e.target.value)} placeholder="project name" />
              </div>
            )}
            <div>
              <label className="text-sm text-[var(--color-muted)] block mb-1" htmlFor="ad-rate">Most per hour</label>
              <input id="ad-rate" type="number" min={1} max={600} className={inputCls} value={form.rate} onChange={(e) => set('rate', e.target.value)} />
              {fieldError('rate_limit_per_hour')}
            </div>
            <label className="flex items-center gap-2 text-base self-end">
              <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} className="accent-[var(--color-accent)]" />
              Enabled
            </label>
          </div>
          {fieldError('form')}
          <div className="flex gap-2">
            <button className={btnCls} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save rule'}</button>
            <button className={btnCls} onClick={() => { setForm(null); setErrors({}); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
