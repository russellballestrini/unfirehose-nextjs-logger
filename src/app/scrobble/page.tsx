'use client';

import { useEffect, useState } from 'react';
import { formatTokens } from '@/lib/format';
import { PageContext } from '@/components/PageContext';

/* eslint-disable @typescript-eslint/no-explicit-any */

const VISIBILITY_OPTIONS = ['public', 'unlisted', 'private'] as const;
const VISIBILITY_ICONS: Record<string, string> = {
  public: 'o',
  unlisted: '~',
  private: 'x',
};
const VISIBILITY_COLORS: Record<string, string> = {
  public: '#10b981',
  unlisted: '#fbbf24',
  private: 'var(--color-muted)',
};

export default function ScrobblePage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/scrobble/preview')
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error);
        setData(d);
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  async function setVisibility(projectName: string, visibility: string) {
    setSaving(projectName);
    try {
      await fetch(`/api/projects/${encodeURIComponent(projectName)}/visibility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility }),
      });
      // Update local state
      setData((prev: any) => ({
        ...prev,
        projects: prev.projects.map((p: any) =>
          p.name === projectName ? { ...p, visibility } : p
        ),
      }));
    } catch {
      // silent
    }
    setSaving(null);
  }

  if (loading) return <p className="p-6 text-[var(--color-muted)]">Loading...</p>;
  if (!data) return <p className="p-6 text-[var(--color-error)]">Failed to load scrobble data</p>;

  const publicCount = data.projects.filter((p: any) => p.visibility === 'public').length;
  const unlistedCount = data.projects.filter((p: any) => p.visibility === 'unlisted').length;
  const privateCount = data.projects.filter((p: any) => p.visibility === 'private').length;

  return (
    <div className="p-6 max-w-5xl">
      <PageContext pageType="scrobble" summary={`Scrobble Preview. ${data?.projects?.length ?? 0} projects.`} metrics={{ projects: data?.projects?.length ?? 0, public: publicCount, private: privateCount }} />
      <h1 className="text-xl font-bold mb-2">Scrobble Preview</h1>
      <p className="text-[var(--color-muted)] text-sm mb-6">
        Review and configure what data will be shared. Set each project&apos;s visibility before enabling scrobble.
      </p>

      {/* Summary */}
      <div className="flex gap-4 mb-6 text-sm">
        <span style={{ color: VISIBILITY_COLORS.public }}>{publicCount} public</span>
        <span style={{ color: VISIBILITY_COLORS.unlisted }}>{unlistedCount} unlisted</span>
        <span style={{ color: VISIBILITY_COLORS.private }}>{privateCount} private</span>
      </div>

      {/* What's included / excluded */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        <div className="border border-[var(--color-border)] rounded p-4">
          <h3 className="text-sm font-bold text-green-400 mb-2">Included in scrobble</h3>
          <ul className="space-y-1 text-sm text-[var(--color-muted)]">
            {data.included?.map((item: string, i: number) => (
              <li key={i} className="flex items-center gap-2">
                <span className="text-green-400">+</span> {item}
              </li>
            ))}
          </ul>
        </div>
        <div className="border border-[var(--color-border)] rounded p-4">
          <h3 className="text-sm font-bold text-red-400 mb-2">Excluded from scrobble</h3>
          <ul className="space-y-1 text-sm text-[var(--color-muted)]">
            {data.excluded?.map((item: string, i: number) => (
              <li key={i} className="flex items-center gap-2">
                <span className="text-red-400">-</span> {item}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Projects with visibility controls */}
      <h2 className="text-lg font-bold mb-4">Projects ({data.projects.length})</h2>
      <div className="space-y-2">
        {data.projects.map((p: any) => (
          <div
            key={p.name}
            className="border border-[var(--color-border)] rounded p-4 flex items-center gap-4"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium truncate">{p.displayName}</span>
                <span
                  className="text-xs px-1.5 py-0.5 rounded"
                  style={{
                    color: VISIBILITY_COLORS[p.visibility],
                    backgroundColor: `${VISIBILITY_COLORS[p.visibility]}22`,
                  }}
                >
                  {p.visibility}
                </span>
                {p.autoDetected?.startsWith('public_remote:') && (
                  <span
                    className="text-xs px-1.5 py-0.5 rounded"
                    style={{ color: '#10b981', backgroundColor: '#10b98122' }}
                    title={p.autoDetected.replace('public_remote:', '')}
                  >
                    open source
                  </span>
                )}
              </div>
              <div className="text-xs text-[var(--color-muted)] mt-1">
                {p.sessionCount} sessions / {p.messageCount.toLocaleString()} messages / {formatTokens(p.totalInput + p.totalOutput)} tokens
              </div>
            </div>
            <div className="flex gap-1 shrink-0">
              {VISIBILITY_OPTIONS.map(opt => (
                <button
                  key={opt}
                  onClick={() => setVisibility(p.name, opt)}
                  disabled={saving === p.name}
                  className={`px-2 py-1 text-xs rounded border transition-colors ${
                    p.visibility === opt
                      ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                      : 'border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-accent)]'
                  }`}
                  title={opt}
                >
                  {VISIBILITY_ICONS[opt]} {opt}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Model summary */}
      {data.modelSummary?.length > 0 && (
        <div className="mt-8 border border-[var(--color-border)] rounded p-4">
          <h3 className="text-sm font-bold mb-3 text-[var(--color-muted)]">Model Usage (scrobbled)</h3>
          <div className="space-y-1">
            {data.modelSummary.map((m: any) => (
              <div key={m.model} className="flex justify-between text-sm">
                <span className="font-mono truncate">{m.model}</span>
                <span className="text-[var(--color-muted)] shrink-0 ml-2">
                  {m.messages} msgs / {formatTokens(m.input + m.output)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tool summary */}
      {data.toolSummary?.length > 0 && (
        <div className="mt-4 border border-[var(--color-border)] rounded p-4">
          <h3 className="text-sm font-bold mb-3 text-[var(--color-muted)]">Tool Usage (scrobbled)</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {data.toolSummary.map((t: any) => (
              <div key={t.tool_name} className="flex justify-between text-sm">
                <span className="font-mono">{t.tool_name}</span>
                <span className="text-[var(--color-muted)]">{t.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
