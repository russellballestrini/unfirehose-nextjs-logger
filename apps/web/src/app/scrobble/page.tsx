'use client';

import { fetcher } from '@unturf/unfirehose-ui/fetcher';

import Link from 'next/link';

import { Fragment, useState } from 'react';
import useSWR from 'swr';
import { formatTokens, formatCost } from '@unturf/unfirehose/format';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import { StatCard } from '@unturf/unfirehose-ui/StatCard';
import { StatStrip, Stat, StatDivider, costSub } from '@unturf/unfirehose-ui/StatStrip';
import { TimeRangeSelect, useTimeRange, getTimeRangeFrom } from '@unturf/unfirehose-ui/TimeRangeSelect';
import { sliceScrobble } from '@unturf/unfirehose/scrobble-range';
import { UPlotCategoryChart } from '@/components/UPlotCategoryChart';

/* eslint-disable @typescript-eslint/no-explicit-any */

const VISIBILITY_OPTIONS = ['public', 'unlisted', 'private'] as const;
const VISIBILITY_COLORS: Record<string, string> = {
  public: '#10b981',
  unlisted: '#fbbf24',
  private: 'var(--color-muted)',
};

const TIER_COLORS: Record<string, string> = {
  bronze: '#cd7f32',
  silver: '#c0c0c0',
  gold: '#ffd700',
  diamond: '#b9f2ff',
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The ranges that make sense for daily series. */
const SCROBBLE_RANGES = ['7d', '14d', '28d', '90d', '180d', '365d', 'all'] as const;

export default function ScrobblePage() {
  const { data: payload, isLoading } = useSWR('/api/scrobble/payload', fetcher);
  const { data: preview } = useSWR('/api/scrobble/preview', fetcher);
  const { data: settings } = useSWR('/api/settings', fetcher);
  // Every hook above the early returns below. This one sat after them for a
  // few minutes and React said so on the first navigation: a hook that only
  // runs once data has loaded changes the hook order between renders.
  const [range, setRange] = useTimeRange('scrobble_range', 'all');
  const [tab, setTab] = useState<'overview' | 'projects' | 'badges'>('overview');
  const [saving, setSaving] = useState<string | null>(null);

  const scrobbleEnabled = settings?.unfirehose_scrobble === 'true';

  async function toggleScrobble() {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set', key: 'unfirehose_scrobble', value: String(!scrobbleEnabled) }),
    });
  }

  async function setVisibility(projectName: string, visibility: string) {
    setSaving(projectName);
    try {
      await fetch(`/api/projects/${encodeURIComponent(projectName)}/visibility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility }),
      });
    } catch { /* silent */ }
    setSaving(null);
  }

  if (isLoading) return <p className="text-[var(--color-muted)]">Loading scrobble data...</p>;
  if (!payload || payload.error) return <p className="text-red-400">Failed to load scrobble data{payload?.error ? `: ${payload.error}` : ''}</p>;

  // Defensive: API contract guarantees these shapes but a partial / cached / older
  // response shouldn't deref-crash.
  // The payload carries every day there is, at day grain; the range folds
  // it here — every stat, the heatmap, the hour bars, the model and tool
  // lists, not only the two daily series. Lifetime by default — this is a
  // profile — and the day ranges the rest of the app uses. Hour ranges are
  // not offered: the grain is daily, and a one-hour window of it is empty.
  const from = getTimeRangeFrom(range);
  const view = sliceScrobble(payload, from?.slice(0, 10));
  const lt = view.lifetime;
  // Price per token type when the payload carries one. An older payload has
  // no split — those cards keep their plain-language sub and no price, which
  // is honest; a missing price must never render as $0.
  const cs = lt.costSplit;
  const priced = (usd: number | undefined, tail: string) =>
    usd == null ? tail : `${formatCost(usd)} · ${tail}`;
  const { streaks, activity, timeSeries } = view;
  const rangeLabel = range === 'all' ? 'lifetime' : `last ${range.replace('d', ' days')}`;
  // An older payload has no grain: the figures are lifetime whatever the
  // selector says, and the page should say so rather than mislabel them.
  const figuresLabel = view.sliced ? rangeLabel : 'lifetime';
  const projects = payload.projects ?? [];
  const badges = payload.badges ?? [];
  const earnedBadges = badges.filter((b: any) => b.earned);
  const nextBadges = badges.filter((b: any) => !b.earned && b.progress > 0.3).slice(0, 4);

  // First-time empty state — show what scrobble IS rather than zero stat cards.
  // Lifetime, not the range: a quiet week is not a first run.
  if ((payload.lifetime?.totalSessions ?? 0) === 0) {
    return (
      <div className="space-y-6">
        <PageContext
          pageType="scrobble"
          summary="Scrobble. First-run state — no sessions to scrobble yet."
          metrics={{ sessions: 0, first_run: 'yes' }}
        />
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold">Scrobble</h2>
            <p className="text-base text-[var(--color-muted)]">
              Public usage profile — sessions, streaks, tokens, badges. No prompts, responses, or training data — ever.
            </p>
          </div>
          <button
            onClick={toggleScrobble}
            className={`px-4 py-2 text-base font-bold rounded border transition-colors cursor-pointer ${
              scrobbleEnabled
                ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-accent)]'
            }`}
          >
            {scrobbleEnabled ? '♪ Scrobbling' : '♪ Enable Scrobble'}
          </button>
        </div>
        <div className="border border-[var(--color-border)] rounded-xl p-8 bg-[var(--color-surface)] space-y-3 max-w-3xl">
          <h3 className="text-xl font-bold">Nothing to scrobble yet</h3>
          <p className="text-base text-[var(--color-muted)]">
            Scrobble is a public usage profile — counts, streaks, hours-of-day, tier badges — generated from your local
            sessions. Toggle it on if you want others to see when you code. Run a harness session to populate the stats,
            then this page will show your overview, projects, and badges.
          </p>
          <p className="text-base text-[var(--color-muted)]">
            See <Link href="/projects" className="text-[var(--color-accent)] hover:underline">Projects</Link> for setup steps.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageContext
        pageType="scrobble"
        summary={`Scrobble. ${lt.totalSessions} sessions, ${lt.activeDays} active days, ${streaks.current}d streak.`}
        metrics={{ sessions: lt.totalSessions, active_days: lt.activeDays, streak: streaks.current, cost: lt.totalCostUSD }}
      />

      {/* Header + toggle */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">Scrobble</h2>
          <p className="text-base text-[var(--color-muted)]">
            Usage metrics for your public profile. No prompts, responses, or training data — ever.
          </p>
        </div>
        <button
          onClick={toggleScrobble}
          className={`px-4 py-2 text-base font-bold rounded border transition-colors cursor-pointer ${
            scrobbleEnabled
              ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
              : 'border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-accent)]'
          }`}
        >
          {scrobbleEnabled ? '♪ Scrobbling' : '♪ Enable Scrobble'}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1">
        {(['overview', 'projects', 'badges'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-base font-bold rounded-t border transition-colors cursor-pointer capitalize ${
              tab === t
                ? 'border-[var(--color-border)] border-b-transparent bg-[var(--color-surface)] text-[var(--color-foreground)]'
                : 'border-transparent text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="space-y-6">
          {/* One strip: what happened, then what it cost. It was ten cards over two
              grids, each number in its own box with nothing beside it. */}
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-[var(--color-muted)]">
              Figures below are {figuresLabel}{!view.sliced && range !== 'all' ? ' — this payload predates the day grain; the worker\'s next build will carry it' : ''}
            </span>
            <TimeRangeSelect value={range} onChange={setRange} options={SCROBBLE_RANGES} />
          </div>
          <StatStrip>
            <Stat label="Sessions" value={lt.totalSessions.toLocaleString()} />
            <Stat label="Messages" value={lt.totalMessages.toLocaleString()} />
            <Stat label="Active days" value={lt.activeDays.toLocaleString()} />
            <Stat label="Streak" value={`${streaks.current}d`} sub={`longest ${streaks.longest}d`} color={streaks.current >= 3 ? 'var(--color-accent)' : undefined} />
            <Stat label="Total cost" value={`$${lt.totalCostUSD.toLocaleString()}`} />
            <StatDivider />
            {/* Cost under each; what the tokens are is the tooltip. With the
                description inline, nine stats would not fit one row on a
                desktop, and the ninth wrapped alone underneath. */}
            <Stat label="Input" value={formatTokens(lt.totalInputTokens)} sub={costSub(cs?.input)} title="Prompt tokens the model read for the first time" />
            <Stat label="Output" value={formatTokens(lt.totalOutputTokens)} sub={costSub(cs?.output)} title="Tokens the model generated" />
            <Stat label="Cache read" value={formatTokens(lt.totalCacheRead)} sub={costSub(cs?.cacheRead)} title="Prompt replayed from cache" />
            <Stat label="Cache write" value={formatTokens(lt.totalCacheWrite)} sub={costSub(cs?.cacheWrite)} title="Prompt written into cache" />
          </StatStrip>

          {/* Activity heatmap — sleep schedule proxy */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
            <h3 className="text-base font-bold text-[var(--color-muted)]">Activity Heatmap — {figuresLabel}</h3>
            <p className="text-base text-[var(--color-muted)]">When you code. Rows = days, columns = hours. Intensity = message volume.</p>
            <HeatmapGrid data={activity.heatmap} />
          </div>

          {/* Hour of day chart */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
            <h3 className="text-base font-bold text-[var(--color-muted)]">Hour of Day — {figuresLabel}</h3>
            <BarChart data={activity.hourOfDay.map((h: any) => ({ label: `${h.hour}`, value: h.count }))} />
          </div>

          {/* Daily cost chart */}
          {timeSeries.dailyCost.length > 0 && (
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
              <h3 className="text-base font-bold text-[var(--color-muted)]">Daily cost — {rangeLabel}</h3>
              <BarChart data={timeSeries.dailyCost.map((d: any) => ({ label: d.date.slice(5), value: d.costUSD }))} />
            </div>
          )}

          {/* Weekly velocity. Messages are counted in the week they happened and
              a session in every week it was active; the week we are in is
              marked, because its numbers are still growing. */}
          {timeSeries.weeklyVelocity.length > 0 && (
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-2">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-base font-bold text-[var(--color-muted)]">Weekly velocity — {rangeLabel}</h3>
                {timeSeries.weeklyVelocity.some((w: any) => w.partial) && (
                  <span className="text-xs text-[var(--color-muted)]">current week is partial</span>
                )}
              </div>
              <UPlotCategoryChart
                data={timeSeries.weeklyVelocity as Array<Record<string, unknown>>}
                labelKey="week"
                legend
                series={[
                  { key: 'sessions', label: 'sessions', color: '#a78bfa' },
                  { key: 'messages', label: 'messages', color: '#10b981', kind: 'lines', axis: 'right' },
                ]}
                height={200}
                format={(v) => v.toLocaleString()}
                formatRight={(v) => formatTokens(v)}
                tick={(w) => w.replace(/^\d{4}-/, '')}
                hover={(row) => (row.partial ? 'in progress' : '')}
              />
            </div>
          )}

          {/* Model + Harness + Tool breakdowns */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-2">
              <h3 className="text-base font-bold text-[var(--color-muted)]">Models</h3>
              {view.models.map((m: any) => (
                <div key={m.model} className="flex justify-between text-base">
                  <span className="font-mono truncate">{m.model.replace('claude-', '').replace(/-20\d{6}$/, '')}</span>
                  <span className="text-[var(--color-muted)] shrink-0 ml-2">{m.messages}</span>
                </div>
              ))}
            </div>
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-2">
              <h3 className="text-base font-bold text-[var(--color-muted)]">Harnesses</h3>
              {view.harnesses.map((h: any, i: number) => (
                <div key={`${h.harness}-${i}`} className="flex justify-between text-base">
                  <span className="font-mono">{h.harness}</span>
                  <span className="text-[var(--color-muted)]">{h.sessions} sessions</span>
                </div>
              ))}
            </div>
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-2">
              <h3 className="text-base font-bold text-[var(--color-muted)]">Top Tools</h3>
              {view.tools.slice(0, 10).map((t: any) => (
                <div key={t.name} className="flex justify-between text-base">
                  <span className="font-mono truncate">{t.name}</span>
                  <span className="text-[var(--color-muted)] shrink-0 ml-2">{t.count}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Next badges to earn */}
          {nextBadges.length > 0 && (
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
              <h3 className="text-base font-bold text-[var(--color-muted)]">Next Badges</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {nextBadges.map((b: any) => (
                  <BadgeCard key={b.id} badge={b} />
                ))}
              </div>
            </div>
          )}

          {/* What's shared / not shared */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-2">
              <h3 className="text-base font-bold text-green-400">Scrobbled</h3>
              <ul className="space-y-1 text-base text-[var(--color-muted)]">
                {[
                  'Session/message/token counts',
                  'Model + harness + tool names & counts',
                  'Daily/weekly activity patterns',
                  'Hour-of-day heatmap',
                  'Cost totals (not per-prompt)',
                  'Streaks and badges',
                  'Public project names',
                ].map((item, i) => (
                  <li key={i}><span className="text-green-400 mr-2">+</span>{item}</li>
                ))}
              </ul>
            </div>
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-2">
              <h3 className="text-base font-bold text-red-400">Never Shared</h3>
              <ul className="space-y-1 text-base text-[var(--color-muted)]">
                {[
                  'User prompts and inputs',
                  'System messages',
                  'Assistant responses',
                  'Thinking / reasoning traces',
                  'Tool call arguments or results',
                  'File contents, paths, git diffs',
                  'CLAUDE.md or config contents',
                  'Any PII (sanitized at ingest)',
                ].map((item, i) => (
                  <li key={i}><span className="text-red-400 mr-2">-</span>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {tab === 'projects' && preview && (
        <div className="space-y-4">
          <div className="flex gap-4 text-base">
            <span style={{ color: VISIBILITY_COLORS.public }}>
              {preview.projects?.filter((p: any) => p.visibility === 'public').length ?? 0} public
            </span>
            <span style={{ color: VISIBILITY_COLORS.unlisted }}>
              {preview.projects?.filter((p: any) => p.visibility === 'unlisted').length ?? 0} unlisted
            </span>
            <span style={{ color: VISIBILITY_COLORS.private }}>
              {preview.projects?.filter((p: any) => p.visibility === 'private').length ?? 0} private
            </span>
          </div>

          <div className="space-y-2">
            {(preview.projects ?? []).map((p: any) => (
              <div
                key={p.name}
                className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] px-4 py-3 flex items-center gap-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-bold truncate">{p.displayName}</span>
                    <span
                      className="text-xs px-1.5 py-0.5 rounded"
                      style={{
                        color: VISIBILITY_COLORS[p.visibility],
                        backgroundColor: `${VISIBILITY_COLORS[p.visibility]}22`,
                      }}
                    >
                      {p.visibility}
                    </span>
                    {p.autoDetected?.startsWith('public_repo:') && (
                      <a
                        href={p.autoDetected.replace('public_repo:', '')}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs px-1.5 py-0.5 rounded hover:opacity-80"
                        style={{ color: '#10b981', backgroundColor: '#10b98122' }}
                      >
                        public repo
                      </a>
                    )}
                  </div>
                  <div className="text-base text-[var(--color-muted)] mt-0.5">
                    {p.sessionCount} sessions / {p.messageCount.toLocaleString()} msgs / {formatTokens(p.totalInput + p.totalOutput)}
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  {VISIBILITY_OPTIONS.map(opt => (
                    <button
                      key={opt}
                      onClick={() => setVisibility(p.name, opt)}
                      disabled={saving === p.name}
                      className={`px-2 py-1 text-base rounded border transition-colors cursor-pointer ${
                        p.visibility === opt
                          ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                          : 'border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-accent)]'
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'badges' && (
        <div className="space-y-6">
          <div className="text-base text-[var(--color-muted)]">
            {earnedBadges.length} of {badges.length} badges earned
          </div>

          {/* Earned badges */}
          <div className="space-y-3">
            <h3 className="text-base font-bold text-[var(--color-muted)]">Earned</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {earnedBadges.map((b: any) => (
                <BadgeCard key={b.id} badge={b} />
              ))}
            </div>
          </div>

          {/* Locked badges */}
          <div className="space-y-3">
            <h3 className="text-base font-bold text-[var(--color-muted)]">Locked</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {badges.filter((b: any) => !b.earned).map((b: any) => (
                <BadgeCard key={b.id} badge={b} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BadgeCard({ badge }: { badge: any }) {
  const color = badge.earned ? (TIER_COLORS[badge.tier] ?? 'var(--color-accent)') : 'var(--color-muted)';
  return (
    <div className={`rounded border p-3 text-center transition-colors ${
      badge.earned
        ? 'border-[var(--color-border)] bg-[var(--color-surface)]'
        : 'border-[var(--color-border)] bg-[var(--color-background)] opacity-50'
    }`}>
      <div className="text-lg" style={{ color }}>{badge.earned ? '◆' : '◇'}</div>
      <div className="text-base font-bold mt-1" style={{ color: badge.earned ? color : undefined }}>
        {badge.name}
      </div>
      <div className="text-xs text-[var(--color-muted)]">{badge.description}</div>
      {badge.progress !== undefined && badge.progress < 1 && (
        <div className="mt-2 h-1 bg-[var(--color-border)] rounded-full overflow-hidden">
          <div
            className="h-full rounded-full"
            style={{ width: `${badge.progress * 100}%`, backgroundColor: color }}
          />
        </div>
      )}
      {badge.tier && badge.earned && (
        <div className="text-xs uppercase mt-1" style={{ color }}>{badge.tier}</div>
      )}
    </div>
  );
}

function HeatmapGrid({ data }: { data: { dow: number; hour: number; count: number }[] }) {
  const maxCount = Math.max(1, ...data.map(d => d.count));
  const grid: Record<string, number> = {};
  for (const d of data) {
    grid[`${d.dow}-${d.hour}`] = d.count;
  }

  return (
    <div className="overflow-x-auto">
      <div className="inline-grid gap-0.5" style={{ gridTemplateColumns: `auto repeat(24, 1fr)` }}>
        {/* Header row */}
        <div />
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className="text-xs text-[var(--color-muted)] text-center w-5">
            {h % 3 === 0 ? h : ''}
          </div>
        ))}
        {/* Data rows */}
        {[0, 1, 2, 3, 4, 5, 6].map(dow => (
          <Fragment key={`row-${dow}`}>
            <div className="text-xs text-[var(--color-muted)] pr-1 leading-5">
              {DAY_NAMES[dow]}
            </div>
            {Array.from({ length: 24 }, (_, h) => {
              const count = grid[`${dow}-${h}`] ?? 0;
              const intensity = count / maxCount;
              return (
                <div
                  key={`${dow}-${h}`}
                  className="w-5 h-5 rounded-sm"
                  style={{
                    backgroundColor: intensity > 0
                      ? `color-mix(in srgb, var(--color-accent) ${Math.round(intensity * 100)}%, var(--color-surface))`
                      : 'var(--color-surface)',
                  }}
                  title={`${DAY_NAMES[dow]} ${h}:00 — ${count} messages`}
                />
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function BarChart({ data }: { data: { label: string; value: number }[] }) {
  const maxVal = Math.max(1, ...data.map(d => d.value));
  return (
    <div className="flex items-end gap-px h-24">
      {data.map((d, i) => (
        <div key={i} className="flex-1 flex flex-col items-center justify-end h-full group relative">
          <div
            className="w-full rounded-t-sm min-h-px"
            style={{
              height: `${(d.value / maxVal) * 100}%`,
              backgroundColor: 'var(--color-accent)',
              opacity: 0.6 + (d.value / maxVal) * 0.4,
            }}
          />
          {data.length <= 30 && (
            <div className="text-[8px] text-[var(--color-muted)] mt-0.5 truncate w-full text-center">
              {d.label}
            </div>
          )}
          <div className="absolute -top-6 left-1/2 -translate-x-1/2 hidden group-hover:block bg-[var(--color-background)] border border-[var(--color-border)] rounded px-1.5 py-0.5 text-xs whitespace-nowrap z-10">
            {d.label}: {typeof d.value === 'number' && d.value % 1 !== 0 ? `$${d.value}` : d.value}
          </div>
        </div>
      ))}
    </div>
  );
}
