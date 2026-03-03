'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import useSWR from 'swr';
import Link from 'next/link';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts';
import type { ProjectMetadata } from '@/lib/types';
import { PageContext } from '@/components/PageContext';
import { formatTokens, formatCost, formatRelativeTime, formatTimestamp } from '@/lib/format';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const PIE_COLORS = ['#10b981', '#60a5fa', '#a78bfa', '#fbbf24', '#f87171', '#34d399', '#fb923c', '#e879f9'];

// --- Spinner ---

function Spinner() {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4">
      <div className="relative w-12 h-12">
        <div className="absolute inset-0 border-2 border-[var(--color-border)] rounded-full" />
        <div className="absolute inset-0 border-2 border-transparent border-t-[var(--color-accent)] rounded-full animate-spin" />
        <div className="absolute inset-2 border-2 border-transparent border-t-[var(--color-thinking)] rounded-full animate-spin" style={{ animationDirection: 'reverse', animationDuration: '0.6s' }} />
        <div className="absolute inset-4 border-2 border-transparent border-t-[var(--color-user)] rounded-full animate-spin" style={{ animationDuration: '0.4s' }} />
      </div>
      <div className="text-sm text-[var(--color-muted)] animate-pulse">
        Assembling forensic report...
      </div>
    </div>
  );
}

// --- Progress Bar ---

function ProgressBar({ value, max, color }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="w-24 h-2.5 bg-[var(--color-surface-hover)] rounded overflow-hidden inline-block align-middle ml-2">
      <div
        className="h-full rounded transition-all"
        style={{ width: `${Math.min(pct, 100)}%`, background: color ?? 'var(--color-accent)' }}
      />
    </div>
  );
}

// --- Stat Card ---

function StatCard({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className={`bg-[var(--color-background)] rounded border p-3 ${warn ? 'border-[var(--color-error)]' : 'border-[var(--color-border)]'}`}>
      <div className="text-[10px] text-[var(--color-muted)] uppercase tracking-wide">{label}</div>
      <div className={`text-xl font-bold mt-0.5 ${warn ? 'text-[var(--color-error)]' : ''}`}>{value}</div>
      {sub && <div className="text-[10px] text-[var(--color-muted)] mt-0.5">{sub}</div>}
    </div>
  );
}

// --- Thinking Block ---

function ThinkingBlock({ block, forceExpand }: { block: any; forceExpand: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const isExpanded = forceExpand || expanded;
  const content = block.text_content ?? '';
  const preview = content.slice(0, 500);
  const needsTruncation = content.length > 500;

  return (
    <div className="border-l-3 border-[var(--color-thinking)] bg-[var(--color-surface)] rounded-r p-4 space-y-2">
      <div className="flex items-center flex-wrap gap-2 text-xs">
        <span className="text-[var(--color-muted)]">{formatTimestamp(block.timestamp)}</span>
        <span className="text-[var(--color-thinking)] font-bold">{block.display_name}</span>
        {block.model && (
          <span className="bg-[var(--color-surface-hover)] px-1.5 py-0.5 rounded text-[10px] text-[var(--color-foreground)]">
            {block.model}
          </span>
        )}
        <span className="bg-[var(--color-surface-hover)] px-1.5 py-0.5 rounded text-[10px] text-[var(--color-muted)]">
          {block.char_count.toLocaleString()} chars
        </span>
        {block.preceding_prompt && (
          <span className="text-[var(--color-user)] italic truncate max-w-md">
            &ldquo;{block.preceding_prompt}&rdquo;
          </span>
        )}
        {needsTruncation && !forceExpand && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[var(--color-accent)] hover:underline ml-auto"
          >
            {isExpanded ? 'collapse' : 'expand full'}
          </button>
        )}
      </div>
      <pre className="text-xs font-mono whitespace-pre-wrap text-[var(--color-foreground)] leading-relaxed max-h-[80vh] overflow-auto">
        {isExpanded ? content : preview}
        {!isExpanded && needsTruncation && (
          <span className="text-[var(--color-muted)]">
            {'\n\n'}--- {(content.length - 500).toLocaleString()} more characters ---
          </span>
        )}
      </pre>
    </div>
  );
}

// --- Repo Context ---

function RepoContext({ projectName }: { projectName: string }) {
  const { data: meta } = useSWR<ProjectMetadata>(
    `/api/projects/metadata?project=${encodeURIComponent(projectName)}`,
    fetcher
  );

  if (!meta) return <div className="text-xs text-[var(--color-muted)] animate-pulse">loading git data...</div>;
  if (!meta.branch && meta.remotes.length === 0 && meta.recentCommits.length === 0) {
    return <div className="text-xs text-[var(--color-muted)] italic">no git repository</div>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        {meta.branch && (
          <span className="inline-block text-xs bg-[var(--color-surface-hover)] text-[var(--color-accent)] px-2 py-0.5 rounded font-mono">
            {meta.branch}
          </span>
        )}
        {meta.remotes.filter((r) => r.type === 'fetch').map((r) => {
          const ghMatch = r.url.match(/github\.com[:/](.+?)(?:\.git)?$/);
          const glMatch = r.url.match(/gitlab\.com[:/](.+?)(?:\.git)?$/);
          const linkUrl = ghMatch
            ? `https://github.com/${ghMatch[1]}`
            : glMatch
              ? `https://gitlab.com/${glMatch[1]}`
              : null;
          return linkUrl ? (
            <a key={`${r.name}-${r.url}`} href={linkUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-[var(--color-accent)] hover:underline">
              {r.name}: {ghMatch?.[1] ?? glMatch?.[1]}
            </a>
          ) : (
            <span key={`${r.name}-${r.url}`} className="text-xs font-mono text-[var(--color-muted)]">{r.name}: {r.url}</span>
          );
        })}
      </div>
      {meta.recentCommits.length > 0 && (
        <div className="text-xs space-y-1 font-mono">
          {meta.recentCommits.slice(0, 8).map((c) => (
            <div key={c.hash} className="flex gap-2">
              <span className="text-[var(--color-accent)] shrink-0">{c.hash}</span>
              <span className="truncate flex-1">{c.subject}</span>
              <span className="text-[var(--color-muted)] shrink-0">
                {c.author}, {formatRelativeTime(c.date)}
              </span>
            </div>
          ))}
        </div>
      )}
      {meta.claudeMdExists && meta.claudeMd && (
        <details className="text-xs">
          <summary className="text-[var(--color-muted)] cursor-pointer hover:text-[var(--color-foreground)]">CLAUDE.md preview</summary>
          <pre className="mt-1 bg-[var(--color-background)] border border-[var(--color-border)] rounded p-2 whitespace-pre-wrap max-h-32 overflow-auto">
            {meta.claudeMd}
          </pre>
        </details>
      )}
    </div>
  );
}

// --- Main Page ---

export default function AlertDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [expandAll, setExpandAll] = useState(false);

  const { data, error } = useSWR(`/api/alerts/${id}`, fetcher);

  if (error) {
    return (
      <div className="text-[var(--color-error)] p-8">
        Failed to load alert: {String(error)}
      </div>
    );
  }
  if (!data) return <Spinner />;
  if (data.error) {
    return (
      <div className="text-[var(--color-error)] p-8">
        {data.error}: {data.detail ?? ''}
      </div>
    );
  }

  const {
    alert, window: win, projectBreakdown, modelBreakdown,
    activeSessions, thinkingBlocks, timeline, userPrompts, totals, stats,
  } = data;

  const ratio = stats ? (alert.actual_value / alert.threshold_value).toFixed(2) : '?';

  // Unique projects for repo context
  const uniqueProjects = [...new Set(activeSessions.map((s: any) => s.project_name))] as string[];

  // Pie data for project cost share
  const projectPie = projectBreakdown
    .filter((p: any) => p.cost_usd > 0)
    .map((p: any) => ({ name: p.display_name, value: p.cost_usd }));

  // Pie data for model cost share
  const modelPie = modelBreakdown
    .filter((m: any) => m.cost_usd > 0)
    .map((m: any) => ({ name: m.model ?? 'unknown', value: m.cost_usd }));

  const acknowledge = async () => {
    await fetch('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'acknowledge', id: alert.id }),
    });
    window.location.reload();
  };

  // Narrative builder
  const topProject = projectBreakdown[0];
  const topModel = modelBreakdown[0];
  const narrativeParts: string[] = [];

  if (win.duration_minutes <= 5) {
    narrativeParts.push(`In a brief ${win.duration_minutes}-minute burst`);
  } else if (win.duration_minutes <= 15) {
    narrativeParts.push(`Over the course of ${win.duration_minutes} minutes`);
  } else {
    narrativeParts.push(`Across a ${win.duration_minutes}-minute window`);
  }

  if (topProject) {
    if (projectBreakdown.length === 1) {
      narrativeParts.push(`the ${topProject.display_name} project consumed ${formatCost(totals.total_cost_usd)} in equivalent API cost`);
    } else {
      narrativeParts.push(`${projectBreakdown.length} projects consumed a combined ${formatCost(totals.total_cost_usd)} in equivalent API cost, with ${topProject.display_name} accounting for ${topProject.pct_of_total.toFixed(0)}% of the spend`);
    }
  }

  if (topModel) {
    narrativeParts.push(`${topModel.model ?? 'an unknown model'} bore the lion's share at ${formatCost(topModel.cost_usd)}`);
  }

  if (stats.cache_hit_rate > 50) {
    narrativeParts.push(`Cache efficiency was strong at ${stats.cache_hit_rate}%, keeping input costs in check`);
  } else if (stats.cache_hit_rate > 0) {
    narrativeParts.push(`Cache hit rate was a modest ${stats.cache_hit_rate}%`);
  }

  if (thinkingBlocks.length > 0) {
    narrativeParts.push(`The model produced ${thinkingBlocks.length} thinking stream${thinkingBlocks.length > 1 ? 's' : ''} totalling ${stats.thinking_chars.toLocaleString()} characters of internal reasoning`);
  }

  const narrative = narrativeParts.join('. ') + '.';

  return (
    <div className="space-y-6 max-w-6xl">
      <PageContext
        pageType="alert-detail"
        summary={`Alert #${alert.id}: ${alert.metric} exceeded ${formatTokens(alert.threshold_value)} (actual: ${formatTokens(alert.actual_value)}, ${ratio}x) in ${win.duration_minutes}min window. Total cost: ${formatCost(totals.total_cost_usd)}.`}
        metrics={{
          alert_id: alert.id,
          metric: alert.metric,
          ratio,
          window_minutes: win.duration_minutes,
          total_cost: totals.total_cost_usd,
          cost_per_minute: stats.cost_per_minute,
          projects_involved: projectBreakdown.length,
          thinking_blocks: stats.thinking_blocks,
        }}
      />

      {/* Navigation */}
      <div className="flex items-center gap-3">
        <Link href="/usage" className="text-xs text-[var(--color-accent)] hover:underline">
          &larr; Usage Monitor
        </Link>
        <span className="text-xs text-[var(--color-border)]">/</span>
        <span className="text-xs text-[var(--color-muted)]">Alert #{alert.id}</span>
      </div>

      {/* ===== HEADER ===== */}
      <div className={`rounded p-5 space-y-3 border ${alert.acknowledged ? 'bg-[var(--color-surface)] border-[var(--color-border)]' : 'bg-red-950/30 border-[var(--color-error)]'}`}>
        <div className="flex items-center justify-between">
          <div className="text-[10px] text-[var(--color-muted)] uppercase tracking-[0.2em] font-bold">
            Alert Investigation Report
          </div>
          {alert.acknowledged ? (
            <span className="text-[10px] text-[var(--color-accent)] bg-[var(--color-surface-hover)] px-2 py-0.5 rounded uppercase">Acknowledged</span>
          ) : (
            <button
              onClick={acknowledge}
              className="text-xs px-3 py-1 bg-[var(--color-error)] text-white rounded font-bold hover:opacity-90 transition-opacity"
            >
              Acknowledge
            </button>
          )}
        </div>
        <div className="text-lg font-bold">
          #{alert.id}{' '}
          <span className="text-[var(--color-muted)] font-normal text-sm">{formatTimestamp(alert.triggered_at)}</span>
        </div>
        <div className="flex items-center gap-4 text-sm flex-wrap">
          <span className="bg-[var(--color-error)] text-white px-2 py-0.5 rounded text-xs font-bold uppercase">
            {alert.metric.replace(/_/g, ' ')}
          </span>
          <span>
            <span className="text-[var(--color-muted)]">threshold</span>{' '}
            <span className="font-bold">{formatTokens(alert.threshold_value)}</span>
          </span>
          <span>
            <span className="text-[var(--color-muted)]">actual</span>{' '}
            <span className="font-bold text-[var(--color-error)]">{formatTokens(alert.actual_value)}</span>
          </span>
          <span className="text-[var(--color-error)] font-bold text-lg">{ratio}x</span>
          <span className="bg-[var(--color-surface-hover)] text-[var(--color-muted)] px-2 py-0.5 rounded text-xs">
            {win.duration_minutes}min window
          </span>
        </div>
      </div>

      {/* ===== A. EXECUTIVE SUMMARY ===== */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-5 space-y-4">
        <div className="text-[10px] text-[var(--color-muted)] uppercase tracking-[0.15em] font-bold">
          A &mdash; Executive Summary
        </div>

        {/* Stat cards grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-2">
          <StatCard label="Total Cost" value={formatCost(totals.total_cost_usd)} sub={`${formatCost(stats.cost_per_minute)}/min`} warn />
          <StatCard label="Total Tokens" value={formatTokens(totals.total_tokens)} sub={`${formatTokens(stats.tokens_per_minute)}/min`} />
          <StatCard label="Messages" value={totals.messages.toLocaleString()} sub={`${activeSessions.length} sessions`} />
          <StatCard label="Output Share" value={`${stats.output_share_pct}%`} sub={`${formatTokens(totals.output_tokens)} of ${formatTokens(totals.total_tokens)}`} />
          <StatCard label="Cache Hit Rate" value={`${stats.cache_hit_rate}%`} sub={`${formatTokens(totals.cache_read_tokens)} cached`} />
        </div>

        {/* Second row */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-2">
          <StatCard label="Input Tokens" value={formatTokens(totals.input_tokens)} sub={formatCost((totals.input_tokens / 1_000_000) * 5)} />
          <StatCard label="Output Tokens" value={formatTokens(totals.output_tokens)} sub={formatCost((totals.output_tokens / 1_000_000) * 25)} warn={stats.output_share_pct > 40} />
          <StatCard label="Cache Read" value={formatTokens(totals.cache_read_tokens)} sub={formatCost((totals.cache_read_tokens / 1_000_000) * 0.50)} />
          <StatCard label="Cache Write" value={formatTokens(totals.cache_creation_tokens)} sub={formatCost((totals.cache_creation_tokens / 1_000_000) * 6.25)} />
          <StatCard label="I/O Ratio" value={`${stats.input_output_ratio}:1`} sub={`${stats.unique_models} model${stats.unique_models !== 1 ? 's' : ''}`} />
        </div>

        {/* Narrative */}
        <div className="text-sm leading-relaxed text-[var(--color-foreground)] border-l-2 border-[var(--color-accent)] pl-4 italic">
          {narrative}
        </div>
      </div>

      {/* ===== TIMELINE CHART ===== */}
      {timeline && timeline.length > 1 && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-5 space-y-3">
          <div className="text-[10px] text-[var(--color-muted)] uppercase tracking-[0.15em] font-bold">
            Token Burn &mdash; Minute by Minute
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={timeline}>
              <XAxis
                dataKey="minute"
                tick={{ fill: '#71717a', fontSize: 10 }}
                tickFormatter={(m: string) => m.slice(11, 16)}
              />
              <YAxis tick={{ fill: '#71717a', fontSize: 10 }} tickFormatter={(v: number) => formatTokens(v)} />
              <Tooltip
                contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, fontSize: 12 }}
                formatter={(v) => formatTokens(Number(v ?? 0))}
              />
              <Area type="monotone" dataKey="input_tokens" name="Input" stroke="#60a5fa" fill="#60a5fa" fillOpacity={0.15} stackId="1" />
              <Area type="monotone" dataKey="output_tokens" name="Output" stroke="#a78bfa" fill="#a78bfa" fillOpacity={0.15} stackId="1" />
              <Area type="monotone" dataKey="cache_read_tokens" name="Cache Read" stroke="#10b981" fill="#10b981" fillOpacity={0.08} stackId="1" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ===== B. COST BY PROJECT ===== */}
      {projectBreakdown.length > 0 && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-5 space-y-4">
          <div className="text-[10px] text-[var(--color-muted)] uppercase tracking-[0.15em] font-bold">
            B &mdash; Cost by Project
          </div>

          <div className="flex gap-6 items-start">
            {/* Table */}
            <div className="flex-1 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[var(--color-muted)] border-b border-[var(--color-border)]">
                    <th className="pb-2">Project</th>
                    <th className="pb-2 text-right">Input</th>
                    <th className="pb-2 text-right">Output</th>
                    <th className="pb-2 text-right">Cache</th>
                    <th className="pb-2 text-right">Msgs</th>
                    <th className="pb-2 text-right">Cost</th>
                    <th className="pb-2 text-right">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {projectBreakdown.map((p: any, i: number) => (
                    <tr key={p.name} className={`border-b border-[var(--color-border)] ${i === 0 ? 'bg-[var(--color-background)]' : ''}`}>
                      <td className="py-2 font-bold">
                        <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                        {p.display_name}
                      </td>
                      <td className="py-2 text-right text-[var(--color-muted)]">{formatTokens(p.input_tokens)}</td>
                      <td className="py-2 text-right text-[var(--color-muted)]">{formatTokens(p.output_tokens)}</td>
                      <td className="py-2 text-right text-[var(--color-muted)]">{formatTokens(p.cache_read_tokens + p.cache_creation_tokens)}</td>
                      <td className="py-2 text-right text-[var(--color-muted)]">{p.message_count}</td>
                      <td className="py-2 text-right font-bold text-[var(--color-error)]">{formatCost(p.cost_usd)}</td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {p.pct_of_total.toFixed(1)}%
                        <ProgressBar value={p.pct_of_total} max={100} color={PIE_COLORS[i % PIE_COLORS.length]} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Donut */}
            {projectPie.length > 1 && (
              <div className="shrink-0 w-44">
                <ResponsiveContainer width="100%" height={160}>
                  <PieChart>
                    <Pie
                      data={projectPie}
                      innerRadius={40}
                      outerRadius={65}
                      paddingAngle={2}
                      dataKey="value"
                    >
                      {projectPie.map((_: any, i: number) => (
                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, fontSize: 11 }}
                      formatter={(v) => formatCost(Number(v ?? 0))}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== C. COST BY MODEL ===== */}
      {modelBreakdown.length > 0 && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-5 space-y-4">
          <div className="text-[10px] text-[var(--color-muted)] uppercase tracking-[0.15em] font-bold">
            C &mdash; Cost by Model
          </div>

          <div className="flex gap-6 items-start">
            <div className="flex-1 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[var(--color-muted)] border-b border-[var(--color-border)]">
                    <th className="pb-2">Model</th>
                    <th className="pb-2 text-right">Messages</th>
                    <th className="pb-2 text-right">Input</th>
                    <th className="pb-2 text-right">Output</th>
                    <th className="pb-2 text-right">Cache</th>
                    <th className="pb-2 text-right">Cost</th>
                    <th className="pb-2 text-right">$/msg</th>
                  </tr>
                </thead>
                <tbody>
                  {modelBreakdown.map((m: any, i: number) => {
                    const costPerMsg = m.message_count > 0 ? m.cost_usd / m.message_count : 0;
                    return (
                      <tr key={i} className="border-b border-[var(--color-border)]">
                        <td className="py-2 font-mono font-bold">
                          <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                          {m.model ?? 'unknown'}
                        </td>
                        <td className="py-2 text-right text-[var(--color-muted)]">{m.message_count}</td>
                        <td className="py-2 text-right text-[var(--color-muted)]">{formatTokens(m.input_tokens)}</td>
                        <td className="py-2 text-right text-[var(--color-muted)]">{formatTokens(m.output_tokens)}</td>
                        <td className="py-2 text-right text-[var(--color-muted)]">{formatTokens(m.cache_read_tokens + m.cache_creation_tokens)}</td>
                        <td className="py-2 text-right font-bold text-[var(--color-error)]">{formatCost(m.cost_usd)}</td>
                        <td className="py-2 text-right text-[var(--color-muted)]">{formatCost(costPerMsg)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {modelPie.length > 1 && (
              <div className="shrink-0 w-44">
                <ResponsiveContainer width="100%" height={160}>
                  <PieChart>
                    <Pie
                      data={modelPie}
                      innerRadius={40}
                      outerRadius={65}
                      paddingAngle={2}
                      dataKey="value"
                    >
                      {modelPie.map((_: any, i: number) => (
                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, fontSize: 11 }}
                      formatter={(v) => formatCost(Number(v ?? 0))}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== D. ACTIVE SESSIONS ===== */}
      {activeSessions.length > 0 && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-5 space-y-3">
          <div className="text-[10px] text-[var(--color-muted)] uppercase tracking-[0.15em] font-bold">
            D &mdash; Active Sessions ({activeSessions.length})
          </div>
          <div className="space-y-1">
            {activeSessions.map((s: any) => (
              <div key={s.session_uuid} className="flex items-center gap-3 text-xs py-2 px-2 rounded hover:bg-[var(--color-surface-hover)] border-b border-[var(--color-border)] last:border-0">
                <span className="font-bold w-36 truncate shrink-0">{s.display_name}</span>
                {s.git_branch && (
                  <span className="bg-[var(--color-surface-hover)] text-[var(--color-accent)] px-1.5 py-0.5 rounded font-mono text-[10px] shrink-0">
                    {s.git_branch}
                  </span>
                )}
                <span className="text-[var(--color-muted)] truncate flex-1">
                  {s.first_prompt ? (s.first_prompt.length > 100 ? s.first_prompt.slice(0, 100) + '\u2026' : s.first_prompt) : 'no initial prompt'}
                </span>
                <span className="text-[var(--color-muted)] shrink-0">{s.message_count} msgs</span>
                <span className="font-bold shrink-0">{formatTokens(s.input_tokens + s.output_tokens)}</span>
                <Link
                  href={`/projects/${encodeURIComponent(s.project_name)}/${s.session_uuid}`}
                  className="text-[var(--color-accent)] hover:underline shrink-0"
                >
                  inspect &rarr;
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ===== E. REPOSITORY CONTEXT ===== */}
      {uniqueProjects.length > 0 && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-5 space-y-4">
          <div className="text-[10px] text-[var(--color-muted)] uppercase tracking-[0.15em] font-bold">
            E &mdash; Repository Context
          </div>
          {uniqueProjects.map((proj: string) => {
            const displayName = activeSessions.find((s: any) => s.project_name === proj)?.display_name ?? proj;
            return (
              <div key={proj} className="border-l-2 border-[var(--color-accent)] pl-4 space-y-2">
                <div className="text-sm font-bold">{displayName}</div>
                <RepoContext projectName={proj} />
              </div>
            );
          })}
        </div>
      )}

      {/* ===== F. WHAT THE HUMAN ASKED ===== */}
      {userPrompts && userPrompts.length > 0 && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-5 space-y-3">
          <div className="text-[10px] text-[var(--color-muted)] uppercase tracking-[0.15em] font-bold">
            F &mdash; What the Human Asked ({userPrompts.length} prompts)
          </div>
          <div className="space-y-2">
            {userPrompts.map((p: any, i: number) => (
              <div key={i} className="border-l-2 border-[var(--color-user)] pl-3 py-1">
                <div className="flex items-center gap-2 text-[10px] text-[var(--color-muted)]">
                  <span>{formatTimestamp(p.timestamp)}</span>
                  <span className="text-[var(--color-user)] font-bold">{p.display_name}</span>
                </div>
                <div className="text-xs text-[var(--color-foreground)] mt-0.5">
                  {p.prompt.length > 300 ? p.prompt.slice(0, 300) + '\u2026' : p.prompt}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ===== G. THINKING STREAMS ===== */}
      {thinkingBlocks.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-[10px] text-[var(--color-muted)] uppercase tracking-[0.15em] font-bold">
              G &mdash; Thinking Streams
              <span className="normal-case tracking-normal font-normal ml-2">
                {thinkingBlocks.length} blocks, {stats.thinking_chars.toLocaleString()} chars
              </span>
            </div>
            <button
              onClick={() => setExpandAll(!expandAll)}
              className="text-xs text-[var(--color-accent)] hover:underline"
            >
              {expandAll ? 'Collapse All' : 'Expand All'}
            </button>
          </div>
          <div className="text-xs text-[var(--color-muted)] italic">
            Latest first. Full reasoning chains &mdash; nothing truncated.
          </div>
          <div className="space-y-2">
            {thinkingBlocks.map((b: any, i: number) => (
              <ThinkingBlock key={i} block={b} forceExpand={expandAll} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
