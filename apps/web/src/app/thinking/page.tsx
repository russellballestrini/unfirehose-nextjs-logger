'use client';

import { useState, useMemo } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { formatTimestamp, formatRelativeTime } from '@sexy-logger/core/format';
import { PageContext } from '@sexy-logger/ui/PageContext';
import { TimeRangeSelect, useTimeRange, getTimeRangeFrom } from '@sexy-logger/ui/TimeRangeSelect';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function ThinkingPage() {
  const [limit, setLimit] = useState(200);
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [range, setRange] = useTimeRange('thinking_range', '24h');
  const [page, setPage] = useState(0);

  const [debounceTimer, setDebounceTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const handleSearch = (val: string) => {
    setSearch(val);
    if (debounceTimer) clearTimeout(debounceTimer);
    setDebounceTimer(setTimeout(() => { setSearchDebounced(val); setPage(0); }, 300));
  };

  const from = useMemo(() => getTimeRangeFrom(range), [range]);

  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(page * limit),
  });
  if (searchDebounced) params.set('search', searchDebounced);
  if (from) params.set('from', from);

  const { data, error, isLoading } = useSWR(`/api/thinking?${params}`, fetcher);
  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / limit);

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      <PageContext
        pageType="thinking"
        summary={`Thinking stream. ${total} blocks. Date: ${range}. Search: "${searchDebounced || 'none'}".`}
        metrics={{ thinking_blocks: total, date: range, search_query: searchDebounced || 'none' }}
      />
      <div className="flex items-center justify-between mb-2 shrink-0">
        <h2 className="text-lg font-bold">Thinking Stream</h2>
        <span className="text-sm text-[var(--color-muted)]">
          {total.toLocaleString()} blocks
        </span>
      </div>

      {/* Controls */}
      <div className="flex gap-2 items-center mb-3 shrink-0 flex-wrap">
        <input
          type="text"
          placeholder="Search thinking content..."
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          className="flex-1 min-w-[200px] bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[var(--color-thinking)]"
        />
        <TimeRangeSelect value={range} onChange={(v) => { setRange(v); setPage(0); }} />
        <select
          value={limit}
          onChange={(e) => { setLimit(Number(e.target.value)); setPage(0); }}
          className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-1 text-xs"
        >
          <option value={100}>100</option>
          <option value={200}>200</option>
          <option value={500}>500</option>
          <option value={1000}>1,000</option>
        </select>
      </div>

      {error && (
        <div className="text-[var(--color-error)] text-sm mb-2 shrink-0">
          Failed to load: {data?.error ?? String(error)}
        </div>
      )}

      {isLoading && (
        <div className="text-[var(--color-muted)] text-sm mb-2 shrink-0">
          Querying thinking blocks...
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
        {entries.map((excerpt: any, i: number) => (
          <ThinkingCard key={`${excerpt.sessionId}-${i}`} excerpt={excerpt} searchTerm={searchDebounced} />
        ))}
        {!isLoading && entries.length === 0 && (
          <div className="text-center text-[var(--color-muted)] py-8">
            No thinking blocks found for the current filters.
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

function ThinkingCard({ excerpt, searchTerm }: { excerpt: any; searchTerm: string }) {
  const [expanded, setExpanded] = useState(false);
  const thinkingPreview = expanded ? excerpt.thinking : excerpt.thinking?.slice(0, 600);
  const isTruncated = !expanded && excerpt.thinking?.length > 600;

  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-4">
      <div className="flex items-center gap-3 mb-2 flex-wrap text-sm">
        <Link
          href={`/projects/${encodeURIComponent(excerpt.project)}`}
          className="text-[var(--color-accent)] hover:underline"
        >
          {excerpt.projectDisplay}
        </Link>
        {excerpt.sessionDisplay && (
          <Link
            href={`/projects/${encodeURIComponent(excerpt.project)}/${excerpt.sessionId}`}
            className="text-[var(--color-muted)] hover:text-[var(--color-accent)] truncate max-w-[150px]"
            title={excerpt.sessionDisplay}
          >
            {excerpt.sessionDisplay}
          </Link>
        )}
        {excerpt.model && (
          <span className="px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-muted)] text-xs">
            {excerpt.model.replace('claude-', '').replace(/-\d{8}$/, '')}
          </span>
        )}
        <span className="text-[var(--color-muted)] text-xs" title={formatTimestamp(excerpt.timestamp)}>
          {formatRelativeTime(excerpt.timestamp)}
        </span>
        <span className="text-[var(--color-thinking)] text-xs ml-auto">
          {(excerpt.charCount ?? excerpt.thinking?.length ?? 0).toLocaleString()} chars
        </span>
      </div>

      {excerpt.precedingPrompt && (
        <div className="text-sm text-[var(--color-user)] mb-2 italic line-clamp-2">
          &quot;{excerpt.precedingPrompt}&quot;
        </div>
      )}

      <div
        className="border-l-2 border-[var(--color-thinking)] pl-3 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="text-sm text-[var(--color-muted)] whitespace-pre-wrap font-mono max-h-96 overflow-auto">
          {searchTerm ? highlightSearch(thinkingPreview ?? '', searchTerm) : thinkingPreview}
        </div>
        {isTruncated && (
          <button className="text-xs text-[var(--color-accent)] mt-1 hover:underline">
            Show full ({excerpt.thinking.length.toLocaleString()} chars)
          </button>
        )}
      </div>
    </div>
  );
}

function highlightSearch(text: string, term: string): React.ReactNode {
  if (!term) return text;
  const lower = text.toLowerCase();
  const termLower = term.toLowerCase();
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let idx = lower.indexOf(termLower);
  let key = 0;
  while (idx !== -1 && key < 50) {
    if (idx > lastIdx) parts.push(text.slice(lastIdx, idx));
    parts.push(
      <span key={key++} className="bg-yellow-400/30 text-yellow-200">
        {text.slice(idx, idx + term.length)}
      </span>
    );
    lastIdx = idx + term.length;
    idx = lower.indexOf(termLower, lastIdx);
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return <>{parts}</>;
}
