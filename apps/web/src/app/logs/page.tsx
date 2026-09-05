'use client';

import { fetcher } from '@unturf/unfirehose-ui/fetcher';

import { useState, useMemo } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { formatTimestamp, formatRelativeTime } from '@unturf/unfirehose/format';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import { TimeRangeSelect, useTimeRange, getTimeRangeFrom } from '@unturf/unfirehose-ui/TimeRangeSelect';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Virtual filter values are mapped to ?types + ?has_thinking in buildParams below.
// 'reasoning' is the only filter that turns on has_thinking.
const TYPE_FILTERS = {
  'user,assistant,system': { label: 'All types', types: 'user,assistant,system', hasThinking: false },
  'user':                  { label: 'User',      types: 'user',                  hasThinking: false },
  'assistant':             { label: 'Assistant', types: 'assistant',             hasThinking: false },
  'system':                { label: 'System',    types: 'system',                hasThinking: false },
  'reasoning':             { label: 'Reasoning', types: 'assistant',             hasThinking: true  },
} as const;
type TypeFilterKey = keyof typeof TYPE_FILTERS;

export default function AllLogsPage() {
  const [limit, setLimit] = useState(250);
  const [typeFilter, setTypeFilter] = useState<TypeFilterKey>('user,assistant,system');
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [range, setRange] = useTimeRange('logs_range', '24h');
  const [page, setPage] = useState(0);

  // Debounce search
  const [debounceTimer, setDebounceTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const handleSearch = (val: string) => {
    setSearch(val);
    if (debounceTimer) clearTimeout(debounceTimer);
    setDebounceTimer(setTimeout(() => { setSearchDebounced(val); setPage(0); }, 300));
  };

  const from = useMemo(() => getTimeRangeFrom(range), [range]);

  const filterCfg = TYPE_FILTERS[typeFilter];
  const params = new URLSearchParams({
    limit: String(limit),
    types: filterCfg.types,
    offset: String(page * limit),
  });
  if (filterCfg.hasThinking) params.set('has_thinking', 'true');
  if (searchDebounced) params.set('search', searchDebounced);
  if (from) params.set('from', from);

  const { data, error, isLoading } = useSWR(`/api/logs?${params}`, fetcher);
  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / limit);

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      <PageContext
        pageType="logs"
        summary={`All logs. ${total} entries. Filter: ${filterCfg.label}. Date: ${range}. Search: "${searchDebounced || 'none'}".`}
        metrics={{ entries: total, type_filter: filterCfg.label, date: range }}
      />
      <div className="flex items-center justify-between mb-2 shrink-0">
        <h2 className="text-lg font-bold">All Logs</h2>
        <span className="text-sm text-[var(--color-muted)]">
          {entries.length > 0 && `${(page * limit + 1).toLocaleString()}–${(page * limit + entries.length).toLocaleString()} of `}
          {total.toLocaleString()}
        </span>
      </div>

      {/* Controls */}
      <div className="flex gap-2 items-center mb-2 shrink-0 flex-wrap">
        <input
          type="text"
          placeholder="Search logs..."
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          className="flex-1 min-w-[200px] bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[var(--color-accent)]"
        />
        <TimeRangeSelect value={range} onChange={(v) => { setRange(v); setPage(0); }} />
        <select
          value={typeFilter}
          onChange={(e) => { setTypeFilter(e.target.value as TypeFilterKey); setPage(0); }}
          className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-1 text-xs"
        >
          {(Object.entries(TYPE_FILTERS) as [TypeFilterKey, typeof TYPE_FILTERS[TypeFilterKey]][]).map(([key, cfg]) => (
            <option key={key} value={key}>{cfg.label}</option>
          ))}
        </select>
        <select
          value={limit}
          onChange={(e) => { setLimit(Number(e.target.value)); setPage(0); }}
          className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-1 text-xs"
        >
          {/* The API caps a page at 500. Offering 30,000 here made "Page 1 of 12"
              a number computed against a page size the server never honoured. */}
          <option value={100}>100 / page</option>
          <option value={250}>250 / page</option>
          <option value={500}>500 / page</option>
        </select>
      </div>

      {error && (
        <div className="text-[var(--color-error)] text-sm mb-2 shrink-0">
          Failed to load: {data?.error ?? String(error)}
        </div>
      )}

      {isLoading && (
        <div className="text-[var(--color-muted)] text-sm mb-2 shrink-0">
          Querying...
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {groupBySession(entries).map((g) => (
          <SessionGroup key={g.key} group={g} searchTerm={searchDebounced} />
        ))}
        {!isLoading && entries.length === 0 && (
          <div className="text-center text-[var(--color-muted)] py-12 space-y-1">
            <div>Nothing here for these filters.</div>
            <div className="text-xs">Widen the time range, or clear the search.</div>
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2 border-t border-[var(--color-border)] mt-2 shrink-0">
          <button
            onClick={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
            className="px-3 py-1 text-xs rounded border border-[var(--color-border)] text-[var(--color-muted)] disabled:opacity-30 hover:border-[var(--color-accent)]"
          >
            Prev
          </button>
          <span className="text-xs text-[var(--color-muted)]">
            Page {page + 1} of {totalPages.toLocaleString()}
          </span>
          <button
            onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
            disabled={page >= totalPages - 1}
            className="px-3 py-1 text-xs rounded border border-[var(--color-border)] text-[var(--color-muted)] disabled:opacity-30 hover:border-[var(--color-accent)]"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Consecutive rows from one session, under one header.
 *
 * The page used to print project and session on every row — the same two
 * words two hundred times down the screen — and nothing else, because the
 * preview was empty. The header carries them once; the rows carry what the
 * message did.
 */
interface Group { key: string; entries: any[] }

function groupBySession(entries: any[]): Group[] {
  const out: Group[] = [];
  for (const e of entries) {
    const key = `${e.projectName}/${e.sessionUuid ?? 'none'}`;
    const last = out[out.length - 1];
    if (last && last.key === key) last.entries.push(e);
    else out.push({ key, entries: [e] });
  }
  return out;
}

function SessionGroup({ group, searchTerm }: { group: Group; searchTerm: string }) {
  const first = group.entries[0];
  const model = group.entries.find((e) => e.model)?.model;
  return (
    <section className="mb-2">
      <div className="sticky top-0 z-10 flex items-center gap-2 px-2 py-1 text-xs bg-[var(--color-background)]/95 backdrop-blur border-b border-[var(--color-border)]">
        <Link
          href={`/projects/${encodeURIComponent(first.projectName)}`}
          className="text-[var(--color-accent)] hover:underline font-medium truncate max-w-[200px]"
        >
          {first.projectDisplay}
        </Link>
        {first.sessionDisplay ? (
          <Link
            href={`/projects/${encodeURIComponent(first.projectName)}/${first.sessionUuid}`}
            className="text-[var(--color-muted)] hover:text-[var(--color-accent)] truncate max-w-[280px]"
            title={first.sessionDisplay}
          >
            {first.sessionDisplay}
          </Link>
        ) : first.sessionUuid ? (
          <span className="text-[var(--color-muted)] font-mono">{String(first.sessionUuid).slice(0, 8)}</span>
        ) : null}
        {model && <span className="text-[var(--color-muted)] shrink-0">{shortModel(model)}</span>}
        {first.isSidechain && <span className="text-[var(--color-muted)] shrink-0" title="subagent">↳ subagent</span>}
        <span className="ml-auto text-[var(--color-muted)] shrink-0">{group.entries.length}</span>
      </div>
      <div>
        {group.entries.map((entry: any) => (
          <LogEntry key={entry.id} entry={entry} searchTerm={searchTerm} />
        ))}
      </div>
    </section>
  );
}

const shortModel = (m: string) => m.replace('claude-', '').replace(/-\d{8}$/, '');

/** Speaker badge: three letters so the column stays aligned. */
const TYPE_BADGE: Record<string, { label: string; color: string }> = {
  user:      { label: 'USR', color: 'var(--color-user)' },
  assistant: { label: 'AST', color: 'var(--color-assistant)' },
};
const SYS_BADGE = { label: 'SYS', color: 'var(--color-border)' };

/** What the row is about, beside the speaker. */
function KindChip({ entry }: { entry: any }) {
  const base = 'shrink-0 px-1.5 rounded text-[11px] leading-5 font-mono';
  if (entry.kind === 'tool-call' && entry.tool) {
    return <span className={`${base} bg-[var(--color-tool)]/15 text-[var(--color-tool)]`}>{entry.tool}</span>;
  }
  if (entry.kind === 'tool-result') {
    return (
      <span className={`${base} ${entry.isError ? 'bg-[var(--color-error)]/15 text-[var(--color-error)]' : 'bg-[var(--color-surface-hover)] text-[var(--color-muted)]'}`}>
        ↳ {entry.tool ?? 'result'}{entry.isError ? ' ✕' : ''}
      </span>
    );
  }
  if (entry.kind === 'reasoning') {
    return <span className={`${base} bg-[var(--color-thinking)]/15 text-[var(--color-thinking)]`}>reasoning</span>;
  }
  if (entry.kind === 'system' && entry.subtype) {
    return <span className={`${base} text-[var(--color-muted)]`}>{String(entry.subtype).replace(/_/g, ' ')}</span>;
  }
  if (entry.hasReasoning) {
    return <span className={`${base} text-[var(--color-thinking)]`} title="this message also carried reasoning">◦</span>;
  }
  return null;
}

/** HH:MM:SS, with the full stamp and how long ago on hover. */
function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour12: false });
}

function LogEntry({ entry, searchTerm }: { entry: any; searchTerm: string }) {
  const [expanded, setExpanded] = useState(false);
  const badge = TYPE_BADGE[entry.type] ?? SYS_BADGE;
  // The API's preview names the tool so a search for the command still hits
  // the row; on screen the chip already says it, so the row shows the rest.
  const raw: string = entry.preview ?? '';
  const preview = entry.kind === 'tool-call' && entry.tool && raw.startsWith(`${entry.tool} `)
    ? raw.slice(entry.tool.length + 1)
    : raw;
  const mono = entry.kind === 'tool-call' || entry.kind === 'tool-result';
  const sealed = entry.kind === 'reasoning' && preview === '(reasoning, sealed)';
  const flat = preview.replace(/\n/g, ' ');

  return (
    <div
      className={`border-l-2 pl-2 pr-2 py-0.5 hover:bg-[var(--color-surface)] cursor-pointer ${entry.isError ? 'bg-[var(--color-error)]/5' : ''}`}
      style={{ borderColor: entry.isError ? 'var(--color-error)' : badge.color }}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start gap-2 text-sm">
        <span className="font-bold w-8 shrink-0 leading-5" style={{ color: badge.color }}>{badge.label}</span>
        <KindChip entry={entry} />
        {expanded ? (
          <div className={`flex-1 min-w-0 whitespace-pre-wrap break-words ${mono ? 'font-mono text-xs leading-5' : ''}`}>{preview}</div>
        ) : (
          <span className={`flex-1 min-w-0 truncate leading-5 ${mono ? 'font-mono text-xs' : ''} ${preview && !sealed ? '' : 'text-[var(--color-muted)] italic'} line-clamp-2`}>
            {preview
              ? (searchTerm ? highlightSearch(flat, searchTerm) : flat)
              : 'no content'}
          </span>
        )}
        {entry.timestamp && (
          <span
            className="text-xs text-[var(--color-muted)] shrink-0 font-mono leading-5"
            title={`${formatTimestamp(entry.timestamp)} · ${formatRelativeTime(entry.timestamp)}`}
          >
            {clock(entry.timestamp)}
          </span>
        )}
      </div>
    </div>
  );
}

function highlightSearch(text: string, term: string) {
  if (!term) return text;
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span className="bg-yellow-400/30 text-yellow-200">{text.slice(idx, idx + term.length)}</span>
      {text.slice(idx + term.length)}
    </>
  );
}
