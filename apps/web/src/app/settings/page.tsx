'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import useSWR from 'swr';
import { PageContext } from '@unfirehose/ui/PageContext';
import { AVAILABLE_CURRENCIES } from '@unfirehose/ui/useCurrency';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const PLANS = [
  {
    value: '',
    label: 'Select a plan...',
    features: [],
    price: '',
  },
  {
    value: 'free',
    label: 'Free',
    features: [
      'Local dashboard + session viewer',
      'All harness ingestion (Claude, uncloseai, Fetch)',
      'PII anonymization',
      'Cross-session todo tracking',
      'Follow other developers',
      'Social analytics',
      'AGPL-3.0 — self-host forever',
    ],
    price: '$0',
  },
  {
    value: 'starter',
    label: 'Starter — $14/mo',
    features: [
      'Everything in Free',
      'Scrobble feed (unlimited history)',
      'Status posts & microblog',
      'API access + 1 custom hose',
    ],
    price: '$14/mo or $97/yr (42% off)',
  },
  {
    value: 'team',
    label: 'Team — $420/mo',
    features: [
      'Everything in Starter',
      'Unlimited seats',
      'Shared team dashboard',
      'Org-wide analytics & usage',
      'SSO & role management',
      'Priority support & SLA',
    ],
    price: '$420/mo or $2,920/yr (42% off)',
  },
];

const SETTINGS_KEYS = {
  accentColor: 'theme_accent_color',
  plan: 'unfirehose_plan',
  displayName: 'unfirehose_display_name',
  handle: 'unfirehose_handle',
  bio: 'unfirehose_bio',
  firehoseKey: 'unfirehose_api_key',
  firehosePublicKey: 'unfirehose_public_key',
  firehoseEndpoint: 'unfirehose_endpoint',
  firehoseEnabled: 'unfirehose_enabled',
  scrobbleEnabled: 'unfirehose_scrobble',
  // Mesh defaults
  meshDefaultIspCost: 'mesh_default_isp_cost',
  meshDefaultElectricity: 'mesh_default_electricity_kwh',
  meshDefaultProvider: 'mesh_default_provider',
  meshDefaultLinkMbps: 'mesh_default_link_mbps',
  meshCurrencyOracle: 'mesh_currency_oracle',
  meshGeoipAuto: 'mesh_geoip_auto',
  displayCurrency: 'display_currency',
};

export default function SettingsPage() {
  const { data: settings, mutate } = useSWR('/api/settings', fetcher);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const saveSetting = useCallback(
    async (key: string, value: string) => {
      setSaving(true);
      // Optimistic update — merge into SWR cache without refetch to avoid resetting inputs
      mutate((prev: Record<string, string> | undefined) => ({ ...prev, [key]: value }), { revalidate: false });
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set', key, value }),
      });
      setSaving(false);
      showToast('Saved');
    },
    [mutate]
  );

  const accentColor = settings?.[SETTINGS_KEYS.accentColor] ?? '#d40000';
  const systemUser = settings?._system_username ?? '';
  const [lightMode, setLightMode] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('unfirehose_light_mode');
    if (saved === 'true') {
      setLightMode(true);
      document.documentElement.classList.add('light');
      document.documentElement.classList.remove('dark');
    }
  }, []);

  function toggleTheme() {
    const next = !lightMode;
    setLightMode(next);
    localStorage.setItem('unfirehose_light_mode', String(next));
    document.documentElement.classList.toggle('light', next);
    document.documentElement.classList.toggle('dark', !next);
  }
  const currentPlan = settings?.[SETTINGS_KEYS.plan] ?? '';
  const displayName = settings?.[SETTINGS_KEYS.displayName] ?? '';
  const handle = settings?.[SETTINGS_KEYS.handle] ?? '';
  const bio = settings?.[SETTINGS_KEYS.bio] ?? '';
  const firehoseKey = settings?.[SETTINGS_KEYS.firehoseKey] ?? '';
  const firehosePublicKey = settings?.[SETTINGS_KEYS.firehosePublicKey] ?? '';
  const firehoseEndpoint =
    settings?.[SETTINGS_KEYS.firehoseEndpoint] ?? 'https://api.unfirehose.org';
  const firehoseEnabled = settings?.[SETTINGS_KEYS.firehoseEnabled] === 'true';
  const scrobbleEnabled = settings?.[SETTINGS_KEYS.scrobbleEnabled] === 'true';

  const { data: activity } = useSWR('/api/projects/activity?days=30', fetcher);
  const projectCount = activity?.length ?? 0;
  const totalPrompts = activity
    ? activity.reduce((s: number, p: { user_messages?: number }) => s + (p.user_messages ?? 0), 0)
    : 0;

  // LLM commit message generation
  const llmEndpoint = settings?.llm_commit_endpoint ?? '';
  const llmApiKey = settings?.llm_commit_api_key ?? '';
  const llmModel = settings?.llm_commit_model ?? '';

  // Mesh defaults
  const meshDefaultIspCost = settings?.[SETTINGS_KEYS.meshDefaultIspCost] ?? '110';
  const meshDefaultElectricity = settings?.[SETTINGS_KEYS.meshDefaultElectricity] ?? '0.12';
  const meshDefaultProvider = settings?.[SETTINGS_KEYS.meshDefaultProvider] ?? 'home';
  const meshDefaultLinkMbps = settings?.[SETTINGS_KEYS.meshDefaultLinkMbps] ?? '100';
  const meshCurrencyOracle = settings?.[SETTINGS_KEYS.meshCurrencyOracle] !== 'false';
  const meshGeoipAuto = settings?.[SETTINGS_KEYS.meshGeoipAuto] !== 'false';

  const selectedPlanData = PLANS.find((p) => p.value === currentPlan);

  return (
    <div className="space-y-6">
      <PageContext
        pageType="settings"
        summary={`Settings. Plan: ${currentPlan || 'not set'}. Handle: ${handle || 'not set'}. Scrobble: ${scrobbleEnabled ? 'on' : 'off'}.`}
        metrics={{
          plan: currentPlan || 'unset',
          scrobble: scrobbleEnabled ? 1 : 0,
          projects: projectCount,
          total_prompts: totalPrompts,
        }}
      />

      {toast && (
        <div className="fixed top-4 right-4 bg-[var(--color-accent)] text-black px-4 py-2 rounded text-base font-bold z-50">
          {toast}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {/* Left column */}
      <div className="space-y-6">

      {/* Profile */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
        <h3 className="text-base font-bold text-[var(--color-muted)]">Profile</h3>

        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Display Name</label>
          <input
            type="text"
            defaultValue={displayName}
            placeholder={systemUser}
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base"
            onBlur={(e) => {
              if (e.target.value !== displayName) saveSetting(SETTINGS_KEYS.displayName, e.target.value);
            }}
          />
        </div>
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Handle</label>
          <div className="flex items-center">
            <span className="text-[var(--color-muted)] text-base mr-1">@</span>
            <input
              type="text"
              defaultValue={handle}
              placeholder={systemUser}
              className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base font-mono"
              onBlur={(e) => {
                if (e.target.value !== handle) saveSetting(SETTINGS_KEYS.handle, e.target.value);
              }}
            />
          </div>
        </div>

        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Bio</label>
          <textarea
            defaultValue={bio}
            placeholder="building things with machines"
            rows={2}
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base resize-none"
            onBlur={(e) => {
              if (e.target.value !== bio) saveSetting(SETTINGS_KEYS.bio, e.target.value);
            }}
          />
        </div>

        {projectCount > 0 && (
          <div className="text-base text-[var(--color-muted)]">
            {projectCount} projects — {totalPrompts.toLocaleString()} prompts (30d)
          </div>
        )}
      </div>

      {/* Accent Color + Theme */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-[var(--color-muted)]">Accent Color</h3>
          <button
            onClick={toggleTheme}
            className="px-3 py-1.5 text-sm font-bold rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] transition-colors cursor-pointer"
          >
            {lightMode ? 'Light Mode' : 'Dark Mode'}
          </button>
        </div>
        <HexColorPicker value={accentColor} settingKey={SETTINGS_KEYS.accentColor} />
      </div>

      {/* Data & Storage */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
        <h3 className="text-base font-bold text-[var(--color-muted)]">Local Data</h3>
        <div className="text-base text-[var(--color-muted)] space-y-1">
          <div>Database: <span className="text-[var(--color-foreground)] font-mono">~/.claude/unfirehose.db</span></div>
          <div>Sessions: <span className="text-[var(--color-foreground)] font-mono">~/.claude/projects/</span></div>
        </div>
      </div>

      {/* Mesh Defaults */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
        <h3 className="text-base font-bold text-[var(--color-muted)]">Mesh Defaults</h3>
        <p className="text-base text-[var(--color-muted)]">
          Default values for new nodes. Per-node overrides in Permacomputer → node Economics tab.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-base text-[var(--color-muted)] block mb-1">ISP Cost ($/mo)</label>
            <input
              type="number"
              defaultValue={meshDefaultIspCost}
              className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base font-mono"
              onBlur={(e) => {
                if (e.target.value !== meshDefaultIspCost) saveSetting(SETTINGS_KEYS.meshDefaultIspCost, e.target.value);
              }}
            />
          </div>
          <div>
            <label className="text-base text-[var(--color-muted)] block mb-1">Electricity ($/kWh)</label>
            <input
              type="number"
              step="0.01"
              defaultValue={meshDefaultElectricity}
              className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base font-mono"
              onBlur={(e) => {
                if (e.target.value !== meshDefaultElectricity) saveSetting(SETTINGS_KEYS.meshDefaultElectricity, e.target.value);
              }}
            />
          </div>
          <div>
            <label className="text-base text-[var(--color-muted)] block mb-1">Default Provider</label>
            <select
              defaultValue={meshDefaultProvider}
              className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base"
              onChange={(e) => saveSetting(SETTINGS_KEYS.meshDefaultProvider, e.target.value)}
            >
              {MESH_PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-base text-[var(--color-muted)] block mb-1">Link Speed (Mbps)</label>
            <input
              type="number"
              defaultValue={meshDefaultLinkMbps}
              className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base font-mono"
              onBlur={(e) => {
                if (e.target.value !== meshDefaultLinkMbps) saveSetting(SETTINGS_KEYS.meshDefaultLinkMbps, e.target.value);
              }}
            />
          </div>
        </div>

        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2 text-base">
            <input
              type="checkbox"
              checked={meshGeoipAuto}
              className="accent-[var(--color-accent)]"
              onChange={(e) => saveSetting(SETTINGS_KEYS.meshGeoipAuto, String(e.target.checked))}
            />
            <span className={meshGeoipAuto ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'}>
              Auto GeoIP from egress
            </span>
          </label>
          <label className="flex items-center gap-2 text-base">
            <input
              type="checkbox"
              checked={meshCurrencyOracle}
              className="accent-[var(--color-accent)]"
              onChange={(e) => saveSetting(SETTINGS_KEYS.meshCurrencyOracle, String(e.target.checked))}
            />
            <span className={meshCurrencyOracle ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'}>
              Currency Oracle
            </span>
          </label>
        </div>

        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Display Currency</label>
          <select
            value={settings?.[SETTINGS_KEYS.displayCurrency] ?? 'USD'}
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base"
            onChange={(e) => saveSetting(SETTINGS_KEYS.displayCurrency, e.target.value)}
          >
            {AVAILABLE_CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select>
        </div>

        {/* Geo-region overrides */}
        <GeoRegionOverrides settings={settings} saveSetting={saveSetting} />
      </div>

      </div>{/* end left column */}

      {/* Right column */}
      <div className="space-y-6">

      {/* Plan */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
        <h3 className="text-base font-bold text-[var(--color-muted)]">Plan</h3>
        <div className="grid grid-cols-1 gap-2">
          {PLANS.filter((p) => p.value).map((plan) => (
            <div
              key={plan.value}
              onClick={() => saveSetting(SETTINGS_KEYS.plan, plan.value)}
              className={`rounded border p-3 cursor-pointer transition-colors ${
                currentPlan === plan.value
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
                  : 'border-[var(--color-border)] hover:border-[var(--color-muted)]'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className={`text-base font-bold ${currentPlan === plan.value ? 'text-[var(--color-accent)]' : ''}`}>
                  {plan.label}
                </span>
                <div className="flex items-center gap-2">
                  {plan.price && plan.price !== '$0' && (
                    <span className="text-base text-[var(--color-muted)]">{plan.price}</span>
                  )}
                  {currentPlan === plan.value && (
                    <span className="text-base text-[var(--color-accent)] font-bold">current</span>
                  )}
                </div>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                {plan.features.map((f, i) => (
                  <span key={i} className="text-base text-[var(--color-muted)]">{f}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Connection */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-[var(--color-muted)]">Connection</h3>
          <label className="flex items-center gap-2 text-base">
            <input
              type="checkbox"
              checked={firehoseEnabled}
              className="accent-[var(--color-accent)]"
              onChange={(e) =>
                saveSetting(SETTINGS_KEYS.firehoseEnabled, String(e.target.checked))
              }
            />
            <span className={firehoseEnabled ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'}>
              {firehoseEnabled ? 'Connected' : 'Disconnected'}
            </span>
          </label>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-base text-[var(--color-muted)] block mb-1">Endpoint</label>
            <input
              type="url"
              defaultValue={firehoseEndpoint}
              placeholder="https://api.unfirehose.org"
              className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base"
              onBlur={(e) => {
                if (e.target.value && e.target.value !== firehoseEndpoint) {
                  saveSetting(SETTINGS_KEYS.firehoseEndpoint, e.target.value);
                }
              }}
            />
          </div>

          <div>
            <label className="text-base text-[var(--color-muted)] block mb-1">Public Key</label>
            <input
              type="text"
              defaultValue={firehosePublicKey}
              placeholder="unfh-pk-..."
              className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base font-mono"
              onBlur={(e) => {
                if (e.target.value && e.target.value !== firehosePublicKey) {
                  saveSetting(SETTINGS_KEYS.firehosePublicKey, e.target.value);
                }
              }}
            />
          </div>
          <div>
            <label className="text-base text-[var(--color-muted)] block mb-1">Secret Key</label>
            <input
              type="password"
              defaultValue={firehoseKey}
              placeholder="unfh-sk-..."
              className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base font-mono"
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
            <div className="text-base font-bold text-[var(--color-muted)]">Hoses</div>
            <div className="grid grid-cols-2 gap-2">
              <HoseToggle
                label="Social Timeline"
                desc="Posts, status, blogs from network"
                settingKey="unfirehose_hose_social"
                settings={settings}
                onSave={saveSetting}
              />
              <HoseToggle
                label="Project Showcases"
                desc="Ship announcements, repo links"
                settingKey="unfirehose_hose_projects"
                settings={settings}
                onSave={saveSetting}
              />
              <HoseToggle
                label="Thinking Stream"
                desc="Share reasoning with followers"
                settingKey="unfirehose_hose_thinking"
                settings={settings}
                onSave={saveSetting}
              />
            </div>
          </div>
        )}
      </div>

      {/* Git */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
        <h3 className="text-base font-bold text-[var(--color-muted)]">Git</h3>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={(settings?.git_auto_push ?? 'true') !== 'false'}
            onChange={(e) => saveSetting('git_auto_push', e.target.checked ? 'true' : 'false')}
            className="accent-[var(--color-accent)]"
          />
          <span className="text-sm">Auto-push after commit</span>
          <span className="text-xs text-[var(--color-muted)]">When committing from the app, automatically push to remote</span>
        </label>
      </div>

      {/* LLM Providers */}
      <LlmProviders
        endpoint={llmEndpoint}
        apiKey={llmApiKey}
        model={llmModel}
        onSave={saveSetting}
      />

      </div>{/* end right column */}
      </div>{/* end two-column grid */}

      {saving && (
        <div className="text-base text-[var(--color-muted)]">Saving...</div>
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
        <span className={`text-base font-bold ${enabled ? 'text-[var(--color-accent)]' : 'text-[var(--color-foreground)]'}`}>
          {label}
        </span>
        {enabled && <span className="text-[var(--color-accent)] text-base">on</span>}
      </div>
      <div className="text-base text-[var(--color-muted)]">{desc}</div>
    </div>
  );
}

const MESH_PROVIDERS = [
  { value: 'home', label: 'Home ISP' },
  { value: 'colo', label: 'Colocation' },
  { value: 'aws', label: 'AWS' },
  { value: 'gcp', label: 'Google Cloud' },
  { value: 'azure', label: 'Azure' },
  { value: 'hetzner', label: 'Hetzner' },
  { value: 'ovh', label: 'OVH' },
  { value: 'digitalocean', label: 'DigitalOcean' },
  { value: 'vultr', label: 'Vultr' },
  { value: 'linode', label: 'Linode/Akamai' },
  { value: 'oracle', label: 'Oracle Cloud' },
  { value: 'scaleway', label: 'Scaleway' },
  { value: 'unsandbox', label: 'unsandbox.com' },
  { value: 'other', label: 'Other' },
];

const DEFAULT_REGIONS = [
  { key: 'us-east', label: 'US East', electricityKwh: '0.31' },
  { key: 'us-west', label: 'US West', electricityKwh: '0.28' },
  { key: 'us-midwest', label: 'US Midwest', electricityKwh: '0.24' },
  { key: 'us-south', label: 'US South', electricityKwh: '0.22' },
  { key: 'eu-west', label: 'EU West', electricityKwh: '0.45' },
  { key: 'eu-central', label: 'EU Central', electricityKwh: '0.48' },
  { key: 'eu-north', label: 'EU North', electricityKwh: '0.35' },
  { key: 'ap-east', label: 'AP East (Japan/Korea)', electricityKwh: '0.38' },
  { key: 'ap-south', label: 'AP South (India)', electricityKwh: '0.18' },
  { key: 'ap-southeast', label: 'AP Southeast', electricityKwh: '0.25' },
  { key: 'sa-east', label: 'SA East (Brazil)', electricityKwh: '0.26' },
  { key: 'oc', label: 'Oceania (Australia)', electricityKwh: '0.40' },
];

function GeoRegionOverrides({ settings, saveSetting }: {
  settings: Record<string, string> | undefined;
  saveSetting: (key: string, value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-base text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors cursor-pointer"
      >
        {expanded ? '▾' : '▸'} Geo-region electricity overrides
      </button>
      {expanded && (
        <div className="mt-3 grid grid-cols-2 md:grid-cols-3 gap-2">
          {DEFAULT_REGIONS.map(region => {
            const settingKey = `mesh_region_electricity_${region.key}`;
            const current = settings?.[settingKey] ?? region.electricityKwh;
            return (
              <div key={region.key} className="flex items-center gap-2">
                <span className="text-base text-[var(--color-muted)] w-28 truncate">{region.label}</span>
                <div className="flex items-center gap-1">
                  <span className="text-base text-[var(--color-muted)]">$</span>
                  <input
                    type="number"
                    step="0.01"
                    defaultValue={current}
                    className="w-16 bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1 text-base font-mono"
                    onBlur={(e) => {
                      if (e.target.value !== current) saveSetting(settingKey, e.target.value);
                    }}
                  />
                  <span className="text-base text-[var(--color-muted)]">/kWh</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function hexToHue(hex: string): number {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let hue = 0;
  if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) hue = ((b - r) / d + 2) * 60;
  else hue = ((r - g) / d + 4) * 60;
  return Math.round(hue);
}

function HexColorPicker({ value, settingKey }: { value: string; settingKey: string }) {
  const [color, setColor] = useState(value);
  const [hexText, setHexText] = useState(value.replace('#', ''));
  const hexRef = useRef(value.replace('#', ''));
  const { mutate: mutateSettings } = useSWR('/api/settings', fetcher);

  const hue = hexToHue(color);

  function save(hex: string) {
    const clean = hex.startsWith('#') ? hex : '#' + hex;
    setColor(clean);
    setHexText(clean.replace('#', ''));
    hexRef.current = clean.replace('#', '');
    document.documentElement.style.setProperty('--color-accent', clean);
    document.documentElement.style.setProperty('--color-assistant', clean);
    // Optimistic SWR update — prevents ThemeProvider from overwriting with stale value
    // revalidate: false avoids refetch that would cause parent re-render / scroll jump
    mutateSettings((prev: Record<string, string> | undefined) => ({ ...prev, [settingKey]: clean }), { revalidate: false });
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set', key: settingKey, value: clean }),
    });
  }

  function tryCommit(text: string) {
    const clean = text.replace(/[^0-9a-fA-F]/g, '');
    if (clean.length === 6) {
      save('#' + clean.toLowerCase());
    } else if (clean.length === 3) {
      save('#' + clean.split('').map(c => c + c).join('').toLowerCase());
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg border border-[var(--color-border)]" style={{ backgroundColor: color }} />
        <div className="flex items-center gap-1">
          <span className="text-base text-[var(--color-muted)]">#</span>
          <input
            type="text"
            value={hexText}
            onChange={(e) => {
              const v = e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
              setHexText(v);
              hexRef.current = v;
            }}
            onBlur={() => tryCommit(hexRef.current)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') tryCommit(hexRef.current);
            }}
            className="w-24 bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1.5 text-base font-mono"
            maxLength={6}
            spellCheck={false}
          />
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={360}
        value={hue}
        onChange={(e) => save(hslToHex(Number(e.target.value), 0.7, 0.55))}
        className="w-full h-3 rounded-full appearance-none cursor-pointer"
        style={{
          background: 'linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
        }}
      />
    </div>
  );
}

function LlmProviders({
  endpoint,
  apiKey,
  model,
  onSave,
}: {
  endpoint: string;
  apiKey: string;
  model: string;
  onSave: (key: string, value: string) => void;
}) {
  const { data: providerData } = useSWR('/api/llm/providers', fetcher);
  const detected = providerData?.providers ?? [];
  const hasCustom = !!endpoint || !!apiKey;
  const [showCustom, setShowCustom] = useState(hasCustom);

  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
      <h3 className="text-base font-bold text-[var(--color-muted)]">LLM Providers</h3>
      <p className="text-base text-[var(--color-muted)]">
        Used for generating commit messages from diffs. Auto-detects OAuth tokens on the filesystem,
        or add your own OpenAI-compatible endpoint.
      </p>

      {/* Auto-detected providers */}
      {detected.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-bold text-[var(--color-muted)] uppercase tracking-wider">Auto-detected</div>
          {detected.filter((p: any) => p.source === 'filesystem').map((p: any) => (
            <div
              key={p.id}
              className={`rounded border p-3 ${
                p.ready
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
                  : 'border-[var(--color-border)] opacity-60'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${p.ready ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-error)]'}`} />
                <span className="text-base font-bold">{p.name}</span>
                <span className="text-xs text-[var(--color-muted)] ml-auto font-mono">{p.model}</span>
              </div>
              {p.detail && (
                <div className="text-xs text-[var(--color-muted)] mt-1">{p.detail}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {detected.length === 0 && !hasCustom && (
        <div className="text-base text-[var(--color-muted)] py-2">
          No providers detected. Sign in to Claude Code Max, or add a custom endpoint below.
        </div>
      )}

      {/* Custom provider */}
      <div>
        {!showCustom ? (
          <button
            onClick={() => setShowCustom(true)}
            className="text-base text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors cursor-pointer"
          >
            + Add custom provider
          </button>
        ) : (
          <div className="space-y-3 border border-[var(--color-border)] rounded p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[var(--color-muted)] uppercase tracking-wider">Custom Provider</span>
              {!hasCustom && (
                <button
                  onClick={() => setShowCustom(false)}
                  className="text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)] cursor-pointer"
                >
                  Cancel
                </button>
              )}
            </div>
            <div>
              <label className="text-base text-[var(--color-muted)] block mb-1">Endpoint</label>
              <input
                type="url"
                defaultValue={endpoint}
                placeholder="https://api.openai.com/v1/chat/completions"
                className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base font-mono"
                onBlur={(e) => {
                  if (e.target.value !== endpoint) onSave('llm_commit_endpoint', e.target.value);
                }}
              />
            </div>
            <div>
              <label className="text-base text-[var(--color-muted)] block mb-1">API Key</label>
              <input
                type="password"
                defaultValue={apiKey}
                placeholder="sk-..."
                className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base font-mono"
                onBlur={(e) => {
                  if (e.target.value !== apiKey) onSave('llm_commit_api_key', e.target.value);
                }}
              />
              <span className="text-xs text-[var(--color-muted)]">Not needed for localhost endpoints</span>
            </div>
            <div>
              <label className="text-base text-[var(--color-muted)] block mb-1">Model</label>
              <input
                type="text"
                defaultValue={model}
                placeholder="gpt-4o-mini"
                className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base font-mono"
                onBlur={(e) => {
                  if (e.target.value !== model) onSave('llm_commit_model', e.target.value);
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
