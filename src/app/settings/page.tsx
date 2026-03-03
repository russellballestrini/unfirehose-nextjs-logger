'use client';

import { useState, useCallback } from 'react';
import useSWR from 'swr';
import { PageContext } from '@/components/PageContext';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const PLANS = [
  { value: '', label: 'Select your plan...' },
  { value: 'free', label: 'Free', desc: 'Light usage, conservative alerts' },
  { value: 'starter', label: 'Starter ($14/mo)', desc: 'Individual usage, balanced alerts' },
  { value: 'pro', label: 'Pro ($69/mo)', desc: 'Power user, relaxed alerts' },
  { value: 'max', label: 'Max ($149/mo)', desc: 'Heavy multi-agent, high thresholds' },
  { value: 'ultra', label: 'Ultra ($420/mo)', desc: 'Maximum capacity, highest thresholds' },
];

const SETTINGS_KEYS = {
  plan: 'anthropic_plan',
  firehoseKey: 'unfirehose_api_key',
  firehoseEndpoint: 'unfirehose_endpoint',
  firehoseEnabled: 'unfirehose_enabled',
};

export default function SettingsPage() {
  const { data: settings, mutate } = useSWR('/api/settings', fetcher);
  const { data: thresholds, mutate: mutateThresholds } = useSWR(
    '/api/alerts?filter=thresholds',
    fetcher
  );
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const saveSetting = useCallback(
    async (key: string, value: string) => {
      setSaving(true);
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set', key, value }),
      });
      mutate();
      if (key === SETTINGS_KEYS.plan) mutateThresholds();
      setSaving(false);
      showToast(`Saved ${key}`);
    },
    [mutate, mutateThresholds]
  );

  const currentPlan = settings?.[SETTINGS_KEYS.plan] ?? '';
  const firehoseKey = settings?.[SETTINGS_KEYS.firehoseKey] ?? '';
  const firehoseEndpoint =
    settings?.[SETTINGS_KEYS.firehoseEndpoint] ?? 'https://api.unfirehose.com';
  const firehoseEnabled = settings?.[SETTINGS_KEYS.firehoseEnabled] === 'true';

  // Detect plan from historical DB data
  const { data: activity } = useSWR('/api/projects/activity?days=30', fetcher);
  const estimatedMonthlyCost = activity
    ? activity.reduce((sum: number, p: { cost_estimate?: number }) => sum + (p.cost_estimate ?? 0), 0)
    : null;

  const suggestedPlan = estimatedMonthlyCost
    ? estimatedMonthlyCost > 8000
      ? 'ultra'
      : estimatedMonthlyCost > 3000
        ? 'max'
        : estimatedMonthlyCost > 1000
          ? 'pro'
          : estimatedMonthlyCost > 200
            ? 'starter'
            : 'free'
    : null;

  return (
    <div className="space-y-6 max-w-2xl">
      <PageContext
        pageType="settings"
        summary={`Settings page. Plan: ${currentPlan || 'not set'}. Firehose: ${firehoseEnabled ? 'enabled' : 'disabled'}.`}
        metrics={{
          plan: currentPlan || 'unset',
          firehose_enabled: firehoseEnabled,
          estimated_monthly_cost: estimatedMonthlyCost,
        }}
      />

      <h2 className="text-lg font-bold">Settings</h2>

      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 bg-[var(--color-accent)] text-black px-4 py-2 rounded text-sm font-bold z-50">
          {toast}
        </div>
      )}

      {/* Anthropic Plan */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
        <h3 className="text-sm font-bold text-[var(--color-muted)]">Anthropic Plan</h3>

        {/* Auto-detection hint */}
        {suggestedPlan && !currentPlan && (
          <div className="bg-[var(--color-background)] border border-[var(--color-accent)] rounded p-3 text-sm">
            <span className="text-[var(--color-accent)] font-bold">Auto-detected: </span>
            Based on 30-day usage (~${estimatedMonthlyCost?.toLocaleString()} equivalent API cost),
            we suggest{' '}
            <button
              onClick={() => saveSetting(SETTINGS_KEYS.plan, suggestedPlan)}
              className="text-[var(--color-accent)] underline font-bold"
            >
              {PLANS.find((p) => p.value === suggestedPlan)?.label}
            </button>
          </div>
        )}

        <div className="space-y-2">
          <label className="text-sm text-[var(--color-muted)]">
            Select your Anthropic subscription plan. This auto-adjusts alert thresholds.
          </label>
          <select
            value={currentPlan}
            onChange={(e) => {
              if (e.target.value) saveSetting(SETTINGS_KEYS.plan, e.target.value);
            }}
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-sm"
          >
            {PLANS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
                {p.desc ? ` — ${p.desc}` : ''}
              </option>
            ))}
          </select>
        </div>

        {currentPlan && (
          <div className="text-xs text-[var(--color-muted)]">
            Current: <span className="text-[var(--color-foreground)] font-bold">{PLANS.find((p) => p.value === currentPlan)?.label}</span>
            {estimatedMonthlyCost !== null && (
              <span> — 30d equivalent API cost: <span className="text-[var(--color-accent)]">${estimatedMonthlyCost.toLocaleString()}</span></span>
            )}
          </div>
        )}

        {/* Current thresholds preview */}
        {thresholds && (
          <div className="space-y-1">
            <div className="text-xs font-bold text-[var(--color-muted)]">Active thresholds:</div>
            <div className="grid grid-cols-2 gap-1 text-xs">
              {thresholds.map((t: { id: number; window_minutes: number; metric: string; threshold_value: number; enabled: number }) => (
                <div
                  key={t.id}
                  className={`px-2 py-1 rounded ${t.enabled ? 'text-[var(--color-foreground)]' : 'text-[var(--color-muted)] line-through'}`}
                >
                  {t.window_minutes}min {t.metric.replace('_tokens', '')}: {(t.threshold_value / 1000).toFixed(0)}K
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Unfirehose Integration */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-[var(--color-muted)]">Unfirehose Integration</h3>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={firehoseEnabled}
              className="accent-[var(--color-accent)]"
              onChange={(e) =>
                saveSetting(SETTINGS_KEYS.firehoseEnabled, String(e.target.checked))
              }
            />
            <span className={firehoseEnabled ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'}>
              {firehoseEnabled ? 'Connected' : 'Disabled'}
            </span>
          </label>
        </div>

        <p className="text-xs text-[var(--color-muted)]">
          Connect to unfirehose.com to send usage data and consume social/data feeds.
        </p>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-[var(--color-muted)] block mb-1">API Endpoint</label>
            <input
              type="url"
              defaultValue={firehoseEndpoint}
              placeholder="https://api.unfirehose.com"
              className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-sm"
              onBlur={(e) => {
                if (e.target.value && e.target.value !== firehoseEndpoint) {
                  saveSetting(SETTINGS_KEYS.firehoseEndpoint, e.target.value);
                }
              }}
            />
          </div>

          <div>
            <label className="text-xs text-[var(--color-muted)] block mb-1">API Key</label>
            <input
              type="password"
              defaultValue={firehoseKey}
              placeholder="uf_..."
              className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-sm font-mono"
              onBlur={(e) => {
                if (e.target.value && e.target.value !== firehoseKey) {
                  saveSetting(SETTINGS_KEYS.firehoseKey, e.target.value);
                }
              }}
            />
          </div>
        </div>

        {firehoseEnabled && firehoseKey && (
          <div className="space-y-2">
            <div className="text-xs font-bold text-[var(--color-muted)]">Hoses (feeds)</div>
            <div className="grid grid-cols-2 gap-2">
              <HoseToggle
                label="Usage Events"
                desc="Token usage, costs, alerts"
                settingKey="unfirehose_hose_usage"
                settings={settings}
                onSave={saveSetting}
              />
              <HoseToggle
                label="Session Activity"
                desc="New sessions, prompts"
                settingKey="unfirehose_hose_sessions"
                settings={settings}
                onSave={saveSetting}
              />
              <HoseToggle
                label="Thinking Stream"
                desc="Thinking block excerpts"
                settingKey="unfirehose_hose_thinking"
                settings={settings}
                onSave={saveSetting}
              />
              <HoseToggle
                label="Social Feed"
                desc="Consume community data"
                settingKey="unfirehose_hose_social"
                settings={settings}
                onSave={saveSetting}
              />
            </div>
          </div>
        )}
      </div>

      {/* Data & Storage */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
        <h3 className="text-sm font-bold text-[var(--color-muted)]">Data & Storage</h3>
        <div className="text-xs text-[var(--color-muted)] space-y-1">
          <div>SQLite: <span className="text-[var(--color-foreground)] font-mono">~/.claude/sexy_logger.db</span></div>
          <div>Session data: <span className="text-[var(--color-foreground)] font-mono">~/.claude/projects/</span></div>
        </div>
      </div>

      {saving && (
        <div className="text-xs text-[var(--color-muted)]">Saving...</div>
      )}
    </div>
  );
}

function HoseToggle({
  label,
  desc,
  settingKey,
  settings,
  onSave,
}: {
  label: string;
  desc: string;
  settingKey: string;
  settings: Record<string, string> | undefined;
  onSave: (key: string, value: string) => void;
}) {
  const enabled = settings?.[settingKey] === 'true';

  return (
    <div
      className={`rounded border p-2 cursor-pointer transition-colors ${
        enabled
          ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
          : 'border-[var(--color-border)] hover:border-[var(--color-muted)]'
      }`}
      onClick={() => onSave(settingKey, String(!enabled))}
    >
      <div className="flex items-center gap-2">
        <span className={`text-xs font-bold ${enabled ? 'text-[var(--color-accent)]' : 'text-[var(--color-foreground)]'}`}>
          {label}
        </span>
        {enabled && <span className="text-[var(--color-accent)] text-xs">on</span>}
      </div>
      <div className="text-xs text-[var(--color-muted)]">{desc}</div>
    </div>
  );
}
