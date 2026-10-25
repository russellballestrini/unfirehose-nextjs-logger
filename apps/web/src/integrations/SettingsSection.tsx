'use client';

import { useState } from 'react';
import { INTEGRATIONS_ENV } from './catalog';
import { integrationSettingsPanel, useIntegrations, type IntegrationStatus } from './index';

/**
 * Settings → Integrations: one row per optional integration, each off until
 * someone turns it on here or names it in `UNFIREHOSE_INTEGRATIONS`. An
 * integration that is on shows its own settings (keys and the like) below
 * its toggle.
 */
export function IntegrationsSettings() {
  const { list, loaded, mutate } = useIntegrations();
  const [error, setError] = useState<string | null>(null);

  const toggle = async (i: IntegrationStatus, enabled: boolean) => {
    setError(null);
    mutate(
      (prev) => ({ ...prev, integrations: (prev?.integrations ?? []).map((x) => (x.id === i.id ? { ...x, enabled, source: 'setting' as const } : x)) }),
      { revalidate: false },
    );
    const res = await fetch('/api/integrations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: i.id, enabled }),
    }).catch(() => null);
    if (!res?.ok) {
      const body = await res?.json().catch(() => null);
      setError(body?.error ?? 'Could not save');
    }
    mutate();
  };

  return (
    <div className="space-y-3">
      <p className="text-base text-[var(--color-muted)]">
        Optional products this dashboard can talk to. Each is off until turned on here; while off it
        makes no requests and adds nothing to any page. <code className="font-mono">{INTEGRATIONS_ENV}</code>,
        when set (a comma-separated list of ids, or <code className="font-mono">none</code>), decides instead.
      </p>
      {!loaded && <div className="text-base text-[var(--color-muted)]">Loading…</div>}
      {list.map((i) => {
        const Panel = integrationSettingsPanel(i.id);
        const locked = i.source === 'env';
        return (
          <div key={i.id} className="space-y-3">
            <div className="flex items-start justify-between gap-4 bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
              <div className="min-w-0">
                <div className="text-base font-bold">
                  {i.name} <span className="font-mono text-xs text-[var(--color-muted)]">{i.id}</span>
                </div>
                <p className="text-base text-[var(--color-muted)] mt-0.5">{i.summary}</p>
                {i.href && (
                  <a href={i.href} target="_blank" rel="noopener noreferrer" className="text-sm text-[var(--color-accent)] hover:underline">
                    {i.href.replace(/^https?:\/\//, '')}
                  </a>
                )}
                {locked && (
                  <p className="text-sm text-[var(--color-muted)] mt-1">
                    Set by <code className="font-mono">{INTEGRATIONS_ENV}</code>; unset it to toggle here.
                  </p>
                )}
              </div>
              <label className="flex items-center gap-2 text-base shrink-0">
                <input type="checkbox" checked={i.enabled} disabled={locked} aria-label={`Enable ${i.name}`}
                  className="accent-[var(--color-accent)]"
                  onChange={(e) => toggle(i, e.target.checked)} />
                <span className={i.enabled ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'}>
                  {i.enabled ? 'On' : 'Off'}
                </span>
              </label>
            </div>
            {i.enabled && Panel && <Panel />}
          </div>
        );
      })}
      {error && <div className="text-base text-red-400">{error}</div>}
    </div>
  );
}
