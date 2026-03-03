'use client';

import { useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import type { SessionEntry } from '@/lib/types';
import { formatTimestamp, truncate } from '@/lib/format';
import { decodeProjectName } from '@/lib/claude-paths-client';
import { PageContext } from '@/components/PageContext';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function AllLogsPage() {
  const [limit, setLimit] = useState(100);
  const [typeFilter, setTypeFilter] = useState('user,assistant,system');

  const { data, error, isLoading } = useSWR<
    (SessionEntry & { _project: string })[]
  >(`/api/logs?limit=${limit}&types=${typeFilter}`, fetcher);

  return (
    <div className="space-y-4">
      <PageContext
        pageType="logs"
        summary={`All logs view. ${data ? `${data.length} entries` : 'Loading...'}. Filter: ${typeFilter}. Limit: ${limit}.`}
        metrics={{
          entries: data?.length ?? 0,
          type_filter: typeFilter,
          limit,
        }}
      />
      <h2 className="text-lg font-bold">All Logs</h2>

      <div className="flex gap-3 items-center">
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-1.5 text-sm"
        >
          <option value="user,assistant,system">All types</option>
          <option value="user">User only</option>
          <option value="assistant">Assistant only</option>
          <option value="system">System only</option>
        </select>
        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-1.5 text-sm"
        >
          <option value={50}>50 entries</option>
          <option value={100}>100 entries</option>
          <option value={200}>200 entries</option>
        </select>
      </div>

      {error && (
        <div className="text-[var(--color-error)] text-sm">
          Failed to load: {String(error)}
        </div>
      )}

      {isLoading && (
        <div className="text-[var(--color-muted)] text-sm">
          Aggregating logs across sessions...
        </div>
      )}

      {data && (
        <div className="text-xs text-[var(--color-muted)]">
          {data.length} entries from recent sessions
        </div>
      )}

      <div className="space-y-1">
        {data?.map((entry, i) => (
          <LogEntry key={i} entry={entry} />
        ))}
      </div>
    </div>
  );
}

function LogEntry({
  entry,
}: {
  entry: SessionEntry & { _project: string };
}) {
  const [expanded, setExpanded] = useState(false);

  const borderColor =
    entry.type === 'user'
      ? 'var(--color-user)'
      : entry.type === 'assistant'
        ? 'var(--color-assistant)'
        : 'var(--color-border)';

  const typeLabel =
    entry.type === 'user'
      ? 'USR'
      : entry.type === 'assistant'
        ? 'AST'
        : 'SYS';

  const timestamp = 'timestamp' in entry ? String(entry.timestamp ?? '') : '';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = entry as any;
  let preview = '';
  if (e.type === 'user' && e.message) {
    const content = e.message.content;
    if (typeof content === 'string') {
      preview = content;
    } else if (Array.isArray(content)) {
      preview = content
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text?: string }) => b.text ?? '')
        .join(' ');
    }
  } else if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
    preview = e.message.content
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text?: string }) => b.text ?? '')
      .join(' ');
  } else if (e.type === 'system') {
    preview = e.subtype ?? 'system event';
  }

  return (
    <div
      className="border-l-2 pl-3 py-1 hover:bg-[var(--color-surface)] cursor-pointer"
      style={{ borderColor }}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="font-bold w-8" style={{ color: borderColor }}>
          {typeLabel}
        </span>
        <Link
          href={`/projects/${encodeURIComponent(entry._project)}`}
          className="text-[var(--color-accent)] hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {decodeProjectName(entry._project)}
        </Link>
        {timestamp && (
          <span className="text-[var(--color-muted)]">
            {formatTimestamp(timestamp)}
          </span>
        )}
      </div>
      <div className="text-sm mt-0.5">
        {expanded ? (
          <div className="whitespace-pre-wrap break-words">{preview}</div>
        ) : (
          <span className="text-[var(--color-muted)]">
            {truncate(preview.replace(/\n/g, ' '), 120)}
          </span>
        )}
      </div>
    </div>
  );
}
