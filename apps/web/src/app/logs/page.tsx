'use client';

import { useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { formatTimestamp, formatRelativeTime } from '@sexy-logger/core/format';
import { PageContext } from '@/components/PageContext';
import { TimeRangeSelect, useTimeRange, getTimeRangeFrom } from '@/components/TimeRangeSelect';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function AllLogsPage() {
  const [limit, setLimit] = useState(100);
  const [typeFilter, setTypeFilter] = useState('user,assistant,system');
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

  const from = getTimeRangeFrom(range);

  const params = new URLSearchParams({
    limit: String(limit),
    types: typeFilter,
    offset: String(page * limit),
  });
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
        summary={`All logs. ${total} entries. Filter: ${typeFilter}. Date: ${range}. Search: "${searchDebounced || 'none'}".`}
        metrics={{ entries: total, type_filter: typeFilter, date: range }}
      />
      <div className="flex items-center justify-between mb-2 shrink-0">
        <h2 className="text-lg font-bold">All Logs</h2>
        <span className="text-sm text-[var(--color-muted)]">
          {total.toLocaleString()} total
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
          onChange={(e) => { setTypeFilter(e.target.value); setPage(0); }}
          className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-1 text-xs"
        >
          <option value="user,assistant,system">All types</option>
          <option value="user">User</option>
          <option value="assistant">Assistant</option>
          <option value="system">System</option>
        </select>
        <select
          value={limit}
          onChange={(e) => { setLimit(Number(e.target.value)); setPage(0); }}
          className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-1 text-xs"
        >
          <option value={50}>50</option>
          <option value={100}>100</option>
          <option value={200}>200</option>
          <option value={500}>500</option>
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

      <div className="flex-1 min-h-0 overflow-y-auto space-y-1">
        {entries.map((entry: any) => (
          <LogEntry key={entry.id} entry={entry} searchTerm={searchDebounced} />
        ))}
        {!isLoading && entries.length === 0 && (
          <div className="text-center text-[var(--color-muted)] py-8">
            No logs found for the current filters.
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

function LogEntry({ entry, searchTerm }: { entry: any; searchTerm: string }) {
  const [expanded, setExpanded] = useState(false);

  const borderColor =
    entry.type === 'user'
      ? 'var(--color-user)'
      : entry.type === 'assistant'
        ? 'var(--color-assistant)'
        : 'var(--color-border)';

  const typeLabel =
    entry.type === 'user' ? 'USR'
      : entry.type === 'assistant' ? 'AST'
        : 'SYS';

  const preview = entry.preview ?? '';

  return (
    <div
      className="border-l-2 pl-3 py-1 hover:bg-[var(--color-surface)] cursor-pointer"
      style={{ borderColor }}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="font-bold w-8 shrink-0" style={{ color: borderColor }}>
          {typeLabel}
        </span>
        <Link
          href={`/projects/${encodeURIComponent(entry.projectName)}`}
          className="text-[var(--color-accent)] hover:underline truncate max-w-[150px]"
          onClick={(e) => e.stopPropagation()}
        >
          {entry.projectDisplay}
        </Link>
        {entry.sessionDisplay && (
          <Link
            href={`/projects/${encodeURIComponent(entry.projectName)}/${entry.sessionUuid}`}
            className="text-xs text-[var(--color-muted)] hover:text-[var(--color-accent)] truncate max-w-[120px]"
            onClick={(e) => e.stopPropagation()}
            title={entry.sessionDisplay}
          >
            {entry.sessionDisplay}
          </Link>
        )}
        {entry.model && (
          <span className="text-xs text-[var(--color-muted)] shrink-0">
            {entry.model.replace('claude-', '').replace(/-\d{8}$/, '')}
          </span>
        )}
        {entry.timestamp && (
          <span className="text-xs text-[var(--color-muted)] ml-auto shrink-0" title={formatTimestamp(entry.timestamp)}>
            {formatRelativeTime(entry.timestamp)}
          </span>
        )}
      </div>
      <div className="text-sm mt-0.5">
        {expanded ? (
          <div className="whitespace-pre-wrap break-words">{preview}</div>
        ) : (
          <span className="text-[var(--color-muted)] break-words line-clamp-2">
            {searchTerm ? highlightSearch(preview.replace(/\n/g, ' '), searchTerm) : preview.replace(/\n/g, ' ')}
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
