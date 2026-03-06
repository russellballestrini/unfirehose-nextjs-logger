'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import useSWR from 'swr';
import { PageContext } from '@unfirehose/ui/PageContext';
import { useSearchParams, useRouter } from 'next/navigation';

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
  bootDefaultHost: 'boot_default_host',
  bootStrategy: 'boot_strategy',
  unsandboxPublicKey: 'unsandbox_public_key',
  unsandboxSecretKey: 'unsandbox_secret_key',
  unsandboxEnabled: 'unsandbox_enabled',
};

const BOOT_STRATEGIES = [
  { value: 'default', label: 'Default Host', desc: 'Always use the configured default host' },
  { value: 'least-loaded', label: 'Least Loaded', desc: 'Pick the mesh node with lowest load average' },
  { value: 'round-robin', label: 'Round Robin', desc: 'Rotate across available mesh nodes' },
];

const TABS = [
  { id: 'settings', label: 'Settings', icon: '⚙' },
  { id: 'bootstrap', label: 'Bootstrap', icon: '⚡' },
] as const;

type TabId = typeof TABS[number]['id'];

export default function SettingsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const activeTab = (searchParams.get('tab') as TabId) || 'settings';

  const setTab = (tab: TabId) => {
    router.replace(`/settings?tab=${tab}`, { scroll: false });
  };

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

      <div className="flex items-center gap-1">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setTab(tab.id)}
            className={`px-4 py-2 text-base font-bold rounded-t border transition-colors cursor-pointer ${
              activeTab === tab.id
                ? 'border-[var(--color-border)] border-b-transparent bg-[var(--color-surface)] text-[var(--color-foreground)]'
                : 'border-transparent text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
            }`}
          >
            <span className={activeTab === tab.id ? 'text-[var(--color-accent)]' : 'text-[var(--color-border)]'}>{tab.icon}</span>
            <span className="ml-2">{tab.label}</span>
          </button>
        ))}
      </div>

      {toast && (
        <div className="fixed top-4 right-4 bg-[var(--color-accent)] text-black px-4 py-2 rounded text-base font-bold z-50">
          {toast}
        </div>
      )}

      {activeTab === 'bootstrap' && <BootstrapTab />}

      {activeTab === 'settings' && <>
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

      {/* Compute / Boot */}
      <ComputeSettings settings={settings} onSave={saveSetting} />

      {/* Data & Storage */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
        <h3 className="text-base font-bold text-[var(--color-muted)]">Local Data</h3>
        <div className="text-base text-[var(--color-muted)] space-y-1">
          <div>Database: <span className="text-[var(--color-foreground)] font-mono">~/.claude/unfirehose.db</span></div>
          <div>Sessions: <span className="text-[var(--color-foreground)] font-mono">~/.claude/projects/</span></div>
        </div>
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

      </div>{/* end right column */}
      </div>{/* end two-column grid */}

      {/* Bootstrap Harness — full width */}
      <BootstrapPanel />

      {saving && (
        <div className="text-base text-[var(--color-muted)]">Saving...</div>
      )}
      </>}
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

function ComputeSettings({
  settings,
  onSave,
}: {
  settings: Record<string, string> | undefined;
  onSave: (key: string, value: string) => void;
}) {
  const defaultHost = settings?.[SETTINGS_KEYS.bootDefaultHost] ?? 'localhost';
  const strategy = settings?.[SETTINGS_KEYS.bootStrategy] ?? 'default';
  const { data: mesh } = useSWR('/api/mesh', fetcher);

  const nodes: { hostname: string; reachable: boolean; claudeProcesses?: number; loadAvg?: number[] }[] = mesh?.nodes ?? [];

  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
      <h3 className="text-base font-bold text-[var(--color-muted)]">Compute</h3>
      <p className="text-base text-[var(--color-muted)]">
        Where &quot;Start Now&quot; boots Claude agents. Defaults to localhost unless overridden.
      </p>

      <div>
        <label className="text-base text-[var(--color-muted)] block mb-1">Default Host</label>
        <div className="flex gap-2 flex-wrap">
          {['localhost', ...nodes.filter(n => n.hostname !== 'localhost' && n.hostname !== mesh?.nodes?.[0]?.hostname).map((n: { hostname: string }) => n.hostname)].map((h) => {
            const node = nodes.find((n: { hostname: string }) => n.hostname === h || (h === 'localhost' && n.hostname === nodes[0]?.hostname));
            const isSelected = defaultHost === h;
            const isReachable = h === 'localhost' || node?.reachable;
            return (
              <button
                key={h}
                onClick={() => onSave(SETTINGS_KEYS.bootDefaultHost, h)}
                className={`px-3 py-1.5 text-sm rounded border transition-colors cursor-pointer ${
                  isSelected
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-bold'
                    : isReachable
                      ? 'border-[var(--color-border)] hover:border-[var(--color-muted)] text-[var(--color-foreground)]'
                      : 'border-[var(--color-border)] text-[var(--color-muted)] opacity-50'
                }`}
              >
                {h}
                {node?.claudeProcesses !== undefined && (
                  <span className="ml-1.5 text-xs text-[var(--color-muted)]">
                    ({node.claudeProcesses} claude{node.claudeProcesses !== 1 ? 's' : ''})
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="mt-2">
          <input
            type="text"
            defaultValue={defaultHost !== 'localhost' ? defaultHost : ''}
            placeholder="Or enter a custom SSH host..."
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base font-mono"
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== defaultHost) onSave(SETTINGS_KEYS.bootDefaultHost, v);
              if (!v && defaultHost !== 'localhost') onSave(SETTINGS_KEYS.bootDefaultHost, 'localhost');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
        </div>
      </div>

      <div>
        <label className="text-base text-[var(--color-muted)] block mb-1">Strategy</label>
        <div className="space-y-1.5">
          {BOOT_STRATEGIES.map((s) => (
            <div
              key={s.value}
              onClick={() => onSave(SETTINGS_KEYS.bootStrategy, s.value)}
              className={`rounded border p-2 cursor-pointer transition-colors ${
                strategy === s.value
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
                  : 'border-[var(--color-border)] hover:border-[var(--color-muted)]'
              }`}
            >
              <span className={`text-base font-bold ${strategy === s.value ? 'text-[var(--color-accent)]' : ''}`}>
                {s.label}
              </span>
              <span className="text-base text-[var(--color-muted)] ml-2">{s.desc}</span>
            </div>
          ))}
        </div>
      </div>

      {nodes.length > 1 && (
        <div className="text-base text-[var(--color-muted)]">
          {nodes.filter((n: { reachable: boolean }) => n.reachable).length} of {nodes.length} mesh nodes reachable
        </div>
      )}
    </div>
  );
}

const HARNESSES = [
  { value: 'claude', label: 'Claude Code', cmd: 'claude' },
  { value: 'custom', label: 'Custom Command', cmd: '' },
];

function BootstrapPanel() {
  const { data: mesh } = useSWR('/api/mesh', fetcher, { refreshInterval: 30000 });
  const { data: projects } = useSWR('/api/projects', fetcher);
  const { data: settings } = useSWR('/api/settings', fetcher);
  const [host, setHost] = useState('localhost');
  const [harness, setHarness] = useState('claude');
  const [customCmd, setCustomCmd] = useState('');
  const [selectedProject, setSelectedProject] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [projectName, setProjectName] = useState('');
  const [multiplexer, setMultiplexer] = useState<'tmux' | 'screen'>('tmux');
  const [yolo, setYolo] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [booting, setBooting] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const meshNodes: any[] = mesh?.nodes ?? [];
  const reachableNodes = meshNodes.filter((n: any) => n.reachable);
  const projectList: any[] = projects ?? [];
  const unsandboxEnabled = settings?.[SETTINGS_KEYS.unsandboxEnabled] === 'true'
    && !!settings?.[SETTINGS_KEYS.unsandboxPublicKey];

  const handleBoot = useCallback(async () => {
    if (host === 'unsandbox' && !projectPath) {
      // unsandbox can boot without a local path
    } else if (!projectPath) return;

    setBooting(true);
    setResult(null);
    setError(null);

    try {
      if (host === 'unsandbox') {
        // Route through unsandbox API
        const res = await fetch('/api/unsandbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'boot-harness',
            harness: harness === 'custom' ? customCmd : 'claude',
            projectRepo: projectPath, // treat as repo URL or path
            prompt: prompt.trim() || undefined,
            network: 'semitrusted',
          }),
        });
        const data = await res.json();
        if (data.success) {
          setResult({ ...data, host: 'unsandbox', multiplexer: 'unsandbox' });
        } else {
          setError(data.error || 'Boot failed');
        }
      } else {
        const res = await fetch('/api/boot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectPath,
            projectName,
            host: host === 'localhost' ? undefined : host,
            yolo: harness === 'claude' ? yolo : false,
            prompt: prompt.trim() || undefined,
            harness: harness === 'custom' ? customCmd : 'claude',
            preferMultiplexer: multiplexer,
          }),
        });
        const data = await res.json();
        if (res.ok) {
          setResult(data);
        } else {
          setError(data.error || 'Boot failed');
        }
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBooting(false);
    }
  }, [projectPath, projectName, host, harness, yolo, prompt, customCmd, multiplexer]);

  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
      <h3 className="text-base font-bold text-[var(--color-muted)]">Bootstrap Harness</h3>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Host</label>
          <select
            value={host}
            onChange={e => setHost(e.target.value)}
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono"
          >
            <option value="localhost">localhost</option>
            {unsandboxEnabled && (
              <option value="unsandbox">unsandbox.com (cloud)</option>
            )}
            {reachableNodes
              .filter((n: any) => n.hostname !== meshNodes[0]?.hostname)
              .map((n: any) => (
                <option key={n.hostname} value={n.hostname}>
                  {n.hostname} ({n.claudeProcesses ?? 0} claudes)
                </option>
              ))}
          </select>
        </div>

        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Harness</label>
          <select
            value={harness}
            onChange={e => setHarness(e.target.value)}
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base"
          >
            {HARNESSES.map(h => (
              <option key={h.value} value={h.value}>{h.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Multiplexer</label>
          <div className="flex gap-2">
            {(['tmux', 'screen'] as const).map(mux => (
              <button
                key={mux}
                onClick={() => setMultiplexer(mux)}
                className={`flex-1 px-3 py-1.5 text-base rounded border transition-colors cursor-pointer ${
                  multiplexer === mux
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-bold'
                    : 'border-[var(--color-border)] hover:border-[var(--color-muted)]'
                }`}
              >
                {mux}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Mode</label>
          <button
            onClick={() => setYolo(!yolo)}
            disabled={harness !== 'claude'}
            className={`w-full px-3 py-1.5 text-base rounded border transition-colors cursor-pointer disabled:opacity-30 ${
              yolo && harness === 'claude'
                ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-bold'
                : 'border-[var(--color-border)] hover:border-[var(--color-muted)]'
            }`}
          >
            {yolo ? 'YOLO (skip perms)' : 'Interactive'}
          </button>
        </div>
      </div>

      <div>
        <label className="text-base text-[var(--color-muted)] block mb-1">Project</label>
        <div className="flex gap-2">
          <select
            value={selectedProject}
            onChange={e => {
              const name = e.target.value;
              setSelectedProject(name);
              const proj = projectList.find((p: any) => p.name === name);
              setProjectPath(proj?.path ?? '');
              setProjectName(proj?.name ?? '');
            }}
            className="flex-1 bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono"
          >
            <option value="">select project...</option>
            {projectList.map((p: any) => (
              <option key={p.name} value={p.name}>
                {p.displayName || p.name}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={projectPath}
            onChange={e => { setProjectPath(e.target.value); setSelectedProject(''); setProjectName(''); }}
            placeholder="or enter path: /home/fox/git/..."
            className="flex-1 bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono"
          />
        </div>
      </div>

      <div>
        <label className="text-base text-[var(--color-muted)] block mb-1">Initial Prompt (optional)</label>
        <input
          type="text"
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder="e.g. fix the failing tests"
          className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base"
          onKeyDown={e => { if (e.key === 'Enter' && projectPath) handleBoot(); }}
        />
      </div>

      {harness === 'custom' && (
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Command</label>
          <input
            type="text"
            value={customCmd}
            onChange={e => setCustomCmd(e.target.value)}
            placeholder="e.g. python train.py"
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono"
          />
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={handleBoot}
          disabled={booting || (host !== 'unsandbox' && !projectPath)}
          className="px-6 py-2 text-base font-bold rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors disabled:opacity-50 cursor-pointer"
        >
          {booting ? 'Bootstrapping...' : `Boot ${harness === 'claude' ? 'Claude' : 'Harness'} on ${host === 'unsandbox' ? 'unsandbox.com' : host}`}
        </button>

        {result && (
          <div className="text-base text-green-400 font-mono">
            {result.bootstrapped?.length > 0 && (
              <span className="text-yellow-400 mr-2">
                [bootstrapped: {result.bootstrapped.join(', ')}]
              </span>
            )}
            {result.sessionId
              ? <>session: {result.sessionId}{result.domain && <span className="text-[var(--color-muted)] ml-2">{result.domain}</span>}</>
              : <>{result.multiplexer} session: {result.tmuxSession}{result.host !== 'localhost' && ` on ${result.host}`}</>
            }
            {result.command && (
              <span className="text-[var(--color-muted)] ml-2">
                {result.command}
              </span>
            )}
          </div>
        )}

        {error && (
          <div className="text-base text-red-400">{error}</div>
        )}
      </div>
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

// --- Bootstrap Tab ---

interface SshHost {
  name: string;
  hostname?: string;
  port?: string;
  user?: string;
  identityFile?: string;
  forwardAgent?: string;
}

function BootstrapTab() {
  const { data, mutate } = useSWR<{ hosts: SshHost[]; keys: string[] }>('/api/ssh-config', fetcher, { refreshInterval: 0 });
  const { data: mesh, mutate: mutateMesh } = useSWR('/api/mesh', fetcher, { refreshInterval: 30000 });

  const [editing, setEditing] = useState<string | null>(null); // host name being edited, or '__new__'
  const [form, setForm] = useState<SshHost>({ name: '' });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, 'ok' | 'fail' | 'testing'>>({});

  const hosts = data?.hosts ?? [];
  const keys = data?.keys ?? [];
  const meshNodes: any[] = mesh?.nodes ?? [];

  const getMeshNode = (hostName: string) =>
    meshNodes.find((n: any) => n.hostname === hostName || n.hostname === hosts.find(h => h.name === hostName)?.hostname);

  const startEdit = (host: SshHost) => {
    setEditing(host.name);
    setForm({ ...host });
  };

  const startNew = () => {
    setEditing('__new__');
    setForm({ name: '', hostname: '', port: '22', user: '', identityFile: '', forwardAgent: 'yes' });
  };

  const cancel = () => {
    setEditing(null);
    setForm({ name: '' });
  };

  const saveHost = async () => {
    if (!form.name) return;
    setSaving(true);
    try {
      const res = await fetch('/api/ssh-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        mutate();
        mutateMesh();
        setEditing(null);
        setForm({ name: '' });
      }
    } finally {
      setSaving(false);
    }
  };

  const deleteHost = async (name: string) => {
    const res = await fetch('/api/ssh-config', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      mutate();
      mutateMesh();
      setDeleting(null);
    }
  };

  const testHost = async (name: string) => {
    setTesting(name);
    setTestResults(prev => ({ ...prev, [name]: 'testing' }));
    try {
      const res = await fetch(`/api/mesh`);
      const meshData = await res.json();
      const host = hosts.find(h => h.name === name);
      const node = meshData.nodes?.find((n: any) =>
        n.hostname === name || n.hostname === host?.hostname
      );
      setTestResults(prev => ({ ...prev, [name]: node?.reachable ? 'ok' : 'fail' }));
    } catch {
      setTestResults(prev => ({ ...prev, [name]: 'fail' }));
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Node overview */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-[var(--color-muted)]">SSH Nodes</h3>
          <div className="flex items-center gap-3">
            <span className="text-base text-[var(--color-muted)]">
              {hosts.length} host{hosts.length !== 1 ? 's' : ''} in ~/.ssh/config
            </span>
            <button
              onClick={startNew}
              disabled={editing !== null}
              className="px-3 py-1.5 text-base font-bold rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors disabled:opacity-50 cursor-pointer"
            >
              + Add Node
            </button>
          </div>
        </div>

        {/* New host form */}
        {editing === '__new__' && (
          <HostForm
            form={form}
            setForm={setForm}
            keys={keys}
            onSave={saveHost}
            onCancel={cancel}
            saving={saving}
            isNew
          />
        )}

        {/* Host list */}
        {hosts.length === 0 && editing !== '__new__' && (
          <p className="text-base text-[var(--color-muted)]">No SSH hosts configured. Add a node to get started.</p>
        )}

        <div className="space-y-2">
          {hosts.map(host => {
            const node = getMeshNode(host.name);
            const isEditing = editing === host.name;
            const isDeleting = deleting === host.name;
            const testStatus = testResults[host.name];

            if (isEditing) {
              return (
                <HostForm
                  key={host.name}
                  form={form}
                  setForm={setForm}
                  keys={keys}
                  onSave={saveHost}
                  onCancel={cancel}
                  saving={saving}
                />
              );
            }

            return (
              <div
                key={host.name}
                className="bg-[var(--color-background)] rounded border border-[var(--color-border)] px-4 py-3 flex items-center gap-4"
              >
                {/* Status dot */}
                <span className={`text-base ${node?.reachable ? 'text-green-400' : 'text-[var(--color-muted)]'}`}>
                  {node?.reachable ? '●' : '○'}
                </span>

                {/* Name + hostname */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-bold font-mono">{host.name}</span>
                    {host.hostname && host.hostname !== host.name && (
                      <span className="text-base text-[var(--color-muted)] font-mono">{host.hostname}</span>
                    )}
                    {host.port && host.port !== '22' && (
                      <span className="text-base text-[var(--color-muted)]">:{host.port}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-base text-[var(--color-muted)]">
                    {host.user && <span>user: {host.user}</span>}
                    {host.identityFile && <span>key: {host.identityFile.replace(/.*\//, '')}</span>}
                    {host.forwardAgent === 'yes' && <span>agent fwd</span>}
                  </div>
                </div>

                {/* Mesh stats */}
                {node?.reachable && (
                  <div className="text-base text-[var(--color-muted)] text-right shrink-0">
                    {node.claudeProcesses !== undefined && (
                      <div>{node.claudeProcesses} claude{node.claudeProcesses !== 1 ? 's' : ''}</div>
                    )}
                    {node.loadAvg && (
                      <div>load {node.loadAvg[0]}</div>
                    )}
                  </div>
                )}

                {/* Test result */}
                {testStatus && testStatus !== 'testing' && (
                  <span className={`text-base font-bold ${testStatus === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
                    {testStatus === 'ok' ? 'reachable' : 'unreachable'}
                  </span>
                )}

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => testHost(host.name)}
                    disabled={testing === host.name}
                    className="text-base text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {testing === host.name ? 'testing...' : 'test'}
                  </button>
                  <button
                    onClick={() => startEdit(host)}
                    disabled={editing !== null}
                    className="text-base text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors cursor-pointer disabled:opacity-50"
                  >
                    edit
                  </button>
                  {isDeleting ? (
                    <div className="flex gap-1">
                      <button
                        onClick={() => deleteHost(host.name)}
                        className="text-base text-red-400 hover:text-red-300 cursor-pointer"
                      >
                        confirm
                      </button>
                      <button
                        onClick={() => setDeleting(null)}
                        className="text-base text-[var(--color-muted)] hover:text-[var(--color-foreground)] cursor-pointer"
                      >
                        cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDeleting(host.name)}
                      disabled={editing !== null}
                      className="text-base text-[var(--color-muted)] hover:text-red-400 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      remove
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Available SSH Keys */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
        <h3 className="text-base font-bold text-[var(--color-muted)]">SSH Keys</h3>
        {keys.length === 0 ? (
          <p className="text-base text-[var(--color-muted)]">No SSH keys found in ~/.ssh/</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {keys.map(k => (
              <span
                key={k}
                className="px-3 py-1 text-base font-mono rounded border border-[var(--color-border)] bg-[var(--color-background)]"
              >
                {k}
              </span>
            ))}
          </div>
        )}
        <p className="text-base text-[var(--color-muted)]">
          To add a key to a remote node: <code className="font-mono text-[var(--color-foreground)]">ssh-copy-id -i ~/.ssh/KEY user@host</code>
        </p>
      </div>

      {/* Mesh Summary */}
      {mesh?.summary && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
          <h3 className="text-base font-bold text-[var(--color-muted)]">Mesh Summary</h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <Stat label="Nodes" value={`${mesh.summary.reachableNodes}/${mesh.summary.totalNodes}`} />
            <Stat label="Claudes" value={mesh.summary.totalClaudes} />
            <Stat label="Cores" value={mesh.summary.totalCores} />
            <Stat label="Memory" value={`${mesh.summary.totalMemUsedGB}/${mesh.summary.totalMemGB} GB`} />
            <Stat label="Status" value={mesh.summary.reachableNodes === mesh.summary.totalNodes ? 'all green' : 'degraded'} accent={mesh.summary.reachableNodes === mesh.summary.totalNodes} />
          </div>
        </div>
      )}

      {/* Unsandbox Compute */}
      <UnsandboxPanel />

      {/* Bootstrap Harness */}
      <BootstrapPanel />
    </div>
  );
}

function UnsandboxPanel() {
  const { data: settings, mutate: mutateSettings } = useSWR('/api/settings', fetcher);
  const { data: status, mutate: mutateStatus } = useSWR('/api/unsandbox', fetcher, { refreshInterval: 60000 });
  const [showSecret, setShowSecret] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; tier?: number; error?: string } | null>(null);
  const [booting, setBooting] = useState(false);
  const [bootResult, setBootResult] = useState<any>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootPrompt, setBootPrompt] = useState('');

  const publicKey = settings?.[SETTINGS_KEYS.unsandboxPublicKey] ?? '';
  const secretKey = settings?.[SETTINGS_KEYS.unsandboxSecretKey] ?? '';
  const enabled = settings?.[SETTINGS_KEYS.unsandboxEnabled] === 'true';

  const saveSetting = async (key: string, value: string) => {
    mutateSettings((prev: Record<string, string> | undefined) => ({ ...prev, [key]: value }), { revalidate: false });
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set', key, value }),
    });
    mutateStatus();
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/unsandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test' }),
      });
      const data = await res.json();
      setTestResult(data);
    } catch (err) {
      setTestResult({ ok: false, error: String(err) });
    } finally {
      setTesting(false);
    }
  };

  const bootOnUnsandbox = async () => {
    setBooting(true);
    setBootResult(null);
    setBootError(null);
    try {
      const res = await fetch('/api/unsandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'boot-harness',
          harness: 'claude',
          prompt: bootPrompt.trim() || undefined,
          network: 'semitrusted',
        }),
      });
      const data = await res.json();
      if (data.success) {
        setBootResult(data);
      } else {
        setBootError(data.error || 'Boot failed');
      }
    } catch (err) {
      setBootError(String(err));
    } finally {
      setBooting(false);
    }
  };

  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-bold text-[var(--color-muted)]">unsandbox.com</h3>
          <p className="text-base text-[var(--color-muted)] mt-0.5">
            Cloud compute for agent harnesses. Free tier or paid for sessions + semitrust network.
          </p>
        </div>
        <label className="flex items-center gap-2 text-base shrink-0">
          <input
            type="checkbox"
            checked={enabled}
            className="accent-[var(--color-accent)]"
            onChange={(e) => saveSetting(SETTINGS_KEYS.unsandboxEnabled, String(e.target.checked))}
          />
          <span className={enabled ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'}>
            {enabled ? 'Enabled' : 'Disabled'}
          </span>
        </label>
      </div>

      {/* Key inputs */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Public Key</label>
          <input
            type="text"
            defaultValue={publicKey}
            placeholder="unsb-pk-xxxx-xxxx-xxxx-xxxx"
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono"
            onBlur={(e) => {
              if (e.target.value !== publicKey) saveSetting(SETTINGS_KEYS.unsandboxPublicKey, e.target.value.trim());
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
        </div>
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Secret Key</label>
          <div className="flex gap-2">
            <input
              type={showSecret ? 'text' : 'password'}
              defaultValue={secretKey}
              placeholder="unsb-sk-xxxx-xxxx-xxxx-xxxx"
              className="flex-1 bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono"
              onBlur={(e) => {
                if (e.target.value !== secretKey) saveSetting(SETTINGS_KEYS.unsandboxSecretKey, e.target.value.trim());
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
            <button
              onClick={() => setShowSecret(!showSecret)}
              className="px-2 text-base text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors cursor-pointer"
            >
              {showSecret ? 'hide' : 'show'}
            </button>
          </div>
        </div>
      </div>

      {/* Status + test */}
      <div className="flex items-center gap-3 flex-wrap">
        {status?.connected && (
          <div className="flex items-center gap-3 text-base">
            <span className="text-green-400">● connected</span>
            <span className="text-[var(--color-muted)]">tier {status.tier}</span>
            <span className="text-[var(--color-muted)]">{status.rateLimit} rpm</span>
            <span className="text-[var(--color-muted)]">{status.maxSessions} session{status.maxSessions !== 1 ? 's' : ''}</span>
            {status.network && <span className="text-[var(--color-muted)]">{status.network}</span>}
          </div>
        )}
        {status && !status.connected && publicKey && (
          <span className="text-base text-red-400">○ {status.error || 'disconnected'}</span>
        )}
        <button
          onClick={testConnection}
          disabled={testing || !publicKey || !secretKey}
          className="px-3 py-1 text-base rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:border-[var(--color-muted)] transition-colors disabled:opacity-50 cursor-pointer"
        >
          {testing ? 'testing...' : 'test connection'}
        </button>
        {testResult && (
          <span className={`text-base font-bold ${testResult.ok ? 'text-green-400' : 'text-red-400'}`}>
            {testResult.ok ? `tier ${testResult.tier}` : testResult.error}
          </span>
        )}
      </div>

      {/* Quick boot on unsandbox */}
      {enabled && publicKey && secretKey && (
        <div className="border-t border-[var(--color-border)] pt-3 space-y-3">
          <h4 className="text-base font-bold text-[var(--color-muted)]">Boot on unsandbox</h4>
          <div className="flex gap-2">
            <input
              type="text"
              value={bootPrompt}
              onChange={e => setBootPrompt(e.target.value)}
              placeholder="initial prompt (optional)"
              className="flex-1 bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base"
              onKeyDown={e => { if (e.key === 'Enter') bootOnUnsandbox(); }}
            />
            <button
              onClick={bootOnUnsandbox}
              disabled={booting}
              className="px-4 py-1.5 text-base font-bold rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              {booting ? 'Booting...' : 'Boot Claude on unsandbox'}
            </button>
          </div>
          {bootResult && (
            <div className="text-base text-green-400 font-mono">
              session: {bootResult.sessionId}
              {bootResult.domain && <span className="ml-2 text-[var(--color-muted)]">{bootResult.domain}</span>}
            </div>
          )}
          {bootError && <div className="text-base text-red-400">{bootError}</div>}
        </div>
      )}

      {/* Sign up prompt */}
      {!publicKey && (
        <div className="text-base text-[var(--color-muted)] space-y-1">
          <div>
            Free code execution for anyone. Get keys at{' '}
            <a href="https://unsandbox.com" target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] hover:underline">
              unsandbox.com
            </a>
            {' '}— free tier runs 42 languages, paid tiers add sessions + semitrust network for agent harnesses.
          </div>
          <div>
            Tier formula: <span className="font-mono text-[var(--color-foreground)]">$7*N/mo</span> for <span className="font-mono text-[var(--color-foreground)]">N*7 rpm</span> + sessions.
            CLI: <code className="font-mono text-[var(--color-foreground)]">curl -O unsandbox.com/cli/typescript</code>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div>
      <div className="text-base text-[var(--color-muted)]">{label}</div>
      <div className={`text-base font-bold ${accent ? 'text-[var(--color-accent)]' : ''}`}>{value}</div>
    </div>
  );
}

function HostForm({
  form,
  setForm,
  keys,
  onSave,
  onCancel,
  saving,
  isNew,
}: {
  form: SshHost;
  setForm: (f: SshHost) => void;
  keys: string[];
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  isNew?: boolean;
}) {
  return (
    <div className="bg-[var(--color-background)] rounded border border-[var(--color-accent)]/30 p-4 space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Host Alias</label>
          <input
            type="text"
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. cammy"
            disabled={!isNew}
            className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono disabled:opacity-50"
          />
        </div>
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">HostName</label>
          <input
            type="text"
            value={form.hostname ?? ''}
            onChange={e => setForm({ ...form, hostname: e.target.value })}
            placeholder="e.g. cammy.foxhop.net"
            className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono"
          />
        </div>
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Port</label>
          <input
            type="text"
            value={form.port ?? ''}
            onChange={e => setForm({ ...form, port: e.target.value })}
            placeholder="22"
            className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono"
          />
        </div>
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">User</label>
          <input
            type="text"
            value={form.user ?? ''}
            onChange={e => setForm({ ...form, user: e.target.value })}
            placeholder="e.g. fox"
            className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono"
          />
        </div>
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Identity File</label>
          <select
            value={form.identityFile ?? ''}
            onChange={e => setForm({ ...form, identityFile: e.target.value })}
            className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono"
          >
            <option value="">default</option>
            {keys.map(k => (
              <option key={k} value={`~/.ssh/${k}`}>~/.ssh/{k}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Forward Agent</label>
          <div className="flex gap-2 mt-0.5">
            {['yes', 'no'].map(v => (
              <button
                key={v}
                onClick={() => setForm({ ...form, forwardAgent: v })}
                className={`flex-1 px-3 py-1.5 text-base rounded border transition-colors cursor-pointer ${
                  form.forwardAgent === v
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-bold'
                    : 'border-[var(--color-border)] hover:border-[var(--color-muted)]'
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={saving || !form.name}
          className="px-4 py-1.5 text-base font-bold rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors disabled:opacity-50 cursor-pointer"
        >
          {saving ? 'Saving...' : isNew ? 'Add Host' : 'Save'}
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-1.5 text-base rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
