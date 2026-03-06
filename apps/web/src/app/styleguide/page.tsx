'use client';

import { useState, useRef, Fragment } from 'react';
import useSWR from 'swr';
import { TimeRangeSelect, useTimeRange } from '@unfirehose/ui/TimeRangeSelect';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
  AreaChart, Area,
} from 'recharts';
import { PageContext } from '@unfirehose/ui/PageContext';

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
          background: 'linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
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

  return (
    <div className="space-y-8 max-w-4xl">
      <PageContext
        pageType="styleguide"
        summary="Component reference and design system for unfirehose."
        metrics={{ components: 12, sections: 8 }}
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
                <div className="text-[10px] uppercase tracking-widest text-[var(--color-muted)] opacity-60 mb-2">{group.title}</div>
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

      {/* Typography */}
      <Section title="Typography">
        <div className="space-y-2 bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h1 className="text-2xl font-bold">Heading 2XL — bold</h1>
          <h2 className="text-lg font-bold">Heading LG — bold</h2>
          <h3 className="text-base font-bold">Heading Base — bold</h3>
          <p className="text-base">Body text — base regular</p>
          <p className="text-base text-[var(--color-muted)]">Muted caption — base muted</p>
          <p className="text-base text-[var(--color-accent)]">Accent text — base accent</p>
          <p className="text-base font-mono bg-[var(--color-background)] inline-block px-2 py-0.5 rounded">
            Monospace inline
          </p>
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
          <pre className="text-sm text-[var(--color-muted)] bg-[var(--color-background)] p-3 rounded overflow-x-auto">{`import { TimeRangeSelect, useTimeRange, getTimeRangeFrom } from '@unfirehose/ui/TimeRangeSelect';

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
    </div>
  );
}
