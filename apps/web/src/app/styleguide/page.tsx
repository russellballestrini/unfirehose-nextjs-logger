'use client';

import { useState, useRef, Fragment } from 'react';
import useSWR from 'swr';
import { TimeRangeSelect, useTimeRange } from '@unturf/unfirehose-ui/TimeRangeSelect';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
  AreaChart, Area,
} from 'recharts';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';

// --- Mock data ---

const barData = [
  { name: 'Mon', value: 420 },
  { name: 'Tue', value: 680 },
  { name: 'Wed', value: 310 },
  { name: 'Thu', value: 890 },
  { name: 'Fri', value: 560 },
  { name: 'Sat', value: 220 },
  { name: 'Sun', value: 150 },
];

const pieData = [
  { name: 'Opus', value: 62 },
  { name: 'Sonnet', value: 28 },
  { name: 'Haiku', value: 10 },
];

const areaData = [
  { date: 'Mar 1', tokens: 1200 },
  { date: 'Mar 2', tokens: 3400 },
  { date: 'Mar 3', tokens: 2800 },
  { date: 'Mar 4', tokens: 4100 },
  { date: 'Mar 5', tokens: 3600 },
  { date: 'Mar 6', tokens: 5200 },
  { date: 'Mar 7', tokens: 4800 },
];

const horizontalBarData = [
  { name: 'unsandbox-com', input: 150000, output: 280000 },
  { name: 'unfirehose', input: 90000, output: 195000 },
  { name: 'uncloseai-com', input: 45000, output: 82000 },
  { name: 'funlooper-com', input: 12000, output: 35000 },
];

const PIE_COLORS = ['#d40000', '#60a5fa', '#fbbf24'];

const CSS_VARS = [
  { name: '--color-background', hex: '#09090b' },
  { name: '--color-foreground', hex: '#fafafa' },
  { name: '--color-surface', hex: '#18181b' },
  { name: '--color-surface-hover', hex: '#27272a' },
  { name: '--color-border', hex: '#3f3f46' },
  { name: '--color-muted', hex: '#a1a1aa' },
  { name: '--color-accent', hex: '#d40000' },
  { name: '--color-thinking', hex: '#a78bfa' },
  { name: '--color-user', hex: '#60a5fa' },
  { name: '--color-assistant', hex: '#d40000' },
  { name: '--color-tool', hex: '#fbbf24' },
  { name: '--color-error', hex: '#f87171' },
];

const BORDER_TYPES = [
  { label: 'user', color: 'var(--color-user)' },
  { label: 'assistant', color: 'var(--color-assistant)' },
  { label: 'system', color: 'var(--color-muted)' },
  { label: 'thinking', color: 'var(--color-thinking)' },
  { label: 'tool', color: 'var(--color-tool)' },
];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// --- Components ---

const sgFetcher = (url: string) => fetch(url).then((r) => r.json());

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

function ThemeChooser() {
  const { data: settings, mutate } = useSWR('/api/settings', sgFetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 60000,
  });
  const accent = settings?.theme_accent_color ?? '#d40000';
  const [color, setColor] = useState(accent);
  const [hexText, setHexText] = useState(accent.replace('#', ''));
  const hexRef = useRef(accent.replace('#', ''));
  const hue = hexToHue(color);

  function save(hex: string) {
    const clean = hex.startsWith('#') ? hex : '#' + hex;
    setColor(clean);
    setHexText(clean.replace('#', ''));
    hexRef.current = clean.replace('#', '');
    document.documentElement.style.setProperty('--color-accent', clean);
    document.documentElement.style.setProperty('--color-assistant', clean);
    mutate((prev: Record<string, string> | undefined) => ({ ...prev, theme_accent_color: clean }), { revalidate: false });
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set', key: 'theme_accent_color', value: clean }),
    });
  }

  function tryCommit(text: string) {
    const clean = text.replace(/[^0-9a-fA-F]/g, '');
    if (clean.length === 6) save('#' + clean.toLowerCase());
    else if (clean.length === 3) save('#' + clean.split('').map(c => c + c).join('').toLowerCase());
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
            onKeyDown={(e) => { if (e.key === 'Enter') tryCommit(hexRef.current); }}
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
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-base font-bold text-[var(--color-accent)] uppercase tracking-wide">{title}</h3>
      {children}
    </div>
  );
}

function ProgressBar({ value, label }: { value: number; label: string }) {
  return (
    <div className="grid grid-cols-[3rem_1fr_3rem] items-center gap-3 text-base">
      <span className="text-[var(--color-muted)]">{label}</span>
      <div className="h-3 bg-[var(--color-surface-hover)] rounded overflow-hidden">
        <div
          className="h-full bg-[var(--color-accent)] rounded transition-all"
          style={{ width: `${value}%` }}
        />
      </div>
      <span className="text-right text-[var(--color-muted)]">{value}%</span>
    </div>
  );
}

const BAR_CHART_VALUES = Array.from({ length: 24 }, (_, h) => {
  const value = Math.sin((h - 14) * 0.3) * 0.5 + 0.5 + Math.random() * 0.2;
  return { h, value };
});

export default function StyleguidePage() {
  const [inputVal, setInputVal] = useState('');
  const [numberVal, setNumberVal] = useState(30);
  const [selectVal, setSelectVal] = useState('opus');
  const [checked, setChecked] = useState(true);
  const [timeRange, setTimeRange] = useTimeRange('styleguide_range', '7d');
  const [lightMode, setLightMode] = useState(false);

  function toggleTheme() {
    const next = !lightMode;
    setLightMode(next);
    document.documentElement.classList.toggle('light', next);
    document.documentElement.classList.toggle('dark', !next);
  }

  const hBarMax = Math.max(...horizontalBarData.map((d) => d.input + d.output), 1);

  const barChartValues = BAR_CHART_VALUES;

  return (
    <div className="space-y-8">
      <PageContext
        pageType="styleguide"
        summary="Component reference and design system for unfirehose."
        metrics={{ components: 18, sections: 22 }}
      />

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">
          Styleguide{' '}
          <span className="text-[var(--color-muted)] font-normal">component reference</span>
        </h2>
        <button
          onClick={toggleTheme}
          className="px-3 py-1.5 text-sm font-bold rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] transition-colors cursor-pointer"
        >
          {lightMode ? 'Light Mode' : 'Dark Mode'}
        </button>
      </div>

      {/* Theme */}
      <Section title="Theme">
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
          <p className="text-base text-[var(--color-muted)]">
            Accent color applied globally via <code className="text-[var(--color-accent)]">--color-accent</code>.
            Changes persist to settings and propagate across all pages via ThemeProvider.
          </p>
          <ThemeChooser />
        </div>
      </Section>

      {/* Navigation */}
      <Section title="Navigation">
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
          <p className="text-base text-[var(--color-muted)]">
            Sidebar nav grouped by function. Section labels are tiny uppercase dividers.
            Active item gets accent icon, inactive icons are dimmed border color.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { title: 'monitor', items: [['●', 'Live'], ['▸', 'Active']] },
              { title: 'navigate', items: [['◇', 'Dashboard'], ['■', 'Projects'], ['☰', 'Todos'], ['◈', 'Graph']] },
              { title: 'analyze', items: [['◎', 'Thinking'], ['≡', 'All Logs'], ['¤', 'Tokens'], ['△', 'Usage']] },
              { title: 'configure', items: [['♪', 'Scrobble'], ['{', 'Schema'], ['◐', 'Styleguide'], ['⚙', 'Settings']] },
            ].map(group => (
              <div key={group.title}>
                <div className="text-xs uppercase tracking-widest text-[var(--color-muted)] opacity-60 mb-2">{group.title}</div>
                <div className="space-y-1">
                  {group.items.map(([icon, label], i) => (
                    <div key={i} className="flex items-center gap-2 text-base text-[var(--color-muted)]">
                      <span className={`font-bold w-4 text-center ${i === 0 ? 'text-[var(--color-accent)]' : 'text-[var(--color-border)]'}`}>{icon}</span>
                      <span className={i === 0 ? 'text-[var(--color-foreground)]' : ''}>{label}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* Layout rule */}
      <Section title="Layout — Grid Only">
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
          <p className="text-base text-[var(--color-muted)]">
            All layouts use CSS Grid. No flexbox. The pattern{' '}
            <code className="text-[var(--color-accent)]">grid-cols-[auto_1fr]</code>{' '}
            gives labels priority — they size to content (never truncated), bars fill the rest.
          </p>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 items-center">
            <span className="text-base text-[var(--color-muted)] whitespace-nowrap">Short</span>
            <div className="h-4 bg-[var(--color-background)] rounded overflow-hidden">
              <div className="h-full bg-[var(--color-accent)] rounded" style={{ width: '75%' }} />
            </div>
            <span className="text-base text-[var(--color-muted)] whitespace-nowrap">Much longer label here</span>
            <div className="h-4 bg-[var(--color-background)] rounded overflow-hidden">
              <div className="h-full bg-[var(--color-accent)] rounded" style={{ width: '40%' }} />
            </div>
          </div>
          <p className="text-base text-[var(--color-muted)]">
            For inline groups: <code className="text-[var(--color-accent)]">grid grid-flow-col auto-cols-max</code>.
            For label+content rows: <code className="text-[var(--color-accent)]">grid grid-cols-[auto_1fr]</code>.
            For equal columns: <code className="text-[var(--color-accent)]">grid grid-cols-N</code>.
          </p>
        </div>
      </Section>

      {/* Colors */}
      <Section title="Colors">
        <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
          {CSS_VARS.map((v) => (
            <div key={v.name} className="space-y-1">
              <div
                className="w-full h-10 rounded border border-[var(--color-border)]"
                style={{ background: v.hex }}
              />
              <div className="text-base text-[var(--color-muted)] break-all">{v.name}</div>
              <div className="text-base font-mono">{v.hex}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* Design Tokens */}
      <Section title="Design Tokens">
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
          <p className="text-base text-[var(--color-muted)]">
            All design decisions flow through CSS custom properties defined in{' '}
            <code className="text-[var(--color-accent)]">globals.css</code> via{' '}
            <code className="text-[var(--color-accent)]">@theme inline</code>.
            Tailwind v4 consumes them directly — no tailwind.config needed.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <h4 className="text-sm font-bold text-[var(--color-muted)]">Surface Tokens</h4>
              <div className="space-y-1 text-base">
                {[
                  ['--color-background', 'Page base', '#09090b'],
                  ['--color-surface', 'Card / panel', '#18181b'],
                  ['--color-surface-hover', 'Hover state', '#27272a'],
                ].map(([token, usage, hex]) => (
                  <div key={token} className="grid grid-cols-[12px_1fr_auto] gap-2 items-center">
                    <div className="w-3 h-3 rounded-sm border border-[var(--color-border)]" style={{ background: hex }} />
                    <code className="text-[var(--color-accent)] text-sm">{token}</code>
                    <span className="text-[var(--color-muted)] text-sm">{usage}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <h4 className="text-sm font-bold text-[var(--color-muted)]">Semantic Tokens</h4>
              <div className="space-y-1 text-base">
                {[
                  ['--color-foreground', 'Primary text', '#fafafa'],
                  ['--color-muted', 'Secondary text', '#a1a1aa'],
                  ['--color-border', 'Borders', '#3f3f46'],
                  ['--color-error', 'Error state', '#f87171'],
                ].map(([token, usage, hex]) => (
                  <div key={token} className="grid grid-cols-[12px_1fr_auto] gap-2 items-center">
                    <div className="w-3 h-3 rounded-sm border border-[var(--color-border)]" style={{ background: hex }} />
                    <code className="text-[var(--color-accent)] text-sm">{token}</code>
                    <span className="text-[var(--color-muted)] text-sm">{usage}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <h4 className="text-sm font-bold text-[var(--color-muted)]">Role Tokens</h4>
              <div className="space-y-1 text-base">
                {[
                  ['--color-user', 'User messages', '#60a5fa'],
                  ['--color-assistant', 'Assistant msgs', '#d40000'],
                  ['--color-thinking', 'Thinking blocks', '#a78bfa'],
                  ['--color-tool', 'Tool calls', '#fbbf24'],
                ].map(([token, usage, hex]) => (
                  <div key={token} className="grid grid-cols-[12px_1fr_auto] gap-2 items-center">
                    <div className="w-3 h-3 rounded-sm border border-[var(--color-border)]" style={{ background: hex }} />
                    <code className="text-[var(--color-accent)] text-sm">{token}</code>
                    <span className="text-[var(--color-muted)] text-sm">{usage}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <p className="text-base text-[var(--color-muted)]">
            Dark mode is default. Light mode activates via <code className="text-[var(--color-accent)]">:root.light</code> class.
            The accent color (<code className="text-[var(--color-accent)]">--color-accent</code>) is user-customizable and persists to the settings database.
            <code className="text-[var(--color-accent)]">--color-assistant</code> tracks the accent color.
          </p>
        </div>
      </Section>

      {/* Shape System */}
      <Section title="Shape System">
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
          <p className="text-base text-[var(--color-muted)]">
            Three corner radius tiers. Consistent rounding reinforces hierarchy.
          </p>
          <div className="grid grid-cols-3 gap-4">
            {[
              ['rounded (6px)', 'rounded', 'Cards, inputs, buttons, code blocks'],
              ['rounded-lg (8px)', 'rounded-lg', 'Modals, panels, larger containers'],
              ['rounded-xl (12px)', 'rounded-xl', 'Kanban cards, vault gate, hero elements'],
            ].map(([label, cls, usage]) => (
              <div key={label} className="space-y-2">
                <div className={`h-20 bg-[var(--color-accent)]/20 border border-[var(--color-accent)] ${cls}`} />
                <div className="text-base font-bold">{label}</div>
                <div className="text-sm text-[var(--color-muted)]">{usage}</div>
              </div>
            ))}
          </div>
          <p className="text-base text-[var(--color-muted)]">
            Scrollbar thumb: <code className="text-[var(--color-accent)]">4px</code>.
            Inline code: <code className="text-[var(--color-accent)]">3px</code>.
            Progress bars: <code className="text-[var(--color-accent)]">rounded</code> (full pill).
          </p>
        </div>
      </Section>

      {/* Elevation */}
      <Section title="Elevation">
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
          <p className="text-base text-[var(--color-muted)]">
            Dark-first design uses border-based elevation rather than shadow-heavy. Shadows reserved for interactive lift and emphasis.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              ['Level 0', 'No shadow', 'shadow-none', 'Static content, table rows'],
              ['Level 1', 'shadow-md', 'shadow-md', 'Cards, kanban items at rest'],
              ['Level 2', 'shadow-lg', 'shadow-lg', 'Active kanban cards, dropdowns'],
              ['Level 3', 'shadow-2xl', 'shadow-2xl', 'Dragged items, modals, vault gate'],
            ].map(([level, label, cls, usage]) => (
              <div key={level} className="space-y-2">
                <div className={`h-16 bg-[var(--color-surface)] rounded border border-[var(--color-border)] ${cls}`} />
                <div className="text-base font-bold">{level}</div>
                <div className="text-sm text-[var(--color-muted)]">{label}</div>
                <div className="text-xs text-[var(--color-muted)]">{usage}</div>
              </div>
            ))}
          </div>
          <p className="text-base text-[var(--color-muted)]">
            Accent glow: <code className="text-[var(--color-accent)]">shadow-[0_0_12px_var(--color-accent)]</code> for active/running items.
            Vault gate: <code className="text-[var(--color-accent)]">radial-gradient</code> glow with blur backdrop.
          </p>
        </div>
      </Section>

      {/* Spacing */}
      <Section title="Spacing Scale">
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
          <p className="text-base text-[var(--color-muted)]">
            4px base unit. All spacing derives from Tailwind&apos;s default 4px scale.
          </p>
          <div className="space-y-1">
            {[
              ['0.5', '2px', 'Tight inline gaps (icon+text within badges)'],
              ['1', '4px', 'Minimal separation (list items, badge padding-y)'],
              ['1.5', '6px', 'Input padding-y, checkbox gap'],
              ['2', '8px', 'Standard gap between related items'],
              ['3', '12px', 'Card padding, section gaps, input padding-x'],
              ['4', '16px', 'Card padding, grid gaps, section spacing'],
              ['6', '24px', 'Page padding, major section margins'],
              ['8', '32px', 'Page-level vertical rhythm'],
            ].map(([unit, px, usage]) => (
              <div key={unit} className="grid grid-cols-[3rem_4rem_1fr_auto] gap-2 items-center text-base">
                <span className="text-[var(--color-accent)] font-mono text-sm">{unit}</span>
                <span className="text-[var(--color-muted)] text-sm">{px}</span>
                <div className="h-3 bg-[var(--color-background)] rounded overflow-hidden">
                  <div className="h-full bg-[var(--color-accent)]/40 rounded" style={{ width: `${(parseInt(px) / 32) * 100}%` }} />
                </div>
                <span className="text-[var(--color-muted)] text-sm">{usage}</span>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* Typography */}
      <Section title="Typography">
        <div className="space-y-4 bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <div className="bg-[var(--color-accent)]/10 border border-[var(--color-accent)]/30 rounded p-3">
            <p className="text-base font-bold text-[var(--color-accent)]">16px minimum — no text smaller than 1rem</p>
            <p className="text-base text-[var(--color-muted)] mt-1">
              The theme overrides <code className="text-[var(--color-accent)]">--font-size-xs</code> and{' '}
              <code className="text-[var(--color-accent)]">--font-size-sm</code> to{' '}
              <code className="text-[var(--color-accent)]">1rem</code> (16px). All Tailwind text utilities{' '}
              (<code className="text-[var(--color-accent)]">text-xs</code>,{' '}
              <code className="text-[var(--color-accent)]">text-sm</code>,{' '}
              <code className="text-[var(--color-accent)]">text-base</code>) resolve to 16px or larger.
              Arbitrary small values like <code className="text-[var(--color-accent)]">text-[10px]</code> are banned.
            </p>
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-bold">Heading 2XL — 1.5rem / 24px</h1>
            <h2 className="text-xl font-bold">Heading XL — 1.25rem / 20px</h2>
            <h3 className="text-lg font-bold">Heading LG — 1.125rem / 18px</h3>
            <p className="text-base font-bold">Heading Base — 1rem / 16px bold</p>
            <p className="text-base">Body text — 1rem / 16px regular</p>
            <p className="text-sm">text-sm — resolves to 16px (theme override)</p>
            <p className="text-xs">text-xs — resolves to 16px (theme override)</p>
            <p className="text-base text-[var(--color-muted)]">Muted caption — base muted</p>
            <p className="text-base text-[var(--color-accent)]">Accent text — base accent</p>
            <p className="text-base font-mono bg-[var(--color-background)] inline-block px-2 py-0.5 rounded">
              Monospace inline — font-mono
            </p>
          </div>
          <div className="grid grid-cols-4 gap-3">
            {[
              ['text-2xl', '1.5rem / 24px', 'Page titles'],
              ['text-xl', '1.25rem / 20px', 'Section headings'],
              ['text-lg', '1.125rem / 18px', 'Sub-headings'],
              ['text-base', '1rem / 16px', 'Body, labels, everything else'],
            ].map(([cls, size, usage]) => (
              <div key={cls} className="bg-[var(--color-background)] rounded p-3">
                <div className="text-base font-bold text-[var(--color-accent)]">{cls}</div>
                <div className="text-base text-[var(--color-foreground)]">{size}</div>
                <div className="text-base text-[var(--color-muted)]">{usage}</div>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* Cards */}
      <Section title="Cards">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* StatCard */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <div className="text-base text-[var(--color-muted)]">Total Sessions</div>
            <div className="text-2xl font-bold mt-1">412</div>
            <div className="text-base text-[var(--color-accent)] mt-1">+12 today</div>
          </div>
          {/* RateCard normal */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <div className="text-base text-[var(--color-muted)]">Cost / hour</div>
            <div className="text-2xl font-bold mt-1">$3.20</div>
            <div className="text-base text-[var(--color-muted)] mt-1">avg last 7d</div>
          </div>
          {/* RateCard warn */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-error)] p-4">
            <div className="text-base text-[var(--color-error)]">Rate Alert</div>
            <div className="text-2xl font-bold text-[var(--color-error)] mt-1">$8.50/hr</div>
            <div className="text-base text-[var(--color-muted)] mt-1">exceeds $5 threshold</div>
          </div>
        </div>
        {/* ProjectCard mock */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 max-w-sm hover:border-[var(--color-accent)] transition-colors cursor-pointer">
          <div className="grid grid-cols-[1fr_auto] items-start">
            <div className="font-bold text-base break-words">unsandbox-com</div>
            <span className="w-2 h-2 rounded-full bg-[var(--color-accent)] mt-1" />
          </div>
          <div className="text-base text-[var(--color-muted)] mt-1">/home/fox/git/unsandbox.com</div>
          <div className="grid grid-flow-col auto-cols-max gap-4 mt-3 text-base text-[var(--color-muted)]">
            <span>24 sessions</span>
            <span>1.2K msgs</span>
            <span>2 hours ago</span>
          </div>
          <div className="mt-2 text-base text-[var(--color-accent)]">$42 / 30d</div>
        </div>
      </Section>

      {/* Charts */}
      <Section title="Charts">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* BarChart (Recharts — vertical) */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <div className="text-base text-[var(--color-muted)] mb-3">BarChart — Messages / Day</div>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={barData}>
                <XAxis dataKey="name" tick={{ fontSize: 16 }} />
                <YAxis tick={{ fontSize: 16 }} />
                <Tooltip />
                <Bar dataKey="value" fill="#d40000" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          {/* PieChart (donut) */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <div className="text-base text-[var(--color-muted)] mb-3">PieChart (donut) — Model Split</div>
            <ResponsiveContainer width="100%" height={160}>
              <PieChart>
                <Pie
                  data={pieData}
                  innerRadius={40}
                  outerRadius={65}
                  paddingAngle={2}
                  dataKey="value"
                  label={({ name, value }) => `${name} ${value}%`}
                >
                  {pieData.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
          {/* AreaChart */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 md:col-span-2">
            <div className="text-base text-[var(--color-muted)] mb-3">AreaChart — Token Volume</div>
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart data={areaData}>
                <XAxis dataKey="date" tick={{ fontSize: 16 }} />
                <YAxis tick={{ fontSize: 16 }} />
                <Tooltip />
                <Area type="monotone" dataKey="tokens" stroke="#d40000" fill="#d4000030" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {/* Horizontal Bar Chart — CSS Grid */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 md:col-span-2">
            <div className="text-base text-[var(--color-muted)] mb-3">Horizontal Bar — CSS Grid (labels get priority)</div>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 items-center">
              {horizontalBarData.map((d) => {
                const total = d.input + d.output;
                const pct = hBarMax > 0 ? (total / hBarMax) * 100 : 0;
                return (
                  <Fragment key={d.name}>
                    <span className="text-base text-[var(--color-muted)] whitespace-nowrap">{d.name}</span>
                    <div
                      className="h-7 rounded bg-[var(--color-background)] overflow-hidden"
                      title={`Input: ${formatTokens(d.input)} — Output: ${formatTokens(d.output)}`}
                    >
                      <div
                        className="h-full grid"
                        style={{
                          width: `${Math.max(pct, 0.5)}%`,
                          gridTemplateColumns: `${d.input}fr ${d.output}fr`,
                        }}
                      >
                        <div className="bg-[#22c55e] h-full" />
                        <div className="bg-[var(--color-accent)] h-full" />
                      </div>
                    </div>
                  </Fragment>
                );
              })}
              <span />
              <div className="grid grid-cols-[auto_1fr_auto] text-base text-[var(--color-muted)]">
                <span>0</span>
                <span />
                <span>{formatTokens(hBarMax)}</span>
              </div>
              <span />
              <div className="grid grid-flow-col auto-cols-max gap-4 text-base text-[var(--color-muted)]">
                <span><span className="inline-block w-3 h-3 rounded bg-[#22c55e] mr-1.5 align-middle" />Input</span>
                <span><span className="inline-block w-3 h-3 rounded bg-[var(--color-accent)] mr-1.5 align-middle" />Output</span>
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* Time Range Select */}
      <Section title="Time Range Select">
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
          <p className="text-base text-[var(--color-muted)]">
            Shared <code className="text-[var(--color-accent)]">&lt;TimeRangeSelect&gt;</code> dropdown used on all pages.
            Options: 1h, 3h, 6h, 12h, 24h, 7d, 14d, 28d, Lifetime.
            Persists selection in localStorage via <code className="text-[var(--color-accent)]">useTimeRange(key, default)</code>.
          </p>
          <div className="grid grid-flow-col auto-cols-max gap-3 items-center">
            <TimeRangeSelect value={timeRange} onChange={setTimeRange} />
            <span className="text-base text-[var(--color-muted)]">Current: {timeRange}</span>
          </div>
          <pre className="text-sm text-[var(--color-muted)] bg-[var(--color-background)] p-3 rounded overflow-x-auto">{`import { TimeRangeSelect, useTimeRange, getTimeRangeFrom } from '@unturf/unfirehose-ui/TimeRangeSelect';

const [range, setRange] = useTimeRange('my_page_range', '7d');
const from = getTimeRangeFrom(range); // ISO string or undefined

<TimeRangeSelect value={range} onChange={setRange} />`}</pre>
        </div>
      </Section>

      {/* Interactive */}
      <Section title="Interactive">
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
          <div className="grid grid-flow-col auto-cols-max gap-3 items-center">
            <button className="px-3 py-1.5 text-base bg-[var(--color-accent)] text-[var(--color-background)] rounded font-bold hover:opacity-90 transition-opacity">
              Primary
            </button>
            <button className="px-3 py-1.5 text-base bg-[var(--color-surface-hover)] text-[var(--color-foreground)] rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] transition-colors">
              Secondary
            </button>
            <button className="px-3 py-1.5 text-base bg-transparent text-[var(--color-error)] rounded border border-[var(--color-error)] hover:bg-[var(--color-error)] hover:text-[var(--color-foreground)] transition-colors">
              Danger
            </button>
            <button className="px-3 py-1.5 text-base text-[var(--color-muted)] cursor-not-allowed opacity-50" disabled>
              Disabled
            </button>
          </div>
          <div className="grid grid-flow-col auto-cols-max gap-3 items-center">
            <input
              type="text"
              placeholder="Text input"
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              className="px-2 py-1.5 text-base bg-[var(--color-background)] border border-[var(--color-border)] rounded text-[var(--color-foreground)] w-40"
            />
            <input
              type="number"
              value={numberVal}
              onChange={(e) => setNumberVal(Number(e.target.value))}
              className="px-2 py-1.5 text-base bg-[var(--color-background)] border border-[var(--color-border)] rounded text-[var(--color-foreground)] w-20"
            />
            <select
              value={selectVal}
              onChange={(e) => setSelectVal(e.target.value)}
              className="px-2 py-1.5 text-base bg-[var(--color-background)] border border-[var(--color-border)] rounded text-[var(--color-foreground)]"
            >
              <option value="opus">Opus</option>
              <option value="sonnet">Sonnet</option>
              <option value="haiku">Haiku</option>
            </select>
            <label className="grid grid-flow-col auto-cols-max items-center gap-1.5 text-base text-[var(--color-muted)]">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              Checkbox
            </label>
          </div>
        </div>
      </Section>

      {/* Kanban Cards */}
      <Section title="Kanban Cards">
        <p className="text-base text-[var(--color-muted)]">
          Drag-and-drop todo cards with particle burst effects. Cards have rounded-xl corners, grab cursor,
          and lift + rotate on drag. Drop triggers accent/green particle burst and landing animation.
          In-progress cards glow with user&apos;s accent color and RUNNING indicator. Columns scroll independently.
          Only valid transitions allowed (pending&rarr;active, active&rarr;done). Project kanban at /projects/[project]/kanban.
        </p>
        <div className="grid grid-cols-3 gap-4 mt-3">
          {/* Pending column */}
          <div>
            <div className="flex items-center gap-2 mb-3 pb-2 border-b-2 border-[var(--color-muted)]">
              <span className="text-lg" style={{ color: 'var(--color-muted)' }}>○</span>
              <span className="font-bold text-sm">Pending</span>
              <span className="text-xs text-[var(--color-muted)] ml-auto tabular-nums">3</span>
            </div>
            <div className="space-y-2">
              {/* Normal card */}
              <div className="rounded-xl border border-[var(--color-border)] p-3.5 shadow-md hover:shadow-xl hover:border-[var(--color-muted)] hover:-translate-y-0.5 transition-all cursor-grab active:cursor-grabbing active:scale-[1.03] active:rotate-1" style={{ background: 'color-mix(in srgb, var(--color-accent) 6%, var(--color-surface))' }}>
                <p className="text-sm font-medium mb-2 leading-snug">Add unit tests for auth module</p>
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="px-1.5 py-0.5 rounded bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-medium">claude</span>
                  <span className="px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-muted)]">~15m</span>
                  <span className="ml-auto text-[var(--color-muted)]">2h ago</span>
                </div>
              </div>
              {/* Card with ticket badge */}
              <div className="rounded-xl border border-yellow-400/40 p-3.5 shadow-md cursor-grab" style={{ background: 'color-mix(in srgb, var(--color-accent) 6%, var(--color-surface))' }}>
                <p className="text-sm font-medium mb-2 leading-snug">Refactor ingestion pipeline</p>
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="px-1.5 py-0.5 rounded bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-medium">claude</span>
                  <span className="px-1.5 py-0.5 rounded bg-yellow-400/20 text-yellow-400">~60m</span>
                  <span className="px-1.5 py-0.5 rounded bg-yellow-400/20 text-yellow-400 font-bold">ticket</span>
                </div>
              </div>
              {/* Card being dragged (simulated) */}
              <div className="rounded-xl border border-[var(--color-border)] p-3.5 shadow-2xl opacity-30 scale-90 rotate-2" style={{ background: 'color-mix(in srgb, var(--color-accent) 6%, var(--color-surface))' }}>
                <p className="text-sm font-medium mb-2 leading-snug">Fix PII detection for emails</p>
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="px-1.5 py-0.5 rounded bg-[#34d39922] text-[#34d399] font-medium">manual</span>
                  <span className="px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-muted)]">~5m</span>
                </div>
              </div>
            </div>
          </div>
          {/* In Progress column */}
          <div>
            <div className="flex items-center gap-2 mb-3 pb-2 border-b-2 border-[#fbbf24]">
              <span className="text-lg" style={{ color: '#fbbf24' }}>◉</span>
              <span className="font-bold text-sm">In Progress</span>
              <span className="text-xs text-[var(--color-muted)] ml-auto tabular-nums">1</span>
            </div>
            {/* Drop zone highlight */}
            <div className="border-2 border-dashed border-[var(--color-accent)] rounded-lg p-3 mb-2 bg-[var(--color-accent)]/10 text-center">
              <span className="text-sm font-bold text-[var(--color-accent)]">Drop to power up agent</span>
            </div>
            <div className="space-y-2">
              {/* Active card with accent glow + RUNNING */}
              <div className="rounded-xl border border-[var(--color-accent)]/50 p-3.5 shadow-lg shadow-[0_0_12px_var(--color-accent)]" style={{ background: 'color-mix(in srgb, var(--color-accent) 10%, var(--color-surface))' }}>
                <div className="flex items-center gap-1.5 mb-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] animate-pulse" />
                  <span className="text-xs font-bold text-[var(--color-accent)]">RUNNING</span>
                </div>
                <p className="text-sm font-medium mb-2 leading-snug">Translate Polish (pl) - 1016 strings</p>
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="px-1.5 py-0.5 rounded bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-medium">claude</span>
                  <span className="px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-muted)]">~30m</span>
                  <span className="px-1.5 py-0.5 rounded text-xs font-bold bg-[var(--color-accent)] text-white">Deploy</span>
                </div>
              </div>
              {/* Landed card (simulated glow burst) */}
              <div className="rounded-xl border border-[var(--color-accent)]/50 p-3.5 card-landed shadow-lg shadow-[0_0_12px_var(--color-accent)]" style={{ background: 'color-mix(in srgb, var(--color-accent) 10%, var(--color-surface))' }}>
                <div className="flex items-center gap-1.5 mb-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] animate-pulse" />
                  <span className="text-xs font-bold text-[var(--color-accent)]">RUNNING</span>
                </div>
                <p className="text-sm font-medium mb-2 leading-snug">Just landed (burst animation)</p>
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="px-1.5 py-0.5 rounded bg-[#34d39922] text-[#34d399] font-medium">manual</span>
                </div>
              </div>
            </div>
          </div>
          {/* Completed column */}
          <div>
            <div className="flex items-center gap-2 mb-3 pb-2 border-b-2 border-[#10b981]">
              <span className="text-lg" style={{ color: '#10b981' }}>●</span>
              <span className="font-bold text-sm">Completed</span>
              <span className="text-xs text-[var(--color-muted)]">last 6d</span>
              <span className="text-xs text-[var(--color-muted)] ml-auto tabular-nums">2</span>
            </div>
            <div className="text-xs text-[var(--color-muted)] font-bold mb-1.5">2026-03-05</div>
            <div className="space-y-1.5">
              <div className="rounded-lg border border-[#10b981]/20 p-2.5 text-sm" style={{ background: 'color-mix(in srgb, var(--color-accent) 4%, var(--color-surface))' }}>
                <p className="line-through text-[var(--color-muted)] text-xs leading-snug">Setup project scaffolding</p>
                <div className="flex items-center gap-1.5 mt-1 text-xs text-[var(--color-muted)]">
                  <span className="px-1.5 py-0.5 rounded bg-[#34d39922] text-[#34d399] font-medium">manual</span>
                  <span className="text-[#10b981]">1h ago</span>
                </div>
              </div>
              <div className="rounded-lg border border-[#10b981]/20 p-2.5 text-sm" style={{ background: 'color-mix(in srgb, var(--color-accent) 4%, var(--color-surface))' }}>
                <p className="line-through text-[var(--color-muted)] text-xs leading-snug">Fix auth token refresh</p>
                <div className="flex items-center gap-1.5 mt-1 text-xs text-[var(--color-muted)]">
                  <span className="px-1.5 py-0.5 rounded bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-medium">claude</span>
                  <span className="text-[#10b981]">3h ago</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* Bootstrap Harness */}
      <Section title="Bootstrap Harness">
        <p className="text-base text-[var(--color-muted)]">
          Panel for bootstrapping Claude Code or custom harnesses on local or remote hosts via SSH.
          Selects host from mesh nodes, harness type, project, multiplexer (tmux/screen), and mode.
          Located on the Usage page below Mesh Status. Calls POST /api/boot.
        </p>
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
          <h3 className="text-base font-bold text-[var(--color-muted)]">Bootstrap Harness</h3>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {/* Host */}
            <div>
              <label className="text-base text-[var(--color-muted)] block mb-1">Host</label>
              <select className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono" defaultValue="localhost">
                <option value="localhost">localhost</option>
                <option value="perma1.foxhop.net">perma1.foxhop.net (2 claudes)</option>
                <option value="perma2.foxhop.net">perma2.foxhop.net (0 claudes)</option>
              </select>
            </div>

            {/* Harness */}
            <div>
              <label className="text-base text-[var(--color-muted)] block mb-1">Harness</label>
              <select className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base" defaultValue="claude">
                <option value="claude">Claude Code</option>
                <option value="custom">Custom Command</option>
              </select>
            </div>

            {/* Multiplexer */}
            <div>
              <label className="text-base text-[var(--color-muted)] block mb-1">Multiplexer</label>
              <div className="flex gap-2">
                <div className="flex-1 px-3 py-1.5 text-base rounded border border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-bold text-center">
                  tmux
                </div>
                <div className="flex-1 px-3 py-1.5 text-base rounded border border-[var(--color-border)] text-center text-[var(--color-muted)]">
                  screen
                </div>
              </div>
            </div>

            {/* Mode */}
            <div>
              <label className="text-base text-[var(--color-muted)] block mb-1">Mode</label>
              <div className="w-full px-3 py-1.5 text-base rounded border border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-bold text-center">
                YOLO (skip perms)
              </div>
            </div>
          </div>

          {/* Project */}
          <div>
            <label className="text-base text-[var(--color-muted)] block mb-1">Project</label>
            <div className="flex gap-2">
              <select className="flex-1 bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono" defaultValue="/home/fox/git/unfirehose-nextjs-logger">
                <option value="">select project...</option>
                <option value="/home/fox/git/unfirehose-nextjs-logger">unfirehose-nextjs-logger</option>
                <option value="/home/fox/git/unsandbox.com">unsandbox-com</option>
              </select>
              <input
                type="text"
                placeholder="or enter path: /home/fox/git/..."
                className="flex-1 bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono"
                readOnly
              />
            </div>
          </div>

          {/* Prompt */}
          <div>
            <label className="text-base text-[var(--color-muted)] block mb-1">Initial Prompt (optional)</label>
            <input
              type="text"
              placeholder="e.g. fix the failing tests"
              className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base"
              readOnly
            />
          </div>

          {/* Boot button + result */}
          <div className="flex items-center gap-3">
            <button className="px-6 py-2 text-base font-bold rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors cursor-pointer">
              Boot Claude on localhost
            </button>
            <div className="text-base text-green-400 font-mono">
              tmux session: unfirehose-nextjs-logger
              <span className="text-[var(--color-muted)] ml-2">
                tmux attach -t unfirehose-nextjs-logger
              </span>
            </div>
          </div>
        </div>

        <pre className="text-sm text-[var(--color-muted)] bg-[var(--color-background)] p-3 rounded overflow-x-auto mt-3">{`POST /api/boot
{
  "projectPath": "/home/fox/git/myproject",
  "harness": "claude",            // or custom command string
  "preferMultiplexer": "tmux",    // "tmux" | "screen"
  "yolo": true,                   // --dangerously-skip-permissions
  "prompt": "fix the tests",      // optional initial prompt
  "host": "perma1.foxhop.net"     // omit for localhost
}

Response:
{
  "success": true,
  "tmuxSession": "myproject",
  "tmuxWindow": "143022",
  "multiplexer": "tmux",
  "host": "perma1.foxhop.net",
  "command": "ssh perma1.foxhop.net tmux attach -t myproject"
}`}</pre>
      </Section>

      {/* Progress Bars */}
      <Section title="Progress Bars">
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-2">
          <ProgressBar value={0} label="0%" />
          <ProgressBar value={23} label="23%" />
          <ProgressBar value={50} label="50%" />
          <ProgressBar value={78} label="78%" />
          <ProgressBar value={100} label="100%" />
        </div>
      </Section>

      {/* Layout — border indicators */}
      <Section title="Layout — Border Indicators">
        <div className="space-y-2">
          {BORDER_TYPES.map((bt) => (
            <div
              key={bt.label}
              className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-3 text-base"
              style={{ borderLeftWidth: 3, borderLeftColor: bt.color }}
            >
              <span className="font-bold" style={{ color: bt.color }}>{bt.label}</span>
              <span className="text-[var(--color-muted)]"> — sample message content for this role type.</span>
            </div>
          ))}
        </div>
      </Section>

      {/* Scrobble */}
      <Section title="Scrobble">
        <p className="text-base text-[var(--color-muted)]">
          Public usage metrics page. No prompts, responses, or code — only aggregate counts, streaks, badges,
          and activity patterns. Visibility per-project (public / unlisted / private). Toggle on/off globally.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Stat cards */}
          <div className="space-y-3">
            <h4 className="text-sm font-bold text-[var(--color-muted)]">StatCard — hero metrics</h4>
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-3">
                <div className="text-base text-[var(--color-muted)]">Sessions</div>
                <div className="text-base font-bold">1,247</div>
              </div>
              <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-3">
                <div className="text-base text-[var(--color-muted)]">Active Days</div>
                <div className="text-base font-bold">89</div>
              </div>
              <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-3">
                <div className="text-base text-[var(--color-muted)]">Streak</div>
                <div className="text-base font-bold text-[var(--color-accent)]">14d</div>
              </div>
            </div>
          </div>

          {/* Visibility selector */}
          <div className="space-y-3">
            <h4 className="text-sm font-bold text-[var(--color-muted)]">Project Visibility Selector</h4>
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] px-4 py-3 flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-base font-bold">unfirehose-nextjs-logger</span>
                  <span className="text-xs px-1.5 py-0.5 rounded" style={{ color: '#10b981', backgroundColor: '#10b98122' }}>public</span>
                </div>
                <div className="text-base text-[var(--color-muted)] mt-0.5">24 sessions / 1.2K msgs / 4.8M tokens</div>
              </div>
              <div className="flex gap-1 shrink-0">
                {['public', 'unlisted', 'private'].map(opt => (
                  <span key={opt} className={`px-2 py-1 text-base rounded border ${opt === 'public' ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-muted)]'}`}>
                    {opt}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Badge cards */}
        <div className="space-y-3 mt-4">
          <h4 className="text-sm font-bold text-[var(--color-muted)]">BadgeCard — earned vs locked, tier colors</h4>
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
            {[
              { name: 'First Blood', desc: 'First session', earned: true, tier: 'bronze' },
              { name: 'Centurion', desc: '100 sessions', earned: true, tier: 'silver' },
              { name: 'Token Lord', desc: '1M tokens', earned: true, tier: 'gold' },
              { name: 'Diamond Mind', desc: '10M tokens', earned: true, tier: 'diamond' },
              { name: 'Night Owl', desc: 'Code at 3am', earned: false, progress: 0.7 },
              { name: 'Marathon', desc: '30d streak', earned: false, progress: 0.4 },
            ].map(b => {
              const tierColors: Record<string, string> = { bronze: '#cd7f32', silver: '#c0c0c0', gold: '#ffd700', diamond: '#b9f2ff' };
              const color = b.earned ? (tierColors[b.tier ?? ''] ?? 'var(--color-accent)') : 'var(--color-muted)';
              return (
                <div key={b.name} className={`rounded border p-3 text-center ${b.earned ? 'border-[var(--color-border)] bg-[var(--color-surface)]' : 'border-[var(--color-border)] bg-[var(--color-background)] opacity-50'}`}>
                  <div className="text-lg" style={{ color }}>{b.earned ? '◆' : '◇'}</div>
                  <div className="text-base font-bold mt-1" style={{ color: b.earned ? color : undefined }}>{b.name}</div>
                  <div className="text-xs text-[var(--color-muted)]">{b.desc}</div>
                  {b.progress !== undefined && b.progress < 1 && (
                    <div className="mt-2 h-1 bg-[var(--color-border)] rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${b.progress * 100}%`, backgroundColor: color }} />
                    </div>
                  )}
                  {b.tier && b.earned && <div className="text-xs uppercase mt-1" style={{ color }}>{b.tier}</div>}
                </div>
              );
            })}
          </div>
        </div>

        {/* Heatmap */}
        <div className="space-y-3 mt-4">
          <h4 className="text-sm font-bold text-[var(--color-muted)]">Activity Heatmap — rows = days, cols = hours, intensity = accent color-mix</h4>
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <div className="inline-grid gap-0.5" style={{ gridTemplateColumns: 'auto repeat(24, 1fr)' }}>
              <div />
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="text-xs text-[var(--color-muted)] text-center w-5">{h % 3 === 0 ? h : ''}</div>
              ))}
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, dow) => (
                <Fragment key={dow}>
                  <div className="text-xs text-[var(--color-muted)] pr-1 leading-5">{day}</div>
                  {Array.from({ length: 24 }, (_, h) => {
                    const intensity = Math.random() * (h >= 9 && h <= 22 && dow >= 1 && dow <= 5 ? 1 : 0.2);
                    return (
                      <div
                        key={h}
                        className="w-5 h-5 rounded-sm"
                        style={{
                          backgroundColor: intensity > 0.05
                            ? `color-mix(in srgb, var(--color-accent) ${Math.round(intensity * 100)}%, var(--color-surface))`
                            : 'var(--color-surface)',
                        }}
                      />
                    );
                  })}
                </Fragment>
              ))}
            </div>
          </div>
        </div>

        {/* Bar chart */}
        <div className="space-y-3 mt-4">
          <h4 className="text-sm font-bold text-[var(--color-muted)]">CSS BarChart — hour of day, daily cost (no recharts)</h4>
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <div className="flex items-end gap-px h-24">
              {barChartValues.map(({ h, value }) => (
                  <div key={h} className="flex-1 flex flex-col items-center justify-end h-full">
                    <div
                      className="w-full rounded-t-sm min-h-px"
                      style={{
                        height: `${value * 100}%`,
                        backgroundColor: 'var(--color-accent)',
                        opacity: 0.6 + value * 0.4,
                      }}
                    />
                    <div className="text-[8px] text-[var(--color-muted)] mt-0.5">{h % 3 === 0 ? h : ''}</div>
                  </div>
                ))}
            </div>
          </div>
        </div>

        {/* Shared / Not shared */}
        <div className="grid grid-cols-2 gap-4 mt-4">
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-1">
            <h4 className="text-base font-bold text-green-400">Scrobbled</h4>
            {['Session counts', 'Model/harness names', 'Activity heatmap', 'Streaks + badges'].map((item, i) => (
              <div key={i} className="text-base text-[var(--color-muted)]"><span className="text-green-400 mr-2">+</span>{item}</div>
            ))}
          </div>
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-1">
            <h4 className="text-base font-bold text-red-400">Never Shared</h4>
            {['Prompts & responses', 'File contents & diffs', 'Thinking traces', 'PII (sanitized)'].map((item, i) => (
              <div key={i} className="text-base text-[var(--color-muted)]"><span className="text-red-400 mr-2">-</span>{item}</div>
            ))}
          </div>
        </div>
      </Section>

      {/* Surface cards */}
      <Section title="Layout — Surface Cards">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <div className="text-base text-[var(--color-muted)]">Default surface card</div>
            <div className="text-base mt-2">Standard content area with border.</div>
          </div>
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-accent)] p-4">
            <div className="text-base text-[var(--color-accent)]">Accent bordered card</div>
            <div className="text-base mt-2">Highlighted / selected state.</div>
          </div>
        </div>
      </Section>

      {/* Motion & Animation */}
      <Section title="Motion & Animation">
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
          <p className="text-base text-[var(--color-muted)]">
            Animations serve feedback, not decoration. All use <code className="text-[var(--color-accent)]">ease-out</code> for natural deceleration.
            Defined in <code className="text-[var(--color-accent)]">globals.css</code> as <code className="text-[var(--color-accent)]">@keyframes</code>.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-3">
              <h4 className="text-sm font-bold text-[var(--color-muted)]">Duration Scale</h4>
              <div className="space-y-1">
                {[
                  ['150ms', 'Micro', 'Color transitions, opacity, hover states'],
                  ['200ms', 'Short', 'Output expand, content reveal'],
                  ['350ms', 'Medium', 'Card scale-in, capacitor flash'],
                  ['600ms', 'Long', 'Card-landed burst, particle effects'],
                  ['900ms', 'Extended', 'Slow particles, ambient effects'],
                  ['4000ms', 'Ambient', 'Vault pulse glow (loops)'],
                ].map(([dur, name, usage]) => (
                  <div key={dur} className="grid grid-cols-[5rem_4rem_1fr] gap-2 items-center text-sm">
                    <code className="text-[var(--color-accent)]">{dur}</code>
                    <span className="font-bold">{name}</span>
                    <span className="text-[var(--color-muted)]">{usage}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-3">
              <h4 className="text-sm font-bold text-[var(--color-muted)]">Animation Catalog</h4>
              <div className="space-y-1">
                {[
                  ['card-landed', '0.6s', 'Drop burst glow ring'],
                  ['card-scale-in', '0.35s', 'Scale + rotate entrance'],
                  ['burst-particle', 'varies', 'Translate + fade-out'],
                  ['powerup-particle', '0.6s', 'Explosion from center'],
                  ['powerup-shockwave', '0.6s', 'Expanding ring'],
                  ['capacitor-core', '0.35s', 'Core shrink (power-down)'],
                  ['column-pulse', '0.4s', 'Accent background flash'],
                  ['output-expand', '0.2s', 'Inline content reveal'],
                ].map(([name, dur, desc]) => (
                  <div key={name} className="grid grid-cols-[10rem_4rem_1fr] gap-2 items-center text-sm">
                    <code className="text-[var(--color-accent)]">{name}</code>
                    <span className="text-[var(--color-muted)]">{dur}</span>
                    <span className="text-[var(--color-muted)]">{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 mt-2">
            <div className="text-center space-y-2">
              <div className="card-landed rounded-lg border border-[var(--color-accent)]/50 p-4 bg-[var(--color-accent)]/10">
                <span className="text-sm font-bold text-[var(--color-accent)]">card-landed</span>
              </div>
              <span className="text-xs text-[var(--color-muted)]">Plays on page load</span>
            </div>
            <div className="text-center space-y-2">
              <div className="column-drop-pulse rounded-lg border border-[var(--color-border)] p-4">
                <span className="text-sm font-bold">column-pulse</span>
              </div>
              <span className="text-xs text-[var(--color-muted)]">Plays on page load</span>
            </div>
            <div className="text-center space-y-2">
              <div className="output-reveal-inline rounded-lg border border-[var(--color-border)] p-4">
                <span className="text-sm font-bold">output-expand</span>
              </div>
              <span className="text-xs text-[var(--color-muted)]">Plays on page load</span>
            </div>
          </div>
        </div>
      </Section>

      {/* Interaction States */}
      <Section title="Interaction States">
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
          <p className="text-base text-[var(--color-muted)]">
            State layers communicate interactivity. Every interactive element follows this state machine.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              ['Enabled', 'border-[var(--color-border)]', 'Default resting state'],
              ['Hover', 'border-[var(--color-accent)]', 'Accent border, 150ms'],
              ['Focused', 'border-[var(--color-accent)] outline outline-1 outline-[var(--color-accent)]', '1px accent outline'],
              ['Active', 'border-[var(--color-accent)] scale-[0.98]', 'Scale down on press'],
              ['Disabled', 'border-[var(--color-border)] opacity-50', 'Half opacity, no cursor'],
            ].map(([state, classes, desc]) => (
              <div key={state} className="space-y-2 text-center">
                <div className={`h-12 rounded border ${classes} bg-[var(--color-background)] grid place-items-center text-sm font-bold`}>
                  {state}
                </div>
                <div className="text-xs text-[var(--color-muted)]">{desc}</div>
              </div>
            ))}
          </div>
          <div className="space-y-2 mt-2">
            <h4 className="text-sm font-bold text-[var(--color-muted)]">Drag States (Kanban)</h4>
            <div className="grid grid-cols-4 gap-3 text-center">
              {[
                ['Grabbable', 'Default grab cursor'],
                ['Grabbing', 'Lift + slight rotate'],
                ['Ghost', 'Source placeholder, 30% opacity'],
                ['Drop Zone', 'Dashed accent border'],
              ].map(([state, desc]) => (
                <div key={state} className="space-y-1">
                  <div className="text-sm font-bold">{state}</div>
                  <div className="text-xs text-[var(--color-muted)]">{desc}</div>
                </div>
              ))}
            </div>
          </div>
          <p className="text-base text-[var(--color-muted)]">
            Text selection: <code className="text-[var(--color-accent)]">::selection</code> with 25% accent.
            Focus rings: <code className="text-[var(--color-accent)]">1px solid var(--color-accent), offset -1px</code>.
            Checkbox accent tracks <code className="text-[var(--color-accent)]">var(--color-accent)</code>.
          </p>
          <div className="mt-3 rounded border border-[#ef4444]/30 bg-[#ef4444]/5 p-3 space-y-2">
            <h4 className="text-sm font-bold" style={{ color: '#ef4444' }}>Anti-pattern: hover-reveal actions</h4>
            <p className="text-sm text-[var(--color-muted)]">
              Never hide buttons/actions behind <code className="text-[var(--color-accent)]">opacity-0 group-hover:opacity-100</code>.
              This is unusable on touch, invisible to keyboard users, and creates a jarring pop-in.
              Instead: show actions inline at reduced opacity (0.5) and brighten on hover/focus.
              For destructive actions in dense lists, use a right-click context menu or a dedicated action row.
            </p>
            <div className="grid grid-cols-2 gap-3 text-center text-xs">
              <div className="rounded border border-[#ef4444]/30 p-2">
                <div className="font-bold" style={{ color: '#ef4444' }}>Bad</div>
                <code className="text-[var(--color-muted)]">opacity-0 group-hover:opacity-100</code>
              </div>
              <div className="rounded border border-[#22c55e]/30 p-2">
                <div className="font-bold" style={{ color: '#22c55e' }}>Good</div>
                <code className="text-[var(--color-muted)]">opacity-50 hover:opacity-100</code>
              </div>
            </div>
          </div>
          <div className="mt-3 rounded border border-[#ef4444]/30 bg-[#ef4444]/5 p-3 space-y-2">
            <h4 className="text-sm font-bold" style={{ color: '#ef4444' }}>Anti-pattern: confirm() / alert()</h4>
            <p className="text-sm text-[var(--color-muted)]">
              Never use <code className="text-[var(--color-accent)]">window.confirm()</code> or{' '}
              <code className="text-[var(--color-accent)]">window.alert()</code>. Browsers let users
              permanently block these per-origin with no way to undo except DevTools. Use inline
              two-click confirmation instead: first click arms (button text changes to
              {' '}<code className="text-[var(--color-accent)]">&quot;confirm?&quot;</code>), second click executes.
              Auto-disarm after 3 seconds.
            </p>
          </div>
        </div>
      </Section>

      {/* Iconography */}
      <Section title="Iconography">
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
          <p className="text-base text-[var(--color-muted)]">
            No icon library. Unicode text symbols only — consistent with monospace-first aesthetic.
            Zero font loading, zero bundle cost, renders identically everywhere.
          </p>
          <div className="grid grid-cols-4 md:grid-cols-9 gap-3">
            {[
              ['\u25CF', 'Live'],
              ['\u25CB', 'Inactive'],
              ['\u25C9', 'Working'],
              ['\u25B8', 'Play'],
              ['\u25C7', 'Dashboard'],
              ['\u25A0', 'Projects'],
              ['\u2630', 'Menu'],
              ['\u25C8', 'Graph'],
              ['\u25CE', 'Target'],
              ['\u2261', 'Logs'],
              ['\u00A4', 'Token'],
              ['\u25B3', 'Usage'],
              ['\u266A', 'Scrobble'],
              ['{', 'Schema'],
              ['\u25D0', 'Style'],
              ['\u2699', 'Settings'],
              ['\u25C6', 'Earned'],
              ['\u25C7', 'Locked'],
            ].map(([icon, label], i) => (
              <div key={i} className="text-center space-y-1">
                <div className="text-lg font-bold text-[var(--color-accent)]">{icon}</div>
                <div className="text-xs text-[var(--color-muted)]">{label}</div>
              </div>
            ))}
          </div>
          <p className="text-base text-[var(--color-muted)]">
            Active: <code className="text-[var(--color-accent)]">text-[var(--color-accent)]</code>.
            Inactive: <code className="text-[var(--color-accent)]">text-[var(--color-border)]</code>.
            Running pulse: <code className="text-[var(--color-accent)]">w-1.5 h-1.5 rounded-full animate-pulse</code>.
          </p>
        </div>
      </Section>

      {/* Responsive Breakpoints */}
      <Section title="Responsive Breakpoints">
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
          <p className="text-base text-[var(--color-muted)]">
            Mobile-first with Tailwind v4 defaults. Sidebar collapses below md. Grid columns adapt at each tier.
          </p>
          <div className="space-y-1">
            {[
              ['default', '0px', '1 column', 'Mobile, sidebar hidden'],
              ['sm', '640px', '1-2 columns', 'Small tablets'],
              ['md', '768px', '2-3 columns', 'Sidebar visible, 2-col grids'],
              ['lg', '1024px', '3-4 columns', 'Full dashboard, 3-col grids'],
              ['xl', '1280px', '4+ columns', 'Wide monitors, 4-col cards'],
              ['2xl', '1536px', 'Max width', 'Ultra-wide, no max-w'],
            ].map(([bp, px, cols, usage]) => (
              <div key={bp} className="grid grid-cols-[3rem_5rem_8rem_1fr] gap-2 items-center text-sm">
                <code className="text-[var(--color-accent)] font-bold">{bp}</code>
                <span className="text-[var(--color-muted)]">{px}</span>
                <span className="font-bold">{cols}</span>
                <span className="text-[var(--color-muted)]">{usage}</span>
              </div>
            ))}
          </div>
          <h4 className="text-sm font-bold text-[var(--color-muted)]">Common Grid Patterns</h4>
          <div className="space-y-1 text-sm">
            {[
              ['grid-cols-1 md:grid-cols-2', 'Settings, split layouts'],
              ['grid-cols-1 md:grid-cols-3', 'Stat cards, kanban columns'],
              ['grid-cols-3 md:grid-cols-6', 'Badges, color swatches'],
              ['grid-cols-[auto_1fr]', 'Label + content (all sizes)'],
            ].map(([pattern, usage]) => (
              <div key={pattern} className="grid grid-cols-[1fr_1fr] gap-2 items-center">
                <code className="text-[var(--color-accent)]">{pattern}</code>
                <span className="text-[var(--color-muted)]">{usage}</span>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* Accessibility */}
      <Section title="Accessibility">
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
          <p className="text-base text-[var(--color-muted)]">
            Minimum standards for operator software. Not a public marketing site, but usability matters.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <h4 className="text-sm font-bold text-[var(--color-muted)]">Contrast Ratios</h4>
              <div className="space-y-1 text-sm">
                {[
                  ['Foreground on background', '17.4:1', true],
                  ['Muted on background', '7.2:1', true],
                  ['Accent (#d40000) on bg', '4.8:1', true],
                  ['Muted on surface', '5.7:1', true],
                ].map(([label, ratio, pass]) => (
                  <div key={label} className="grid grid-cols-[1fr_auto] gap-2">
                    <span>{label}</span>
                    <span className={pass ? 'text-green-400' : 'text-yellow-400'} style={{ fontWeight: 'bold' }}>{ratio}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-[var(--color-muted)]">
                WCAG AA: 4.5:1 text, 3:1 large text. Custom accent colors may reduce contrast.
              </p>
            </div>
            <div className="space-y-2">
              <h4 className="text-sm font-bold text-[var(--color-muted)]">Keyboard & Focus</h4>
              <div className="space-y-1 text-sm text-[var(--color-muted)]">
                <div>Natively focusable elements (button, input, select, a)</div>
                <div>Focus ring: 1px accent outline, visible on all backgrounds</div>
                <div>Tab order follows DOM (no tabindex hacks)</div>
                <div>Escape closes modals and overlays</div>
              </div>
              <h4 className="text-sm font-bold text-[var(--color-muted)] mt-3">Touch Targets</h4>
              <div className="space-y-1 text-sm text-[var(--color-muted)]">
                <div>Buttons: min py-1.5 (36px height)</div>
                <div>Sidebar: full-width click area</div>
                <div>Kanban: full card is draggable</div>
                <div>Scrollbar: 8px width</div>
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* Data Visualization Guidelines */}
      <Section title="Data Visualization Guidelines">
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
          <p className="text-base text-[var(--color-muted)]">
            Charts use Recharts or pure CSS. All chart styling overridden in globals.css to match theme.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <h4 className="text-sm font-bold text-[var(--color-muted)]">Color Assignment</h4>
              <div className="space-y-1 text-sm">
                {[
                  ['Primary metric', 'var(--color-accent)'],
                  ['Input tokens', '#22c55e (green)'],
                  ['Output tokens', 'var(--color-accent)'],
                  ['Pie rotation', 'accent → user → tool'],
                ].map(([role, color]) => (
                  <div key={role} className="grid grid-cols-[8rem_1fr] gap-2">
                    <span className="font-bold">{role}</span>
                    <span className="text-[var(--color-muted)]">{color}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <h4 className="text-sm font-bold text-[var(--color-muted)]">Chart Text</h4>
              <div className="space-y-1 text-sm text-[var(--color-muted)]">
                <div>Axes: 16px, #71717a</div>
                <div>Tooltip label: 16px bold, #fafafa</div>
                <div>Tooltip values: 16px semi-bold, #fafafa</div>
                <div>Legend: 16px, #d4d4d8</div>
              </div>
            </div>
          </div>
          <p className="text-sm text-[var(--color-muted)]">
            Tooltips: forced dark surface #18181b, 6px radius, 8px 12px padding, deep shadow.
            Light mode swaps via <code className="text-[var(--color-accent)]">:root.light</code> overrides.
          </p>
        </div>
      </Section>

      {/* Vault Gate */}
      <Section title="Vault Gate — Lock Screen">
        <div className="rounded-xl border border-[var(--color-border)] overflow-hidden relative" style={{ height: 520 }}>
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-background)]">
            {/* Glow */}
            <div className="absolute w-[400px] h-[400px] rounded-full opacity-15 blur-[100px] pointer-events-none" style={{ background: 'radial-gradient(circle, var(--color-accent) 0%, transparent 70%)', animation: 'vaultPulse 4s ease-in-out infinite' }} />
            <style>{`
              @keyframes vaultPulse { 0%, 100% { transform: scale(1); opacity: 0.12; } 50% { transform: scale(1.15); opacity: 0.2; } }
            `}</style>
            <div className="w-full max-w-md space-y-6 p-8 relative z-10">
              <div className="text-center">
                <h1 className="font-black leading-none" style={{ fontSize: '3.5rem', letterSpacing: '-0.06em', WebkitTextStroke: '0.5px currentColor' }}>
                  <span className="text-[var(--color-foreground)]">un</span>
                  <span className="text-[var(--color-accent)]">firehose</span>
                </h1>
                <p className="text-sm text-[var(--color-muted)] mt-2 tracking-widest uppercase">Permacomputer Dashboard</p>
              </div>
              <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-8 space-y-5" style={{ boxShadow: '0 0 60px rgba(239, 68, 68, 0.08), 0 25px 50px rgba(0,0,0,0.5)' }}>
                <div className="text-center space-y-3">
                  <div className="text-5xl">{'\u{1F510}'}</div>
                  <h2 className="text-xl font-bold">Create your vault</h2>
                  <p className="text-sm text-[var(--color-muted)]">Choose a password to encrypt your API keys locally. Keys never leave your browser.</p>
                </div>
                <input
                  type="password"
                  readOnly
                  placeholder="Choose a password (8+ chars)"
                  className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded-lg px-4 py-3 text-base focus:outline-none"
                />
                <button className="w-full px-6 py-3 text-base font-bold text-[var(--color-background)] rounded-lg cursor-default" style={{ background: 'linear-gradient(135deg, var(--color-accent), #ff6b6b)', boxShadow: '0 4px 20px rgba(239, 68, 68, 0.3)' }}>
                  Create Vault
                </button>
                <p className="text-xs text-[var(--color-muted)] text-center">No recovery if you forget this password.</p>
                <div className="text-xs text-[var(--color-muted)] text-center">Skip — use without saving keys</div>
              </div>
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}
