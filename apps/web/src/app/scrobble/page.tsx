'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { formatTokens } from '@unturf/unfirehose/format';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then(r => r.json());

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

export default function ScrobblePage() {
  const { data: payload, isLoading } = useSWR('/api/scrobble/payload', fetcher);
  const { data: preview } = useSWR('/api/scrobble/preview', fetcher);
  const { data: settings } = useSWR('/api/settings', fetcher);
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
  if (!payload || payload.error) return <p className="text-red-400">Failed to load scrobble data</p>;

  const lt = payload.lifetime;
  const streaks = payload.streaks;
  const badges = payload.badges ?? [];
  const earnedBadges = badges.filter((b: any) => b.earned);
  const nextBadges = badges.filter((b: any) => !b.earned && b.progress > 0.3).slice(0, 4);

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
          {/* Hero stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <StatCard label="Sessions" value={lt.totalSessions.toLocaleString()} />
            <StatCard label="Messages" value={lt.totalMessages.toLocaleString()} />
            <StatCard label="Active Days" value={lt.activeDays.toLocaleString()} />
            <StatCard label="Current Streak" value={`${streaks.current}d`} accent={streaks.current >= 3} />
            <StatCard label="Longest Streak" value={`${streaks.longest}d`} />
            <StatCard label="Total Cost" value={`$${lt.totalCostUSD.toLocaleString()}`} />
          </div>

          {/* Token breakdown */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Input Tokens" value={formatTokens(lt.totalInputTokens)} sub="prompts → model" />
            <StatCard label="Output Tokens" value={formatTokens(lt.totalOutputTokens)} sub="model → you" />
            <StatCard label="Cache Read" value={formatTokens(lt.totalCacheRead)} sub="saved compute" />
            <StatCard label="Cache Write" value={formatTokens(lt.totalCacheWrite)} sub="new cache" />
          </div>

          {/* Activity heatmap — sleep schedule proxy */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
            <h3 className="text-base font-bold text-[var(--color-muted)]">Activity Heatmap</h3>
            <p className="text-base text-[var(--color-muted)]">When you code. Rows = days, columns = hours. Intensity = message volume.</p>
            <HeatmapGrid data={payload.activity.heatmap} />
          </div>

          {/* Hour of day chart */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
            <h3 className="text-base font-bold text-[var(--color-muted)]">Hour of Day</h3>
            <BarChart data={payload.activity.hourOfDay.map((h: any) => ({ label: `${h.hour}`, value: h.count }))} />
          </div>

          {/* Daily cost chart */}
          {payload.timeSeries.dailyCost.length > 0 && (
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
              <h3 className="text-base font-bold text-[var(--color-muted)]">Daily Cost (90d)</h3>
              <BarChart data={payload.timeSeries.dailyCost.map((d: any) => ({ label: d.date.slice(5), value: d.costUSD }))} />
            </div>
          )}

          {/* Weekly velocity */}
          {payload.timeSeries.weeklyVelocity.length > 0 && (
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
              <h3 className="text-base font-bold text-[var(--color-muted)]">Weekly Velocity (12w)</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
                {payload.timeSeries.weeklyVelocity.map((w: any) => (
                  <div key={w.week} className="text-center">
                    <div className="text-base font-mono text-[var(--color-muted)]">{w.week}</div>
                    <div className="text-base font-bold">{w.sessions} sessions</div>
                    <div className="text-base text-[var(--color-muted)]">{w.messages} msgs</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Model + Harness + Tool breakdowns */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-2">
              <h3 className="text-base font-bold text-[var(--color-muted)]">Models</h3>
              {payload.models.map((m: any) => (
                <div key={m.model} className="flex justify-between text-base">
                  <span className="font-mono truncate">{m.model.replace('claude-', '').replace(/-20\d{6}$/, '')}</span>
                  <span className="text-[var(--color-muted)] shrink-0 ml-2">{m.messages}</span>
                </div>
              ))}
            </div>
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-2">
              <h3 className="text-base font-bold text-[var(--color-muted)]">Harnesses</h3>
              {payload.harnesses.map((h: any) => (
                <div key={h.harness} className="flex justify-between text-base">
                  <span className="font-mono">{h.harness}</span>
                  <span className="text-[var(--color-muted)]">{h.sessions} sessions</span>
                </div>
              ))}
            </div>
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-2">
              <h3 className="text-base font-bold text-[var(--color-muted)]">Top Tools</h3>
              {payload.tools.slice(0, 10).map((t: any) => (
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

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-3">
      <div className="text-base text-[var(--color-muted)]">{label}</div>
      <div className={`text-base font-bold ${accent ? 'text-[var(--color-accent)]' : ''}`}>{value}</div>
      {sub && <div className="text-xs text-[var(--color-muted)]">{sub}</div>}
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
          <>
            <div key={`label-${dow}`} className="text-xs text-[var(--color-muted)] pr-1 leading-5">
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
          </>
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
