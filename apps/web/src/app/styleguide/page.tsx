'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { HexColorPicker } from '@/components/HexColorPicker';
import { Donut } from '@/components/Donut';
import { UPlotCategoryChart } from '@/components/UPlotCategoryChart';
import { TimeRangeSelect, useTimeRange } from '@unturf/unfirehose-ui/TimeRangeSelect';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import { MessageBlock } from '@unturf/unfirehose-ui/viewer/MessageBlock';
import { groupNavItems } from '@unturf/unfirehose-ui/layout/nav-items';
import { StatCard } from '@unturf/unfirehose-ui/StatCard';
import { EmptyState } from '@unturf/unfirehose-ui/EmptyState';
import { GaugeTrack, GaugeRow, GaugeBlock, GaugeCard, GaugePill } from '@unturf/unfirehose-ui/Gauge';
import { KV, MiniStat } from '@unturf/unfirehose-ui/KV';

/*
 * A living reference: one example per component or token family the app
 * really uses, rendered by the real component wherever one exists. Tables of
 * values, rationale and rules live in docs/design-system.md — link there
 * rather than restating it here, so the two cannot drift.
 */

const DOCS = 'docs/design-system.md';

const TOKENS = [
  'background', 'surface', 'surface-hover', 'border', 'foreground', 'muted',
  'accent', 'error', 'user', 'assistant', 'thinking', 'tool',
];
const RED_STEPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];

const BAR_DATA = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((name, i) => ({ name, value: [420, 680, 310, 890, 560, 220, 150][i] }));
const LINE_DATA = BAR_DATA.map((d, i) => ({ date: `Mar ${i + 1}`, tokens: d.value * 6 }));
const DONUT_DATA = [
  { name: 'Opus', value: 62, color: '#d40000' },
  { name: 'Sonnet', value: 28, color: '#60a5fa' },
  { name: 'Haiku', value: 10, color: '#fbbf24' },
];

// Canonical unfirehose/1.0 messages, one per MessageBlock branch worth seeing.
const T = '2026-06-17T19:00:00Z';
const VIEWER_FIXTURES = [
  { type: 'message', role: 'user', timestamp: T, content: [{ type: 'text', text: 'Find every TODO in `apps/web/src`.' }] },
  {
    type: 'message', role: 'assistant', timestamp: T, model: 'claude-opus-4-7-20260101',
    usage: { inputTokens: 12483, outputTokens: 312 },
    content: [
      { type: 'reasoning', text: 'ripgrep for TODO, group by file.' },
      { type: 'text', text: '**Plan:** search with `rg`, then group:\n\n| File | Line |\n| --- | --- |\n| `app/active/page.tsx` | 42 |' },
      { type: 'tool-call', toolCallId: 'tc_1', toolName: 'Bash', input: { command: "rg -n 'TODO' apps/web/src" } },
    ],
  },
  { type: 'message', role: 'tool', timestamp: T, content: [{ type: 'tool-result', toolCallId: 'tc_1', toolName: 'Bash', output: 'rg: apps/web/src: No such file or directory', isError: true }] },
  { type: 'message', role: 'system', timestamp: T, subtype: 'turn_duration', durationMs: 4820, content: [] },
];

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-base font-bold text-[var(--color-accent)] uppercase tracking-wide">{title}</h3>
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">{children}</div>
    </section>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-base text-[var(--color-muted)]">{children}</p>;
}

export default function StyleguidePage() {
  const [lightMode, setLightMode] = useState(false);
  const [showThinking, setShowThinking] = useState(true);
  const [showTools, setShowTools] = useState(true);
  const [timeRange, setTimeRange] = useTimeRange('styleguide_range', '7d');
  const { data: settings } = useSWR('/api/settings', fetcher, { revalidateOnFocus: false, dedupingInterval: 60000 });

  function toggleTheme() {
    const next = !lightMode;
    setLightMode(next);
    document.documentElement.classList.toggle('light', next);
    document.documentElement.classList.toggle('dark', !next);
  }

  const input = 'px-2 py-1.5 text-base bg-[var(--color-background)] border border-[var(--color-border)] rounded text-[var(--color-foreground)]';

  return (
    <div className="space-y-8">
      <PageContext
        pageType="styleguide"
        summary="Component reference and design system for unfirehose."
        metrics={{ sections: 12 }}
      />

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">
          Styleguide <span className="text-[var(--color-muted)] font-normal">— values, rules and rationale in <code>{DOCS}</code></span>
        </h2>
        <button
          onClick={toggleTheme}
          className="px-3 py-1.5 text-sm font-bold rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] transition-colors cursor-pointer"
        >
          {lightMode ? 'Light Mode' : 'Dark Mode'}
        </button>
      </div>

      <Section title="Theme">
        {/* The real picker, not a copy — a reference forked from what it documents is worse than none. */}
        <HexColorPicker value={settings?.theme_accent_color ?? '#d40000'} settingKey="theme_accent_color" />
      </Section>

      <Section title="Colors">
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
          {TOKENS.map((t) => (
            <div key={t} className="space-y-1">
              <div className="h-10 rounded border border-[var(--color-border)]" style={{ background: `var(--color-${t})` }} />
              <code className="text-xs text-[var(--color-muted)] break-all">--color-{t}</code>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-11 rounded overflow-hidden">
          {RED_STEPS.map((s) => (
            <div key={s} className="text-center">
              <div className="h-8" style={{ background: `var(--color-red-${s})` }} />
              <div className="text-xs text-[var(--color-muted)]">{s}</div>
            </div>
          ))}
        </div>
        <Note>Brand red (<code>--color-accent</code>) is not error red (<code>--color-error</code>); keep red to accents.</Note>
      </Section>

      <Section title="Typography & Shape">
        <div className="space-y-1">
          <div className="text-2xl font-bold">text-2xl — page heading</div>
          <div className="text-xl font-bold">text-xl — section heading</div>
          <div className="text-lg font-bold">text-lg — sub-heading</div>
          <div className="text-base">text-base — body; text-sm and text-xs also resolve to 16px</div>
          <div className="text-base text-[var(--color-muted)]">muted caption</div>
        </div>
        <div className="grid grid-cols-3 gap-4">
          {[['rounded', 'shadow-none'], ['rounded-lg', 'shadow-lg'], ['rounded-xl', 'shadow-2xl']].map(([r, s]) => (
            <div key={r} className={`h-16 grid place-items-center bg-[var(--color-background)] border border-[var(--color-border)] text-sm ${r} ${s}`}>
              {r} · {s}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Navigation">
        {/* From nav-items.ts — the same source of truth as the sidebar and /sitemap. */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {groupNavItems(false).map((group) => (
            <div key={group.section}>
              <div className="text-xs uppercase tracking-widest text-[var(--color-muted)] opacity-60 mb-2">{group.section}</div>
              {group.links.map((l, i) => (
                <div key={l.href} className="flex items-center gap-2 text-base text-[var(--color-muted)]">
                  <span className={`font-bold w-4 text-center ${i === 0 ? 'text-[var(--color-accent)]' : 'text-[var(--color-border)]'}`}>{l.icon}</span>
                  <span className={i === 0 ? 'text-[var(--color-foreground)]' : ''}>{l.label}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Layout — Grid Only">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 items-center">
          {[['Short', 75], ['Much longer label here', 40]].map(([label, pct]) => (
            <div key={label} className="contents">
              <span className="text-base text-[var(--color-muted)] whitespace-nowrap">{label}</span>
              <div className="h-4 bg-[var(--color-background)] rounded overflow-hidden">
                <div className="h-full bg-[var(--color-accent)] rounded" style={{ width: `${pct}%` }} />
              </div>
            </div>
          ))}
        </div>
        <Note><code>grid-cols-[auto_1fr]</code>: labels size to content and never truncate; the bar takes the rest.</Note>
      </Section>

      <Section title="StatCard">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <StatCard label="Total Sessions" value="412" sub="+12 today" />
          <StatCard label="Cost / hour" value="$3.20" tone="accent" />
          <StatCard label="Rate Alert" value="$8.50/hr" sub="exceeds $5" tone="warn" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Cache" value="9.4B" color="#4ade80" compact />
          <StatCard label="CPU" value="Ryzen 7 5800X" sub="16 cores" compact />
        </div>
      </Section>

      <Section title="EmptyState">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <EmptyState
            what="Sessions will appear here."
            action="Run a harness session in any git repo:"
            command="cd ~/your/repo && claude"
            link={{ href: '/schema', label: 'Other harnesses: adapter docs' }}
          />
          <EmptyState kind="quiet" what="No sessions in range." range="7d" onWiden={() => {}} />
        </div>
        <EmptyState compact kind="quiet" what="No tool calls in range." action="Tool calls appear when a session runs tools." />
        <Note>
          Every empty panel says what will appear, the action that makes it appear, and where to go.
          <code>first-run</code> is no data ever; <code>quiet</code> is data elsewhere, none in range, and offers a wider one.
          <code>compact</code> drops the frame for a chart slot inside a panel.
        </Note>
      </Section>

      <Section title="Gauge, KV, MiniStat">
        <div className="grid grid-cols-[3rem_1fr] items-center gap-3">
          {[12, 72, 91].map((pct) => (
            <div key={pct} className="contents">
              <span className="text-xs font-mono text-[var(--color-muted)]">{pct}%</span>
              <GaugeTrack pct={pct} />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <GaugeRow label="mem" value="24.1 / 31.3 GB" pct={77} />
            <GaugeBlock label="CPU" pct={42} value="42%" sub="8 cores, load 3.4" />
            <div className="flex gap-4"><GaugePill label="1m" value={1.2} max={16} /><GaugePill label="15m" value={11.8} max={16} /></div>
          </div>
          <GaugeCard label="Disk" pct={88} value="1.6 / 1.8 TB" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-base">
          <div><KV label="Kernel" value="6.8.0-generic" /><KV label="Uplink" value={null} /></div>
          <div><KV label="Ports" value="8080, 9090" hideEmpty align /><KV label="Command" value={null} hideEmpty align /></div>
        </div>
        <div className="flex gap-4"><MiniStat label="nodes" value={5} /><MiniStat label="watts" value="387W" accent /></div>
      </Section>

      <Section title="Charts">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <UPlotCategoryChart data={BAR_DATA} labelKey="name" series={[{ key: 'value', label: 'messages', color: '#d40000' }]} height={160} />
          <UPlotCategoryChart kind="lines" data={LINE_DATA} labelKey="date" series={[{ key: 'tokens', label: 'tokens', color: '#d40000', fill: '#d4000030' }]} height={160} />
          <Donut data={DONUT_DATA} format={(v) => `${v}%`} height={160} />
        </div>
      </Section>

      <Section title="Controls">
        <div className="flex flex-wrap gap-3 items-center">
          <button className="px-3 py-1.5 text-base bg-[var(--color-accent)] text-[var(--color-background)] rounded font-bold hover:opacity-90 transition-opacity">Primary</button>
          <button className="px-3 py-1.5 text-base bg-[var(--color-surface-hover)] text-[var(--color-foreground)] rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] transition-colors">Secondary</button>
          <button className="px-3 py-1.5 text-base text-[var(--color-error)] rounded border border-[var(--color-error)] hover:bg-[var(--color-error)] hover:text-[var(--color-foreground)] transition-colors">Danger</button>
          <button className="px-3 py-1.5 text-base text-[var(--color-muted)] cursor-not-allowed opacity-50" disabled>Disabled</button>
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <input type="text" placeholder="Text input" className={`${input} w-40`} />
          <select className={input} defaultValue="opus"><option value="opus">Opus</option><option value="sonnet">Sonnet</option></select>
          <TimeRangeSelect value={timeRange} onChange={setTimeRange} />
          <label className="flex items-center gap-1.5 text-base text-[var(--color-muted)]">
            <input type="checkbox" defaultChecked className="accent-[var(--color-accent)]" /> Checkbox
          </label>
        </div>
        <Note>
          Show actions at reduced opacity rather than hiding them behind hover; never use <code>window.confirm()</code> or{' '}
          <code>alert()</code> — arm on first click, act on the second.
        </Note>
      </Section>

      <Section title="Session Viewer">
        <div className="flex items-center gap-4 text-base text-[var(--color-muted)]">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={showThinking} onChange={(e) => setShowThinking(e.target.checked)} className="accent-[var(--color-thinking)]" />
            Thinking
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={showTools} onChange={(e) => setShowTools(e.target.checked)} className="accent-[var(--color-tool)]" />
            Tools
          </label>
        </div>
        <div className="space-y-2 border border-[var(--color-border)] rounded bg-[var(--color-background)] p-3">
          {VIEWER_FIXTURES.map((entry, i) => (
            <MessageBlock key={i} entry={entry} showThinking={showThinking} showTools={showTools} />
          ))}
        </div>
      </Section>

      <Section title="Pills, Kanban & Motion">
        {/* Live page: one pill per project; colored = active, muted = hot but idle. Never wraps. */}
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {[['permacomputer', '#10b981', 12], ['unfirehose', '#a78bfa', 3], ['uncloseai-com', 'var(--color-muted)', 47]].map(([name, color, n]) => (
            <span key={name} className="text-base px-2 py-0.5 rounded-full border shrink-0 whitespace-nowrap" style={{ borderColor: color as string, color: color as string }}>
              {name} <span className="opacity-50">×{n}</span>
            </span>
          ))}
        </div>
        {/* TodoBoard cards: resting, running, and a drop zone. */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="rounded-xl border border-[var(--color-border)] p-3.5 shadow-md cursor-grab" style={{ background: 'color-mix(in srgb, var(--color-accent) 6%, var(--color-surface))' }}>
            <p className="text-sm font-medium mb-2">Add unit tests for auth module</p>
            <span className="px-1.5 py-0.5 rounded bg-[var(--color-accent)]/10 text-[var(--color-accent)] text-xs">claude</span>
          </div>
          <div className="rounded-xl border border-[var(--color-accent)]/50 p-3.5 shadow-lg shadow-[0_0_12px_var(--color-accent)] card-landed" style={{ background: 'color-mix(in srgb, var(--color-accent) 10%, var(--color-surface))' }}>
            <div className="flex items-center gap-1.5 mb-2">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] animate-pulse" />
              <span className="text-xs font-bold text-[var(--color-accent)]">RUNNING</span>
            </div>
            <p className="text-sm font-medium">card-landed plays on load</p>
          </div>
          <div className="column-drop-pulse border-2 border-dashed border-[var(--color-accent)] rounded-lg p-3 bg-[var(--color-accent)]/10 grid place-items-center">
            <span className="text-sm font-bold text-[var(--color-accent)]">Drop to power up agent</span>
          </div>
        </div>
      </Section>
    </div>
  );
}
