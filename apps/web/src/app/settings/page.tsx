'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import useSWR from 'swr';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import { AVAILABLE_CURRENCIES } from '@unturf/unfirehose-ui/useCurrency';
import { useVault } from '@unturf/unfirehose-ui/VaultProvider';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const STRIPE_LINKS: Record<string, string> = {
  // Starter
  starter_monthly: 'https://buy.stripe.com/starter_monthly',
  starter_1yr: 'https://buy.stripe.com/starter_1yr',
  starter_2yr: 'https://buy.stripe.com/starter_2yr',
  starter_3yr: 'https://buy.stripe.com/starter_3yr',
  // Team
  team_monthly: 'https://buy.stripe.com/team_monthly',
  team_1yr: 'https://buy.stripe.com/team_1yr',
  team_2yr: 'https://buy.stripe.com/team_2yr',
  team_3yr: 'https://buy.stripe.com/team_3yr',
};

const BILLING_OPTIONS = [
  { key: 'monthly', label: 'Monthly', discount: 0 },
  { key: '1yr', label: '1 Year', discount: 14 },
  { key: '2yr', label: '2 Year', discount: 28 },
  { key: '3yr', label: '3 Year', discount: 42 },
] as const;

function calcPrice(monthlyRate: number, period: typeof BILLING_OPTIONS[number]): string {
  const months = period.key === 'monthly' ? 1 : period.key === '1yr' ? 12 : period.key === '2yr' ? 24 : 36;
  if (months === 1) return `$${monthlyRate}/mo`;
  const total = Math.round(monthlyRate * months * (1 - period.discount / 100));
  return `$${total.toLocaleString()}`;
}

function calcMonthly(monthlyRate: number, period: typeof BILLING_OPTIONS[number]): string | null {
  const months = period.key === 'monthly' ? 1 : period.key === '1yr' ? 12 : period.key === '2yr' ? 24 : 36;
  if (months === 1) return null;
  const total = Math.round(monthlyRate * months * (1 - period.discount / 100));
  return `$${(total / months).toFixed(0)}/mo`;
}

const PLANS = [
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
    monthlyRate: 0,
  },
  {
    value: 'starter',
    label: 'Starter',
    features: [
      'Everything in Free',
      'Scrobble feed (unlimited history)',
      'Status posts & microblog',
      'API access + 1 custom hose',
    ],
    monthlyRate: 14,
  },
  {
    value: 'team',
    label: 'Team',
    features: [
      'Everything in Starter',
      'Unlimited seats',
      'Shared team dashboard',
      'Org-wide analytics & usage',
      'SSO & role management',
      'Priority support & SLA',
    ],
    monthlyRate: 420,
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
  // Training
  trainingScanRemote: 'training_scan_remote',
  trainingDeleteSource: 'training_delete_source',
  trainingAutoScan: 'training_auto_scan',
  trainingScanPaths: 'training_scan_paths',
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

  /* eslint-disable react-hooks/set-state-in-effect -- sync from localStorage on mount */
  useEffect(() => {
    const saved = localStorage.getItem('unfirehose_light_mode');
    if (saved === 'true') {
      setLightMode(true);
      document.documentElement.classList.add('light');
      document.documentElement.classList.remove('dark');
    }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

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

  // LLM commit message generation — endpoints/models in SQLite, keys in vault
  const llmEndpoint = settings?.llm_commit_endpoint ?? '';
  const llmModel = settings?.llm_commit_model ?? '';

  // Mesh defaults
  const meshDefaultIspCost = settings?.[SETTINGS_KEYS.meshDefaultIspCost] ?? '110';
  const meshDefaultElectricity = settings?.[SETTINGS_KEYS.meshDefaultElectricity] ?? '0.12';
  const meshDefaultProvider = settings?.[SETTINGS_KEYS.meshDefaultProvider] ?? 'home';
  const meshDefaultLinkMbps = settings?.[SETTINGS_KEYS.meshDefaultLinkMbps] ?? '100';
  const meshCurrencyOracle = settings?.[SETTINGS_KEYS.meshCurrencyOracle] !== 'false';
  const meshGeoipAuto = settings?.[SETTINGS_KEYS.meshGeoipAuto] !== 'false';

  // Training defaults
  const trainingScanRemote = settings?.[SETTINGS_KEYS.trainingScanRemote] !== 'false'; // default: true
  const trainingDeleteSource = settings?.[SETTINGS_KEYS.trainingDeleteSource] === 'true'; // default: false
  const trainingAutoScan = settings?.[SETTINGS_KEYS.trainingAutoScan] === 'true'; // default: false
  const trainingScanPaths = settings?.[SETTINGS_KEYS.trainingScanPaths] ??
    '.unfirehose/training/*.jsonl\ngit/uncloseai-cli/checkpoints/cuda/*.loss.json\n.uncloseai/sessions/*/*.jsonl\n.uncloseai/todos/*.json\n.agnt/data/_logs/*.log\n.unfirehose/triage.jsonl';

  const TABS = ['General', 'Appearance', 'Mesh', 'Training', 'Connection', 'API Keys'] as const;
  type SettingsTab = (typeof TABS)[number];
  const [activeTab, setActiveTabRaw] = useState<SettingsTab>(() => {
    if (typeof window !== 'undefined') {
      const hash = window.location.hash.slice(1);
      if (TABS.includes(hash as SettingsTab)) return hash as SettingsTab;
    }
    return 'General';
  });
  const setActiveTab = (tab: SettingsTab) => { setActiveTabRaw(tab); };
  useEffect(() => { window.location.hash = activeTab; }, [activeTab]);
  const vault = useVault();

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

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--color-border)]">
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer -mb-px ${
              activeTab === tab
                ? 'border-b-2 border-[var(--color-accent)] text-[var(--color-accent)]'
                : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
            }`}
          >
            {tab === 'API Keys' && !vault.unlocked ? '\u{1F510} ' : ''}{tab}
          </button>
        ))}
      </div>

      {/* ===== GENERAL TAB ===== */}
      {activeTab === 'General' && (
        <div className="space-y-6">
          {/* Profile + Plan — 2 column */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Profile */}
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
              <h3 className="text-base font-bold text-[var(--color-muted)]">Profile</h3>
              <div className="grid grid-cols-2 gap-3">
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

            {/* Plan */}
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
              <h3 className="text-base font-bold text-[var(--color-muted)]">Plan</h3>
              <p className="text-sm text-[var(--color-muted)]">
                Pre-order for the upcoming unfirehose cloud offering. Your data stays local — the cloud adds sync, team features, and hosted scrobble feeds. Currently being grown and secured.
              </p>
              <div className="grid grid-cols-1 gap-3">
                {PLANS.map((plan) => (
                  <div
                    key={plan.value}
                    onClick={() => plan.monthlyRate === 0 ? saveSetting(SETTINGS_KEYS.plan, plan.value) : undefined}
                    className={`rounded border p-3 transition-colors ${
                      plan.monthlyRate === 0 ? 'cursor-pointer' : ''
                    } ${
                      currentPlan === plan.value
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
                        : 'border-[var(--color-border)] hover:border-[var(--color-muted)]'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className={`text-base font-bold ${currentPlan === plan.value ? 'text-[var(--color-accent)]' : ''}`}>
                        {plan.label}{plan.monthlyRate > 0 ? ` — $${plan.monthlyRate}/mo` : ''}
                      </span>
                      {currentPlan === plan.value && (
                        <span className="text-base text-[var(--color-accent)] font-bold">current</span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                      {plan.features.map((f, i) => (
                        <span key={i} className="text-base text-[var(--color-muted)]">{f}</span>
                      ))}
                    </div>
                    {plan.monthlyRate > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {BILLING_OPTIONS.map((period) => (
                          <a
                            key={period.key}
                            href={STRIPE_LINKS[`${plan.value}_${period.key}`]}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex flex-col items-center px-3 py-2 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors text-sm"
                          >
                            <span className="font-bold text-[var(--color-foreground)]">{calcPrice(plan.monthlyRate, period)}</span>
                            <span className="text-[var(--color-muted)] text-xs">{period.label}</span>
                            {period.discount > 0 && (
                              <span className="text-[var(--color-accent)] text-xs font-bold">{period.discount}% off</span>
                            )}
                            {calcMonthly(plan.monthlyRate, period) && (
                              <span className="text-[var(--color-muted)] text-xs">{calcMonthly(plan.monthlyRate, period)}</span>
                            )}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Local Data + Git — 2 column */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
              <h3 className="text-base font-bold text-[var(--color-muted)]">Local Data</h3>
              <div className="text-base text-[var(--color-muted)] space-y-1">
                <div>Database: <span className="text-[var(--color-foreground)] font-mono">~/.unfirehose/unfirehose.db</span></div>
                <div>Sessions: <span className="text-[var(--color-foreground)] font-mono">~/.claude/projects/</span></div>
              </div>
            </div>

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
          </div>
        </div>
      )}

      {/* ===== APPEARANCE TAB ===== */}
      {activeTab === 'Appearance' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
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

            <CurrencyPicker
              selected={(settings?.[SETTINGS_KEYS.displayCurrency] ?? 'USD').split(',').filter(Boolean)}
              onChange={(codes) => saveSetting(SETTINGS_KEYS.displayCurrency, codes.join(','))}
            />
          </div>
        </div>
      )}

      {/* ===== MESH TAB ===== */}
      {activeTab === 'Mesh' && (
        <div className="space-y-6">
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

            <GeoRegionOverrides settings={settings} saveSetting={saveSetting} />
          </div>
        </div>
      )}

      {/* ===== TRAINING TAB ===== */}
      {activeTab === 'Training' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-6">
            {/* Scan behavior */}
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
              <h3 className="text-base font-bold">Scan Behavior</h3>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={trainingScanRemote}
                  onChange={(e) => saveSetting(SETTINGS_KEYS.trainingScanRemote, String(e.target.checked))}
                  className="accent-[var(--color-accent)]"
                />
                <div>
                  <div className="text-base font-medium">Scan remote nodes</div>
                  <div className="text-sm text-[var(--color-muted)]">SSH into mesh nodes to discover training data</div>
                </div>
              </label>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={trainingAutoScan}
                  onChange={(e) => saveSetting(SETTINGS_KEYS.trainingAutoScan, String(e.target.checked))}
                  className="accent-[var(--color-accent)]"
                />
                <div>
                  <div className="text-base font-medium">Auto-scan on page load</div>
                  <div className="text-sm text-[var(--color-muted)]">Automatically scan for new training data when opening /training</div>
                </div>
              </label>
            </div>

            {/* Delete behavior */}
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
              <h3 className="text-base font-bold">Delete Behavior</h3>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={trainingDeleteSource}
                  onChange={(e) => saveSetting(SETTINGS_KEYS.trainingDeleteSource, String(e.target.checked))}
                  className="accent-[var(--color-accent)]"
                />
                <div>
                  <div className="text-base font-medium">Delete source files on remove</div>
                  <div className="text-sm text-[var(--color-muted)]">When deleting a run, also remove the .loss.json and .samples.json files from the source host</div>
                </div>
              </label>

              <div className="rounded border border-[var(--color-border)] p-3 text-sm" style={{ backgroundColor: 'var(--color-background)' }}>
                <div className="text-[var(--color-muted)] mb-1">Default behavior</div>
                <div>Deleted runs are <strong>soft-deleted</strong> — metadata is preserved but hidden from the UI. Subsequent scans will not re-ingest soft-deleted runs.</div>
              </div>
            </div>
          </div>

          {/* Scan paths */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
            <h3 className="text-base font-bold">Scan Paths</h3>
            <p className="text-sm text-[var(--color-muted)]">
              Paths relative to home directory, one per line. Supports glob patterns. Scanned on both local and remote nodes.
            </p>
            <textarea
              defaultValue={trainingScanPaths}
              rows={4}
              className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 font-mono text-sm"
              onBlur={(e) => {
                if (e.target.value !== trainingScanPaths) {
                  saveSetting(SETTINGS_KEYS.trainingScanPaths, e.target.value);
                }
              }}
            />
          </div>

          {/* Info */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-2">
            <h3 className="text-base font-bold">How It Works</h3>
            <ul className="text-sm text-[var(--color-muted)] space-y-1 list-disc list-inside">
              <li>Each training run gets a UUIDv7 for stable identity across re-scans</li>
              <li>Runs are identified by <code className="font-mono text-xs px-1 py-0.5 rounded" style={{ backgroundColor: 'var(--color-background)' }}>host/model-name</code> — duplicate files won&apos;t create duplicate runs</li>
              <li>Soft-deleted runs are permanently hidden from scans — they won&apos;t come back</li>
              <li>Supported formats: <code className="font-mono text-xs">.loss.json</code> (step/loss arrays), <code className="font-mono text-xs">.samples.json</code> (training samples), <code className="font-mono text-xs">.jsonl</code> (unfirehose events)</li>
            </ul>
          </div>
        </div>
      )}

      {/* ===== CONNECTION TAB ===== */}
      {activeTab === 'Connection' && (
        <div className="space-y-6">
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
              <div className="grid grid-cols-2 gap-3">
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
        </div>
      )}

      {/* ===== API KEYS TAB ===== */}
      {activeTab === 'API Keys' && (
        <div className="space-y-6">
          {!vault.unlocked ? (
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-8 text-center space-y-4">
              <div className="text-4xl">{'\u{1F510}'}</div>
              <h3 className="text-lg font-bold">Vault Locked</h3>
              <p className="text-sm text-[var(--color-muted)]">
                Unlock your vault to view and manage API keys. Keys are encrypted in your browser and never sent to the server.
              </p>
              <VaultUnlockInline />
            </div>
          ) : (
            <LlmProviders
              endpoint={llmEndpoint}
              model={llmModel}
              onSave={saveSetting}
            />
          )}
        </div>
      )}

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

const RED_PRESETS = [
  { label: 'unfirehose', hex: '#d40000', desc: 'Deep vermilion — our pivot' },
  { label: 'Netflix', hex: '#e50914', desc: 'Streaming red' },
  { label: 'YouTube', hex: '#ff0000', desc: 'Pure saturated' },
  { label: 'Oxblood', hex: '#800020', desc: 'Dark, luxurious' },
  { label: 'Crimson', hex: '#dc143c', desc: 'Classic warm red' },
  { label: 'Brick', hex: '#cb4154', desc: 'Earthy, grounded' },
];

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
          background: `linear-gradient(to right, ${Array.from({ length: 13 }, (_, i) => hslToHex(i * 30, 0.7, 0.55)).join(', ')})`,
        }}
      />
      {/* Brand red presets */}
      <div className="space-y-2">
        <span className="text-sm text-[var(--color-muted)]">Brand reds</span>
        <div className="flex flex-wrap gap-2">
          {RED_PRESETS.map((p) => (
            <button
              key={p.hex}
              onClick={() => save(p.hex)}
              title={`${p.label} — ${p.desc}`}
              className={`flex items-center gap-1.5 px-2 py-1 rounded border text-sm cursor-pointer transition-colors ${
                color.toLowerCase() === p.hex.toLowerCase()
                  ? 'border-[var(--color-accent)] text-[var(--color-foreground)]'
                  : 'border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-accent)]'
              }`}
            >
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: p.hex }} />
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {/* Tonal scale preview */}
      <div className="space-y-2">
        <span className="text-sm text-[var(--color-muted)]">Tonal scale</span>
        <div className="flex gap-0.5 rounded overflow-hidden">
          {[
            ['50', 'var(--color-red-50)'],
            ['100', 'var(--color-red-100)'],
            ['200', 'var(--color-red-200)'],
            ['300', 'var(--color-red-300)'],
            ['400', 'var(--color-red-400)'],
            ['500', 'var(--color-red-500)'],
            ['600', 'var(--color-red-600)'],
            ['700', 'var(--color-red-700)'],
            ['800', 'var(--color-red-800)'],
            ['900', 'var(--color-red-900)'],
            ['950', 'var(--color-red-950)'],
          ].map(([step, cssVar]) => (
            <div key={step} className="flex-1 text-center" title={`red-${step}`}>
              <div className="h-6" style={{ backgroundColor: cssVar }} />
              <div className="text-xs text-[var(--color-muted)] mt-0.5">{step}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const PROVIDER_PRESETS = [
  { id: 'anthropic', name: 'Anthropic', endpoint: 'https://api.anthropic.com/v1/messages', type: 'anthropic' as const, placeholder: 'sk-ant-...', defaultModel: 'claude-haiku-4-5-20251001', models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'] },
  { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', type: 'openai-compatible' as const, placeholder: 'sk-...', defaultModel: 'gpt-4o-mini', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-mini', 'o3-mini'] },
  { id: 'google', name: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', type: 'openai-compatible' as const, placeholder: 'AIza...', defaultModel: 'gemini-2.5-flash', models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
  { id: 'groq', name: 'Groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', type: 'openai-compatible' as const, placeholder: 'gsk_...', defaultModel: 'llama-3.3-70b-versatile', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'] },
  { id: 'together', name: 'Together', endpoint: 'https://api.together.xyz/v1/chat/completions', type: 'openai-compatible' as const, placeholder: 'tok_...', defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-Coder-32B-Instruct'] },
  { id: 'deepseek', name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1/chat/completions', type: 'openai-compatible' as const, placeholder: 'sk-...', defaultModel: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner'] },
  { id: 'ollama', name: 'Ollama (local)', endpoint: 'http://localhost:11434/v1/chat/completions', type: 'openai-compatible' as const, placeholder: '', defaultModel: 'llama3.1:8b', models: [] },
  { id: 'custom', name: 'Custom endpoint', endpoint: '', type: 'openai-compatible' as const, placeholder: 'sk-...', defaultModel: '', models: [] },
];

function VaultUnlockInline() {
  const vault = useVault();
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const isNew = !vault.exists;

  async function submit() {
    setError('');
    if (isNew && pw.length < 8) { setError('Password must be at least 8 characters'); return; }
    if (!pw) { setError('Enter a password'); return; }
    setLoading(true);
    try {
      if (isNew) { await vault.create(pw); }
      else {
        const ok = await vault.unlock(pw);
        if (!ok) setError('Wrong password');
      }
    } catch { setError('Something went wrong'); }
    setLoading(false);
  }

  return (
    <div className="max-w-xs mx-auto space-y-3">
      <input
        type="password"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        placeholder={isNew ? 'Choose a password (8+ chars)' : 'Vault password'}
        autoFocus
        className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded-lg px-4 py-3 text-base text-center focus:outline-none focus:border-[var(--color-accent)]"
      />
      {error && <div className="text-sm text-[var(--color-error)]">{error}</div>}
      <button
        onClick={submit}
        disabled={loading}
        className="w-full px-4 py-2 text-sm font-bold bg-[var(--color-accent)] text-[var(--color-background)] rounded-lg hover:opacity-90 transition-opacity disabled:opacity-40 cursor-pointer"
      >
        {loading ? 'Working...' : isNew ? 'Create Vault' : 'Unlock'}
      </button>
    </div>
  );
}

// Secret fallback providers — hidden from UI
const SECRET_PROVIDER_IDS = ['qwen-mesh', 'hermes-mesh'];

function LlmProviders({
  endpoint,
  model,
  onSave,
}: {
  endpoint: string;
  model: string;
  onSave: (key: string, value: string) => void;
}) {
  const vault = useVault();
  const { data: providerData } = useSWR('/api/llm/providers', fetcher);
  const detected = providerData?.providers ?? [];

  // Determine which preset matches current config
  const activePreset = PROVIDER_PRESETS.find(p => p.endpoint && endpoint === p.endpoint)?.id
    ?? (endpoint ? 'custom' : '');
  const [selectedPreset, setSelectedPreset] = useState(activePreset);
  const [editEndpoint, setEditEndpoint] = useState(endpoint);
  const [editModel, setEditModel] = useState(model);

  // API key comes from vault, keyed by provider preset id
  const vaultKeyId = selectedPreset || 'custom';
  const editKey = vault.getKey(vaultKeyId);

  function selectPreset(presetId: string) {
    setSelectedPreset(presetId);
    const preset = PROVIDER_PRESETS.find(p => p.id === presetId);
    if (!preset) return;
    if (preset.endpoint) {
      setEditEndpoint(preset.endpoint);
      onSave('llm_commit_endpoint', preset.endpoint);
    }
    if (preset.defaultModel && !editModel) {
      setEditModel(preset.defaultModel);
      onSave('llm_commit_model', preset.defaultModel);
    }
    // Store preferred provider in vault
    vault.setPreferred(presetId);
  }

  function clearProvider() {
    setSelectedPreset('');
    setEditEndpoint('');
    setEditModel('');
    onSave('llm_commit_endpoint', '');
    onSave('llm_commit_model', '');
    if (vaultKeyId) vault.removeKey(vaultKeyId);
  }

  const currentPreset = PROVIDER_PRESETS.find(p => p.id === selectedPreset);
  const isLocal = editEndpoint.includes('localhost') || editEndpoint.includes('127.0.0.1');

  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
      <h3 className="text-base font-bold text-[var(--color-muted)]">LLM Providers</h3>
      <p className="text-xs text-[var(--color-muted)]">
        Used for commit message generation, code suggestions, and more. Configure your own keys or use auto-detected providers.
        Priority: your keys &gt; Claude Max OAuth &gt; mesh fallbacks.
      </p>

      {/* Vault status */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-[var(--color-accent)]">{'\u{1F513}'} Vault unlocked — keys encrypted in browser</span>
        <button
          onClick={vault.lock}
          className="text-xs text-[var(--color-muted)] hover:text-[var(--color-error)] cursor-pointer"
        >
          Lock vault
        </button>
      </div>

      {/* Auto-detected providers */}
      {detected.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-bold text-[var(--color-muted)] uppercase tracking-wider">Auto-detected</div>
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {detected.filter((p: any) => p.source === 'filesystem' && !SECRET_PROVIDER_IDS.includes(p.id)).map((p: any) => (
            <div
              key={p.id}
              className={`rounded border p-3 ${
                p.ready
                  ? 'border-[var(--color-accent)]/30 bg-[var(--color-accent)]/5'
                  : 'border-[var(--color-border)] opacity-60'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${p.ready ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-error)]'}`} />
                <span className="text-sm font-bold">{p.name}</span>
                <span className="text-xs text-[var(--color-muted)] ml-auto font-mono">{p.model}</span>
              </div>
              {p.detail && (
                <div className="text-xs text-[var(--color-muted)] mt-1">{p.detail}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Provider picker */}
      <div className="space-y-3">
        <div className="text-xs font-bold text-[var(--color-muted)] uppercase tracking-wider">Bring your own keys</div>
        <div className="grid grid-cols-4 gap-2">
          {PROVIDER_PRESETS.map(p => (
            <button
              key={p.id}
              onClick={() => selectPreset(p.id)}
              className={`px-2 py-1.5 text-xs rounded border cursor-pointer transition-colors ${
                selectedPreset === p.id
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-foreground)] font-bold'
                  : 'border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:border-[var(--color-accent)]/30'
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>

        {selectedPreset && currentPreset && (
          <div className="space-y-3 border border-[var(--color-border)] rounded p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[var(--color-muted)]">{currentPreset.name}</span>
              <button onClick={clearProvider} className="text-xs text-[var(--color-muted)] hover:text-[var(--color-error)] cursor-pointer">
                Clear
              </button>
            </div>

            {/* Endpoint — editable for custom, read-only for presets */}
            {selectedPreset === 'custom' ? (
              <div>
                <label className="text-xs text-[var(--color-muted)] block mb-1">Endpoint</label>
                <input
                  type="url"
                  value={editEndpoint}
                  onChange={(e) => setEditEndpoint(e.target.value)}
                  placeholder="https://your-api.com/v1/chat/completions"
                  className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-sm font-mono"
                  onBlur={() => onSave('llm_commit_endpoint', editEndpoint)}
                />
              </div>
            ) : (
              <div className="text-xs font-mono text-[var(--color-muted)] truncate">{currentPreset.endpoint}</div>
            )}

            {/* API Key — stored in encrypted browser vault */}
            {!isLocal && (
              <div>
                <label className="text-xs text-[var(--color-muted)] block mb-1">API Key <span className="text-xs text-[var(--color-muted)]">(encrypted in browser)</span></label>
                <input
                  type="password"
                  defaultValue={editKey}
                  placeholder={currentPreset.placeholder || 'sk-...'}
                  className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-sm font-mono"
                  onBlur={(e) => {
                    const val = e.target.value;
                    if (val !== editKey) vault.setKey(vaultKeyId, val);
                  }}
                />
              </div>
            )}

            {/* Model */}
            <div>
              <label className="text-xs text-[var(--color-muted)] block mb-1">Model</label>
              {currentPreset.models.length > 0 ? (
                <select
                  value={editModel || currentPreset.defaultModel}
                  onChange={(e) => { setEditModel(e.target.value); onSave('llm_commit_model', e.target.value); }}
                  className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-sm font-mono"
                >
                  {currentPreset.models.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={editModel}
                  onChange={(e) => setEditModel(e.target.value)}
                  placeholder={currentPreset.defaultModel || 'model-name'}
                  className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-sm font-mono"
                  onBlur={() => onSave('llm_commit_model', editModel)}
                />
              )}
            </div>

            {isLocal && (
              <div className="text-xs text-[var(--color-muted)]">No API key needed for local endpoints</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CurrencyPicker({ selected, onChange }: { selected: string[]; onChange: (codes: string[]) => void }) {
  const groups = new Map<string, typeof AVAILABLE_CURRENCIES>();
  for (const c of AVAILABLE_CURRENCIES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = (c as any).group || 'Other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(c);
  }

  const toggle = (code: string) => {
    if (selected.includes(code)) {
      if (selected.length === 1) return;
      onChange(selected.filter(c => c !== code));
    } else {
      onChange([...selected, code]);
    }
  };

  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
      <label className="text-base font-bold text-[var(--color-muted)] block">Display Currencies</label>
      <div className="flex flex-wrap gap-1">
        {selected.map(code => (
          <span key={code} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[var(--color-accent)]/20 text-[var(--color-accent)] text-sm font-mono">
            {code}
            {selected.length > 1 && (
              <button onClick={() => toggle(code)} className="hover:text-[var(--color-error)] cursor-pointer text-xs">&times;</button>
            )}
          </span>
        ))}
      </div>
      <div className="space-y-3">
          {[...groups.entries()].map(([group, currencies]) => (
            <div key={group}>
              <div className="text-xs font-bold text-[var(--color-muted)] uppercase mb-1">{group}</div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-0.5">
                {currencies.map(c => (
                  <label key={c.code} className="flex items-center gap-2 text-sm cursor-pointer py-0.5 hover:text-[var(--color-foreground)]">
                    <input
                      type="checkbox"
                      checked={selected.includes(c.code)}
                      onChange={() => toggle(c.code)}
                      className="accent-[var(--color-accent)]"
                    />
                    <span className="font-mono text-xs w-8">{c.code}</span>
                    <span className="text-[var(--color-muted)]">{c.label}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
