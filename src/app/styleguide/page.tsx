'use client';

import { useState, Fragment } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
  AreaChart, Area,
} from 'recharts';
import { PageContext } from '@/components/PageContext';

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
  { name: 'claude-sexy-logger', input: 90000, output: 195000 },
  { name: 'uncloseai-com', input: 45000, output: 82000 },
  { name: 'funlooper-com', input: 12000, output: 35000 },
];

const PIE_COLORS = ['#10b981', '#60a5fa', '#fbbf24'];

const CSS_VARS = [
  { name: '--color-background', hex: '#09090b' },
  { name: '--color-foreground', hex: '#fafafa' },
  { name: '--color-surface', hex: '#18181b' },
  { name: '--color-surface-hover', hex: '#27272a' },
  { name: '--color-border', hex: '#3f3f46' },
  { name: '--color-muted', hex: '#a1a1aa' },
  { name: '--color-accent', hex: '#10b981' },
  { name: '--color-thinking', hex: '#a78bfa' },
  { name: '--color-user', hex: '#60a5fa' },
  { name: '--color-assistant', hex: '#34d399' },
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

  const hBarMax = Math.max(...horizontalBarData.map((d) => d.input + d.output), 1);

  return (
    <div className="space-y-8 max-w-4xl">
      <PageContext
        pageType="styleguide"
        summary="Component reference and design system for claude_sexy_logger."
        metrics={{ components: 12, sections: 8 }}
      />

      <h2 className="text-lg font-bold">
        Styleguide{' '}
        <span className="text-[var(--color-muted)] font-normal">component reference</span>
      </h2>

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
                <Bar dataKey="value" fill="#10b981" radius={[2, 2, 0, 0]} />
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
                <Area type="monotone" dataKey="tokens" stroke="#10b981" fill="#10b98130" />
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
                        <div className="bg-[#a78bfa] h-full" />
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
                <span><span className="inline-block w-3 h-3 rounded bg-[#a78bfa] mr-1.5 align-middle" />Output</span>
              </div>
            </div>
          </div>
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
