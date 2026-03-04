'use client';

import { useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import type { ThinkingExcerpt } from '@/lib/types';
import { formatTimestamp } from '@/lib/format';
import { decodeProjectName } from '@/lib/claude-paths-client';
import { PageContext } from '@/components/PageContext';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function ThinkingPage() {
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(1000);

  const queryParams = new URLSearchParams({ limit: String(limit) });
  if (search) queryParams.set('search', search);

  const { data, error, isLoading } = useSWR<ThinkingExcerpt[]>(
    `/api/thinking?${queryParams}`,
    fetcher
  );

  return (
    <div className="space-y-4">
      <PageContext
        pageType="thinking"
        summary={`Thinking stream browser. ${data ? `${data.length} thinking blocks found` : 'Loading...'}. Search: "${search || 'none'}". Limit: ${limit}.`}
        metrics={{
          thinking_blocks: data?.length ?? 0,
          search_query: search || 'none',
          limit,
        }}
        details={data?.slice(0, 10).map((t) => `[${decodeProjectName(t.project)}] ${t.thinking}`).join('\n')}
      />
      <h2 className="text-lg font-bold">Thinking Stream</h2>

      <div className="flex gap-3 items-center">
        <input
          type="text"
          placeholder="Search thinking content..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base flex-1 focus:outline-none focus:border-[var(--color-thinking)]"
        />
        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base"
        >
          <option value={1000}>1,000</option>
          <option value={10000}>10,000</option>
        </select>
      </div>

      {error && (
        <div className="text-[var(--color-error)] text-base">
          Failed to load: {String(error)}
        </div>
      )}

      {isLoading && (
        <div className="text-[var(--color-muted)] text-base">
          Scanning sessions for thinking blocks...
        </div>
      )}

      {data && (
        <div className="text-base text-[var(--color-muted)]">
          {data.length} thinking blocks found
        </div>
      )}

      <div className="space-y-3">
        {data?.map((excerpt, i) => (
          <ThinkingCard key={`${excerpt.sessionId}-${i}`} excerpt={excerpt} />
        ))}
      </div>
    </div>
  );
}

function ThinkingCard({ excerpt }: { excerpt: ThinkingExcerpt }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-4">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <Link
          href={`/projects/${encodeURIComponent(excerpt.project)}/${excerpt.sessionId}`}
          className="text-base text-[var(--color-accent)] hover:underline"
        >
          {decodeProjectName(excerpt.project)}
        </Link>
        {excerpt.model && (
          <span className="text-base px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-muted)]">
            {excerpt.model.replace('claude-', '').replace(/-\d{8}$/, '')}
          </span>
        )}
        <span className="text-base text-[var(--color-muted)]">
          {formatTimestamp(excerpt.timestamp)}
        </span>
      </div>

      {excerpt.precedingPrompt && (
        <div className="text-base text-[var(--color-user)] mb-2 italic">
          &quot;{excerpt.precedingPrompt}&quot;
        </div>
      )}

      <div className="border-l-2 border-[var(--color-thinking)] pl-3">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-base text-[var(--color-thinking)] hover:underline cursor-pointer mb-1"
        >
          {expanded ? 'collapse' : 'expand'} ({excerpt.thinking.length.toLocaleString()} chars)
        </button>
        <div className="text-base text-[var(--color-muted)] whitespace-pre-wrap font-mono max-h-96 overflow-auto">
          {expanded
            ? excerpt.thinking
            : excerpt.thinking}
        </div>
      </div>
    </div>
  );
}
