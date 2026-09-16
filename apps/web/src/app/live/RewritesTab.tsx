'use client';

/**
 * The Rewrites tab of the live view: harnesses caught rewriting their own
 * journal, with the leaf before and the leaf after.
 *
 * A Claude Code transcript is a black box that rewrites lines near the tail
 * of a LIVE file — 2026-09-16 the witness read "leaf 2255 differs" 37 s
 * after recording it, on two transcripts nobody had touched. The ingester
 * now records every such rewrite (`/api/sessions/rewrites`) with the leaf
 * hash and text on each side. This tab is where those are read: newest
 * first, filterable by harness, each row opening into BEFORE / AFTER.
 *
 * Polls every ~10 s while the tab is on screen, and stops while the page
 * is hidden — a rewrite that happened while nobody was looking is still
 * there when they come back.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatTimestamp } from '@unturf/unfirehose/format';
import { tryPrettyJson } from '@unturf/unfirehose-ui/json-output';

export const REWRITES_POLL_MS = 10_000;
/** The API caps `before_text` / `after_text` at this many chars. */
export const REWRITE_TEXT_CAP = 4096;

export interface RewriteRow {
  id: number;
  session_uuid: string;
  /** Null when the ingester could not tie the journal to a project or harness. */
  project: string | null;
  harness: string | null;
  seq: number;
  kind: 'rewritten' | 'truncated';
  observed_at: string;
  file_lines: number;
  tail_distance: number;
  before_hash: string;
  after_hash: string | null;
  before_text: string;
  after_text: string | null;
  before_len: number;
  after_len: number | null;
  truncated: boolean;
  changed_keys: string[];
  content_changed: boolean;
  before_type: string | null;
  after_type: string | null;
}

export interface RewriteSummary {
  total: number;
  sessions: number;
  byHarness: Record<string, number>;
  maxTailDistance: number;
  contentChanged: number;
  metadataOnly: number;
  truncations?: number;
  byChangedKey: Record<string, number>;
}

export interface RewritesResponse {
  summary: RewriteSummary;
  rows: RewriteRow[];
}

const EMPTY_SUMMARY: RewriteSummary = {
  total: 0, sessions: 0, byHarness: {}, maxTailDistance: 0,
  contentChanged: 0, metadataOnly: 0, byChangedKey: {},
};

export const REWRITES_HOURS = 24;
export const REWRITES_LIMIT = 50;

export function rewritesUrl(opts: { harness?: string | null; session?: string | null } = {}): string {
  const q = new URLSearchParams({ limit: String(REWRITES_LIMIT), hours: String(REWRITES_HOURS) });
  if (opts.harness) q.set('harness', opts.harness);
  if (opts.session) q.set('session', opts.session);
  return `/api/sessions/rewrites?${q.toString()}`;
}

/** One line for the header: what the last 24h of rewrites amount to. */
export function summaryLine(s: RewriteSummary): string {
  const n = s.total;
  const topKeys = Object.entries(s.byChangedKey)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([k, c]) => `${k} ×${c}`)
    .join(', ');
  return [
    `${n} ${n === 1 ? 'rewrite' : 'rewrites'} in ${s.sessions} ${s.sessions === 1 ? 'session' : 'sessions'} over ${REWRITES_HOURS}h`,
    `max tail distance ${s.maxTailDistance}`,
    `content changed ${s.contentChanged}`,
    `metadata only ${s.metadataOnly}`,
    topKeys ? `top keys: ${topKeys}` : null,
  ].filter(Boolean).join(' · ');
}

// Same hash the feed uses for its harness badges, so claude-code is the
// same tone on both tabs.
const HARNESS_COLORS = [
  '#10b981', '#a78bfa', '#60a5fa', '#f472b6', '#fbbf24',
  '#34d399', '#818cf8', '#38bdf8', '#fb923c', '#a3e635',
  '#e879f9', '#2dd4bf', '#f87171', '#facc15', '#4ade80',
  '#c084fc', '#22d3ee', '#fb7185', '#a8a29e', '#84cc16',
  '#67e8f9',
];
function harnessColor(harness: string): string {
  let h = 0;
  for (let i = 0; i < harness.length; i++) h = (h * 31 + harness.charCodeAt(i)) | 0;
  return HARNESS_COLORS[Math.abs(h) % HARNESS_COLORS.length];
}

/** The count on the tab label — nothing at zero, so a quiet day is quiet. */
export function RewritesTabBadge({ count }: { count: number }) {
  if (!(count > 0)) return null;
  return (
    <span
      data-testid="rewrites-badge"
      className="ml-1.5 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full text-xs font-bold bg-[var(--color-error)] text-white"
      title={`${count} ${count === 1 ? 'rewrite' : 'rewrites'} recorded in the last ${REWRITES_HOURS}h`}
    >
      {count}
    </span>
  );
}

/**
 * The tab's own read of the count, for the label while the Feed tab is
 * showing: one call, `limit=1`, the summary is what matters.
 */
export async function fetchRewriteCount(): Promise<number> {
  try {
    const res = await fetch(`/api/sessions/rewrites?limit=1&hours=${REWRITES_HOURS}`);
    if (!res.ok) return 0;
    const data = (await res.json()) as Partial<RewritesResponse>;
    return data?.summary?.total ?? 0;
  } catch {
    return 0;
  }
}

function Chip({ children, title, color, active, onClick }: {
  children: React.ReactNode; title?: string; color?: string; active?: boolean; onClick?: () => void;
}) {
  const cls = 'text-xs px-1.5 py-0.5 rounded border whitespace-nowrap shrink-0';
  const style = {
    color: color ?? 'var(--color-muted)',
    borderColor: active ? (color ?? 'var(--color-foreground)') : 'color-mix(in srgb, currentColor 40%, transparent)',
    background: active ? 'color-mix(in srgb, currentColor 12%, transparent)' : undefined,
  };
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} className={`${cls} cursor-pointer hover:opacity-80`} style={style} aria-pressed={active}>
        {children}
      </button>
    );
  }
  return <span title={title} className={cls} style={style}>{children}</span>;
}

/**
 * Pretty JSON with the changed top-level keys lit. Pretty output from
 * `JSON.stringify(_, null, 2)` puts every top-level key at exactly two
 * spaces of indent, so lighting a key is a line-prefix match — no second
 * parse, no diff.
 */
function PrettyText({ text, highlightKeys }: { text: string; highlightKeys: Set<string> }) {
  const { pretty, isJson } = tryPrettyJson(text);
  if (!isJson || highlightKeys.size === 0) return <>{pretty}</>;
  const lines = pretty.split('\n');
  return (
    <>
      {lines.map((line, i) => {
        const m = /^ {2}"((?:[^"\\]|\\.)*)":/.exec(line);
        const lit = m ? highlightKeys.has(JSON.parse(`"${m[1]}"`)) : false;
        return (
          <span
            key={i}
            data-changed={lit ? 'true' : undefined}
            className={lit ? 'bg-[color-mix(in_srgb,var(--color-tool)_18%,transparent)] text-[var(--color-foreground)]' : undefined}
          >
            {line}{i < lines.length - 1 ? '\n' : ''}
          </span>
        );
      })}
    </>
  );
}

function LeafColumn({ label, hash, text, len, truncated, type, highlightKeys, gone }: {
  label: 'BEFORE' | 'AFTER';
  hash: string | null;
  text: string | null;
  len: number | null;
  truncated: boolean;
  type: string | null;
  highlightKeys: Set<string>;
  gone?: boolean;
}) {
  return (
    <div className="min-w-0 flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-bold text-[var(--color-muted)]">{label}</span>
        {hash && (
          <span className="font-mono text-[var(--color-muted)]" title={hash}>
            leaf {hash.slice(0, 12)}…
          </span>
        )}
        {type && <span className="text-[var(--color-muted)] opacity-70">{type}</span>}
        {len !== null && <span className="text-[var(--color-muted)] opacity-70">{len} chars</span>}
      </div>
      {gone ? (
        <div className="text-sm italic text-[var(--color-error)] py-2">
          the line no longer exists — the file was truncated past it
        </div>
      ) : (
        <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed bg-[var(--color-background)] rounded px-2 py-1.5 text-[var(--color-foreground)] opacity-90 max-h-[24rem] overflow-auto">
          <PrettyText text={text ?? ''} highlightKeys={highlightKeys} />
        </pre>
      )}
      {truncated && !gone && len !== null && (
        <div className="text-xs text-[var(--color-muted)]">
          truncated at {REWRITE_TEXT_CAP} of {len} chars
        </div>
      )}
    </div>
  );
}

export function RewriteRowView({ row }: { row: RewriteRow }) {
  const [open, setOpen] = useState(false);
  const harness = row.harness ?? 'unknown';
  const color = harnessColor(harness);
  const isTruncated = row.kind === 'truncated';
  // Light the changed keys only when both sides will pretty-print as JSON;
  // a capped body will not parse and the chips carry the same fact.
  const highlightKeys = useMemo(() => {
    if (isTruncated) return new Set<string>();
    const b = tryPrettyJson(row.before_text ?? '').isJson;
    const a = tryPrettyJson(row.after_text ?? '').isJson;
    return b && a ? new Set(row.changed_keys) : new Set<string>();
  }, [row, isTruncated]);

  return (
    <div
      data-testid="rewrite-row"
      className={`border-b border-[var(--color-border)]/30 hover:bg-[var(--color-surface)] transition-colors ${
        row.content_changed ? 'border-l-2 border-l-[var(--color-error)]' : ''
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full text-left flex flex-wrap gap-x-2 gap-y-1 pt-1.5 pb-1.5 px-3 min-w-0 items-center cursor-pointer"
      >
        <span className="shrink-0 text-[var(--color-muted)] text-sm" title={row.observed_at}>
          {formatTimestamp(row.observed_at)}
        </span>
        <span
          className="shrink-0 text-xs px-1.5 py-0.5 rounded border whitespace-nowrap"
          style={{ color, borderColor: 'color-mix(in srgb, currentColor 40%, transparent)' }}
          title={`harness: ${harness}`}
        >
          {harness}
        </span>
        {row.project && (
          <span className="truncate text-sm" style={{ color }} title={row.project}>
            {row.project}
          </span>
        )}
        {row.project ? (
          <Link
            href={`/projects/${encodeURIComponent(row.project)}/${row.session_uuid}`}
            className="shrink-0 font-mono text-sm text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:underline"
            title={row.session_uuid}
            onClick={(e) => e.stopPropagation()}
          >
            {row.session_uuid.slice(0, 8)}
          </Link>
        ) : (
          <span className="shrink-0 font-mono text-sm text-[var(--color-muted)]" title={row.session_uuid}>
            {row.session_uuid.slice(0, 8)}
          </span>
        )}
        <span className="shrink-0 text-sm text-[var(--color-foreground)]">
          line {row.seq}, {row.tail_distance} from tail
        </span>
        <span
          className={`shrink-0 text-sm font-bold px-1.5 py-0.5 rounded ${isTruncated ? 'text-[var(--color-error)]' : 'text-[var(--color-tool)]'}`}
          title={isTruncated ? 'the line was removed — the file is now shorter than it' : 'the line was rewritten in place'}
        >
          {row.kind}
        </span>
        {row.content_changed && (
          <span
            data-testid="content-changed"
            className="shrink-0 text-xs px-1.5 py-0.5 rounded border text-[var(--color-error)] font-bold"
            style={{ borderColor: 'color-mix(in srgb, currentColor 40%, transparent)' }}
            title="the content (not just metadata) differs between the two leafs"
          >
            content changed
          </span>
        )}
        {row.changed_keys.map((k) => (
          <Chip key={k} title={`top-level key changed: ${k}`}>{k}</Chip>
        ))}
        <span className="ml-auto shrink-0 text-xs text-[var(--color-muted)]">{open ? '▾' : '▸'} before / after</span>
      </button>

      {open && (
        <div
          data-testid="before-after"
          className="px-3 pb-3 pl-8 grid grid-cols-1 md:grid-cols-2 gap-3"
          style={{ background: 'color-mix(in srgb, var(--color-accent) 3%, var(--color-surface))' }}
        >
          <LeafColumn
            label="BEFORE"
            hash={row.before_hash}
            text={row.before_text}
            len={row.before_len}
            truncated={row.truncated}
            type={row.before_type}
            highlightKeys={highlightKeys}
          />
          <LeafColumn
            label="AFTER"
            hash={row.after_hash}
            text={row.after_text}
            len={row.after_len}
            truncated={row.truncated}
            type={row.after_type}
            highlightKeys={highlightKeys}
            gone={isTruncated}
          />
        </div>
      )}
    </div>
  );
}

export interface RewritesTabProps {
  /** Every poll reports the 24h total, for the badge on the tab label. */
  onTotal?: (total: number) => void;
  /** Override for tests; defaults to `REWRITES_POLL_MS`. */
  pollMs?: number;
}

export function RewritesTab({ onTotal, pollMs = REWRITES_POLL_MS }: RewritesTabProps) {
  const [data, setData] = useState<RewritesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [harness, setHarness] = useState<string | null>(null);
  // Harness chips come from the UNFILTERED summary, so picking one does not
  // make the others vanish: the last unfiltered byHarness is kept here.
  const [byHarness, setByHarness] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch(rewritesUrl({ harness }));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Partial<RewritesResponse>;
      const next: RewritesResponse = {
        summary: { ...EMPTY_SUMMARY, ...(body.summary ?? {}) },
        rows: Array.isArray(body.rows) ? body.rows : [],
      };
      setData(next);
      setError(null);
      // The unfiltered total is the badge and the unfiltered byHarness is the
      // chip row; a harness filter narrows the rows, not what the tab counts.
      if (!harness) {
        setByHarness(next.summary.byHarness);
        onTotal?.(next.summary.total);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [harness, onTotal]);

  // Poll while on screen. `document.hidden` pauses the interval so a
  // background tab is not hitting the API every ten seconds for nobody.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      void load();
      timer = setInterval(() => void load(), pollMs);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.hidden) stop();
      else start();
    };
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load, pollMs]);

  const rows = useMemo(() => {
    const list = data?.rows ?? [];
    // Newest first, whatever order the API used; client-side harness filter
    // too, so a stale response between polls never shows the wrong harness.
    return list
      .filter((r) => !harness || (r.harness ?? 'unknown') === harness)
      .slice()
      .sort((a, b) => (a.observed_at < b.observed_at ? 1 : a.observed_at > b.observed_at ? -1 : b.id - a.id));
  }, [data, harness]);

  const summary = data?.summary ?? EMPTY_SUMMARY;
  const harnesses = Object.entries(byHarness).sort(([, a], [, b]) => b - a);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="shrink-0 mb-2 space-y-2">
        <div className="text-base text-[var(--color-muted)]" data-testid="rewrites-summary">
          {data ? summaryLine(summary) : error ? `rewrites unavailable: ${error}` : 'loading rewrites…'}
        </div>
        {harnesses.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap" data-testid="harness-filter">
            <span className="text-xs text-[var(--color-muted)]">harness</span>
            <Chip active={harness === null} onClick={() => setHarness(null)} title="every harness">
              all
            </Chip>
            {harnesses.map(([h, n]) => (
              <Chip
                key={h}
                color={harnessColor(h)}
                active={harness === h}
                onClick={() => setHarness(harness === h ? null : h)}
                title={`${n} ${n === 1 ? 'rewrite' : 'rewrites'} by ${h}`}
              >
                {h} <span className="opacity-60">×{n}</span>
              </Chip>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto font-mono text-base">
        {data && rows.length === 0 && (
          <div className="text-[var(--color-muted)] text-base py-8 text-center space-y-1" data-testid="rewrites-empty">
            <div>
              {harness
                ? `no rewrites by ${harness} in the last ${REWRITES_HOURS}h`
                : `no rewrites recorded in the last ${REWRITES_HOURS}h — every unchained live journal has matched its shadow`}
            </div>
            <div className="text-sm opacity-80">
              This tab watches for a harness rewriting lines it already wrote to a live journal, and keeps the leaf before and after each one.
            </div>
          </div>
        )}
        {rows.map((row) => (
          <RewriteRowView key={row.id} row={row} />
        ))}
      </div>
    </div>
  );
}

export default RewritesTab;
