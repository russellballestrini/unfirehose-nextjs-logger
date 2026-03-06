'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import useSWR from 'swr';
import { PageContext } from '@unfirehose/ui/PageContext';

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
};

const BOOT_STRATEGIES = [
  { value: 'default', label: 'Default Host', desc: 'Always use the configured default host' },
  { value: 'least-loaded', label: 'Least Loaded', desc: 'Pick the mesh node with lowest load average' },
  { value: 'round-robin', label: 'Round Robin', desc: 'Rotate across available mesh nodes' },
];

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

  const selectedPlanData = PLANS.find((p) => p.value === currentPlan);

  return (
    <div className="space-y-6 max-w-6xl">
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

      <h2 className="text-lg font-bold">Settings</h2>

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

      {/* Scrobble */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold text-[var(--color-muted)]">Scrobble</h3>
            <p className="text-base text-[var(--color-muted)] mt-1">
              Broadcast your coding activity to your unfirehose timeline. Like last.fm but for building software.
            </p>
          </div>
          <label className="flex items-center gap-2 text-base shrink-0">
            <input
              type="checkbox"
              checked={scrobbleEnabled}
              className="accent-[var(--color-accent)]"
              onChange={(e) =>
                saveSetting(SETTINGS_KEYS.scrobbleEnabled, String(e.target.checked))
              }
            />
            <span className={scrobbleEnabled ? 'text-[var(--color-accent)] font-bold' : 'text-[var(--color-muted)]'}>
              {scrobbleEnabled ? 'Live' : 'Off'}
            </span>
          </label>
        </div>

        {scrobbleEnabled && (
          <div className="text-base text-[var(--color-muted)] space-y-1">
            <div>Scrobbling: project names, session starts, tool usage, model info</div>
            <div>Not scrobbling: prompt content, thinking blocks, file contents</div>
          </div>
        )}
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
                label="Scrobble Out"
                desc="Your coding activity → feed"
                settingKey="unfirehose_hose_scrobble"
                settings={settings}
                onSave={saveSetting}
              />
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
