'use client';

import useSWR from 'swr';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function fmtNum(n: number | null): string {
  if (n === null) return '—';
  return n.toLocaleString();
}

function fmtBytes(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function pct(part: number, total: number): string {
  if (!total) return '0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

function SizeBar({ bytes, total, color = '#a78bfa' }: { bytes: number | null; total: number; color?: string }) {
  if (!bytes || !total) return null;
  const w = Math.max(1, (bytes / total) * 100);
  return (
    <div className="mt-1 h-1 rounded bg-[var(--color-border)] overflow-hidden">
      <div className="h-full rounded" style={{ width: `${w}%`, background: color }} />
    </div>
  );
}

export default function DbPage() {
  const { data, error, mutate } = useSWR('/api/db/meta', fetcher, { refreshInterval: 0 });

  if (error) return <div className="text-[var(--color-error)]">Failed to load: {String(error)}</div>;
  if (!data) return <div className="text-[var(--color-muted)]">Loading database metadata...</div>;

  const {
    pageSize, pageCount, freelistCount, cacheSize, journalMode, walCheckpoint,
    totalBytes, freeBytes,
    totalBytesHuman, usedBytesHuman, freeBytesHuman, fileSizeHuman,
    tables = [], indexes = [],
  } = data;

  const totalTableBytes = tables.reduce((s: number, t: any) => s + (t.totalBytes ?? 0), 0);
  const totalIndexBytes = indexes.reduce((s: number, i: any) => s + (i.totalBytes ?? 0), 0);
  const totalRows = tables.reduce((s: number, t: any) => s + (t.rowCount ?? 0), 0);

  return (
    <div className="space-y-6">
      <PageContext
        pageType="database-meta"
        summary={`SQLite database metadata. ${fileSizeHuman ?? totalBytesHuman} on disk, ${fmtNum(pageCount)} pages × ${fmtBytes(pageSize)}. ${tables.length} tables, ${indexes.length} indexes, ${fmtNum(totalRows)} total rows. Journal mode: ${journalMode}.`}
        metrics={{
          file_size: fileSizeHuman ?? totalBytesHuman,
          page_size: fmtBytes(pageSize),
          page_count: fmtNum(pageCount),
          free_pages: fmtNum(freelistCount),
          journal_mode: journalMode,
          tables: tables.length,
          indexes: indexes.length,
          total_rows: fmtNum(totalRows),
        }}
      />

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Database</h2>
        <button
          onClick={() => mutate()}
          className="px-3 py-1 text-base border border-[var(--color-border)] rounded hover:text-[var(--color-foreground)] text-[var(--color-muted)]"
        >
          refresh
        </button>
      </div>

      {/* Overall stats */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <div className="text-base text-[var(--color-muted)]">File size</div>
          <div className="text-2xl font-bold">{fileSizeHuman ?? totalBytesHuman}</div>
          <div className="text-base text-[var(--color-muted)] mt-1">on disk</div>
        </div>
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <div className="text-base text-[var(--color-muted)]">Pages</div>
          <div className="text-2xl font-bold">{fmtNum(pageCount)}</div>
          <div className="text-base text-[var(--color-muted)] mt-1">{fmtBytes(pageSize)} per page · {fmtNum(freelistCount)} free</div>
        </div>
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <div className="text-base text-[var(--color-muted)]">Journal mode</div>
          <div className="text-2xl font-bold uppercase">{journalMode}</div>
          {walCheckpoint && (
            <div className="text-base text-[var(--color-muted)] mt-1">
              WAL: {fmtNum(walCheckpoint.log)} frames · {fmtNum(walCheckpoint.checkpointed)} checkpointed
            </div>
          )}
        </div>
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <div className="text-base text-[var(--color-muted)]">Total rows</div>
          <div className="text-2xl font-bold">{fmtNum(totalRows)}</div>
          <div className="text-base text-[var(--color-muted)] mt-1">across {tables.length} tables</div>
        </div>
      </div>

      {/* Space breakdown bar */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
        <h3 className="text-base font-bold text-[var(--color-muted)]">Space breakdown</h3>
        <div className="grid grid-cols-3 gap-4 text-base">
          <div>
            <span className="text-[var(--color-muted)]">Tables</span>
            <span className="float-right font-bold">{fmtBytes(totalTableBytes)} ({pct(totalTableBytes, totalBytes)})</span>
          </div>
          <div>
            <span className="text-[var(--color-muted)]">Indexes</span>
            <span className="float-right font-bold">{fmtBytes(totalIndexBytes)} ({pct(totalIndexBytes, totalBytes)})</span>
          </div>
          <div>
            <span className="text-[var(--color-muted)]">Free pages</span>
            <span className="float-right font-bold">{freeBytesHuman} ({pct(freeBytes, totalBytes)})</span>
          </div>
        </div>
        <div className="relative h-4 rounded bg-[var(--color-border)] overflow-hidden flex">
          <div style={{ width: pct(totalTableBytes, totalBytes), background: '#a78bfa' }} title={`Tables: ${fmtBytes(totalTableBytes)}`} />
          <div style={{ width: pct(totalIndexBytes, totalBytes), background: '#60a5fa' }} title={`Indexes: ${fmtBytes(totalIndexBytes)}`} />
          <div style={{ width: pct(freeBytes, totalBytes), background: '#374151' }} title={`Free: ${freeBytesHuman}`} />
        </div>
        <div className="flex gap-6 text-base text-[var(--color-muted)]">
          <span><span className="inline-block w-2 h-2 rounded-full bg-[#a78bfa] mr-1" />Tables</span>
          <span><span className="inline-block w-2 h-2 rounded-full bg-[#60a5fa] mr-1" />Indexes</span>
          <span><span className="inline-block w-2 h-2 rounded-full bg-[#374151] mr-1" />Free</span>
        </div>
      </div>

      {/* Tables */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">Tables ({tables.length})</h3>
        <table className="w-full text-base">
          <thead>
            <tr className="text-[var(--color-muted)] text-left border-b border-[var(--color-border)]">
              <th className="pb-2">Table</th>
              <th className="pb-2 text-right">Rows</th>
              <th className="pb-2 text-right">Pages</th>
              <th className="pb-2 text-right">Payload</th>
              <th className="pb-2 text-right">Total size</th>
              <th className="pb-2 text-right">% of DB</th>
            </tr>
          </thead>
          <tbody>
            {tables.map((t: any) => (
              <tr key={t.name} className="border-b border-[var(--color-border)]">
                <td className="py-2 font-mono text-[var(--color-accent)]">
                  {t.name}
                  <SizeBar bytes={t.totalBytes} total={totalBytes} color="#a78bfa" />
                </td>
                <td className="py-2 text-right">{fmtNum(t.rowCount)}</td>
                <td className="py-2 text-right text-[var(--color-muted)]">{fmtNum(t.pages)}</td>
                <td className="py-2 text-right text-[var(--color-muted)]">{fmtBytes(t.payloadBytes)}</td>
                <td className="py-2 text-right font-bold">{fmtBytes(t.totalBytes)}</td>
                <td className="py-2 text-right text-[var(--color-muted)]">{pct(t.totalBytes ?? 0, totalBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Indexes */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">Indexes ({indexes.length})</h3>
        <table className="w-full text-base">
          <thead>
            <tr className="text-[var(--color-muted)] text-left border-b border-[var(--color-border)]">
              <th className="pb-2">Index</th>
              <th className="pb-2">Table</th>
              <th className="pb-2 text-right">Pages</th>
              <th className="pb-2 text-right">Payload</th>
              <th className="pb-2 text-right">Total size</th>
              <th className="pb-2 text-right">Type</th>
            </tr>
          </thead>
          <tbody>
            {indexes.map((i: any) => (
              <tr key={i.name} className="border-b border-[var(--color-border)]">
                <td className="py-2 font-mono text-[var(--color-accent)]">
                  {i.name}
                  <SizeBar bytes={i.totalBytes} total={totalBytes} color="#60a5fa" />
                </td>
                <td className="py-2 text-[var(--color-muted)]">{i.table}</td>
                <td className="py-2 text-right text-[var(--color-muted)]">{fmtNum(i.pages)}</td>
                <td className="py-2 text-right text-[var(--color-muted)]">{fmtBytes(i.payloadBytes)}</td>
                <td className="py-2 text-right font-bold">{fmtBytes(i.totalBytes)}</td>
                <td className="py-2 text-right">
                  <span className={`text-base px-1.5 py-0.5 rounded ${i.auto ? 'bg-[#374151] text-[var(--color-muted)]' : 'bg-[#1e3a5f] text-blue-300'}`}>
                    {i.auto ? 'auto' : 'explicit'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pragma summary */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">PRAGMA</h3>
        <div className="grid grid-cols-3 gap-x-8 gap-y-1 text-base font-mono">
          {[
            ['page_size', fmtBytes(pageSize)],
            ['page_count', fmtNum(pageCount)],
            ['freelist_count', fmtNum(freelistCount)],
            ['cache_size', cacheSize < 0 ? `${fmtBytes(Math.abs(cacheSize) * 1024)} (kibibytes mode)` : fmtNum(cacheSize)],
            ['journal_mode', journalMode],
            ['used / total', `${usedBytesHuman} / ${totalBytesHuman}`],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-[var(--color-border)] py-1">
              <span className="text-[var(--color-muted)]">{k}</span>
              <span>{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
