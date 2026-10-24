'use client';

import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { fetcher } from '@unturf/unfirehose-ui/fetcher';
import { formatBytes } from '@unturf/unfirehose/format';
import { human as humanAgo } from '@unturf/unfirehose/ago';

/* eslint-disable @typescript-eslint/no-explicit-any */

const TOP_TABLES = 12;
const card = 'bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3';
const button = 'px-3 py-1.5 text-sm rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] cursor-pointer disabled:opacity-50 disabled:cursor-default';

async function post(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

const signed = (n: number) => `${n < 0 ? '−' : '+'}${formatBytes(Math.abs(n))}`;

/**
 * Settings → Database: how big our database is, what it is made of, how
 * fast it grows, and a retention window for old block text. Reads
 * /api/db/health, which serves our worker's daily size snapshot rather
 * than scanning the file on every visit; /db has every index.
 */
export function DatabaseHealth() {
  const { data: h, error, mutate } = useSWR('/api/db/health', fetcher, { refreshInterval: 60_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [choice, setChoice] = useState<string>('');
  const [estimate, setEstimate] = useState<any>(null);

  if (error) return <p className="text-[var(--color-error)]">Could not read database health: {String(error.message ?? error)}</p>;
  if (!h) return <p className="text-[var(--color-muted)]">Measuring our database…</p>;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setProblem(null);
    try { await fn(); } catch (e) { setProblem((e as Error).message); } finally { setBusy(null); }
  };

  const current: number | null = h.retention?.days ?? null;
  const selected = choice === '' ? (current == null ? 'off' : String(current)) : choice;
  const selectedDays = selected === 'off' ? null : parseInt(selected, 10);
  const changed = selectedDays !== current;
  const estimated = estimate && estimate.days === selectedDays;

  const tables: any[] = h.snapshot?.tables ?? [];
  const total = tables.reduce((s, t) => s + (t.bytes ?? 0) + (t.indexBytes ?? 0), 0);
  const growth: number | null = h.growthPerWeekBytes;
  const weeksLeft = growth && growth > 0 && h.disk ? h.disk.freeBytes / growth : null;
  const diskTone = h.diskLevel === 'critical' ? 'var(--color-error)' : h.diskLevel === 'low' ? 'var(--color-tool)' : undefined;

  return (
    <div className="space-y-6" data-testid="database-health">
      {problem && <p className="text-[var(--color-error)]" role="alert">{problem}</p>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className={card}>
          <h3 className="text-base font-bold text-[var(--color-muted)]">Size</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-[var(--color-muted)]">Database</dt>
            <dd data-field="db">{formatBytes(h.dbBytes)} <span className="text-[var(--color-muted)] font-mono text-xs [overflow-wrap:anywhere]">{h.path}</span></dd>
            <dt className="text-[var(--color-muted)]">Freelist</dt>
            <dd data-field="freelist">{formatBytes(h.freelistBytes)} <span className="text-[var(--color-muted)]">reusable now, back to disk after a VACUUM</span></dd>
            <dt className="text-[var(--color-muted)]">WAL</dt>
            <dd data-field="wal">{formatBytes(h.walBytes)}</dd>
            <dt className="text-[var(--color-muted)]">Growth</dt>
            <dd data-field="growth">
              {growth == null
                ? <span className="text-[var(--color-muted)]">needs two days of snapshots</span>
                : <>{signed(growth)} per week{weeksLeft != null && <span className="text-[var(--color-muted)]">, about {weeksLeft < 104 ? `${Math.round(weeksLeft)} weeks` : `${Math.round(weeksLeft / 52)} years`} of disk at this rate</span>}</>}
            </dd>
            <dt className="text-[var(--color-muted)]">Disk free</dt>
            <dd data-field="disk" style={diskTone ? { color: diskTone } : undefined}>
              {h.disk ? <>{formatBytes(h.disk.freeBytes)} of {formatBytes(h.disk.totalBytes)}</> : 'unknown'}
              {(h.diskLevel === 'low' || h.diskLevel === 'critical') && <> — under {formatBytes(h.lowDiskBytes)}; a retention window below and <code>make vacuum</code> give space back</>}
            </dd>
          </dl>
          <p className="text-sm text-[var(--color-muted)]">
            Our worker runs a VACUUM once a day while ingest is quiet, when at least 256 MB would come back.
            By hand, with our stack stopped: <code className="text-[var(--color-accent)]">make vacuum</code>.
          </p>
        </div>

        <div className={card}>
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-base font-bold text-[var(--color-muted)]">By table</h3>
            <button className={button} disabled={!!busy}
                    onClick={() => run('measure', async () => { await mutate(await post('/api/db/health', { action: 'measure' }), { revalidate: false }); })}>
              {busy === 'measure' ? 'Measuring…' : 'Measure now'}
            </button>
          </div>
          {!h.snapshot ? (
            <p className="text-sm text-[var(--color-muted)]">Our worker measures once a day while ingest is quiet. Measure now reads every page, so it takes a few seconds on a large database.</p>
          ) : (
            <>
              <p className="text-sm text-[var(--color-muted)]">
                Measured {humanAgo(h.snapshot.takenAt)}{h.snapshot.method === 'pages' ? ' (row counts only: this SQLite build has no dbstat)' : ''}. Every index: <Link className="text-[var(--color-accent)] hover:underline" href="/db">/db</Link>.
              </p>
              <table className="w-full text-sm">
                <thead className="text-[var(--color-muted)] text-left">
                  <tr><th className="font-normal">Table</th><th className="font-normal text-right">Rows</th><th className="font-normal text-right">Data</th><th className="font-normal text-right">Indexes</th></tr>
                </thead>
                <tbody>
                  {tables.slice(0, TOP_TABLES).map((t) => {
                    const share = total > 0 ? ((t.bytes ?? 0) + (t.indexBytes ?? 0)) / total : 0;
                    return (
                      <tr key={t.name} data-table={t.name}>
                        <td className="font-mono py-0.5 [overflow-wrap:anywhere]">
                          {t.name}
                          {total > 0 && <div className="h-1 bg-[var(--color-accent)] rounded" style={{ width: `${Math.max(1, share * 100)}%` }} />}
                        </td>
                        <td className="text-right tabular-nums">{t.rows == null ? '—' : Number(t.rows).toLocaleString()}</td>
                        <td className="text-right tabular-nums">{t.bytes == null ? '—' : formatBytes(t.bytes)}</td>
                        <td className="text-right tabular-nums">{t.indexBytes == null ? '—' : formatBytes(t.indexBytes)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {tables.length > TOP_TABLES && <p className="text-xs text-[var(--color-muted)]">and {tables.length - TOP_TABLES} smaller tables</p>}
            </>
          )}
        </div>
      </div>

      <div className={card} data-section="retention">
        <h3 className="text-base font-bold text-[var(--color-muted)]">Retention for block text</h3>
        <p className="text-sm">
          Most of our database is content-block text: prompts, replies, reasoning, tool inputs and results.
          No count reads it. Tokens, costs and message counts live on each message, so they stay exact whatever you choose here.
        </p>
        <p className="text-sm text-[var(--color-muted)]">
          With a window, our worker packs text of blocks older than it into a compressed cold table, a little at a time while ingest is quiet.
          Nothing is deleted: search, reasoning, prompts and every page that shows a block read cold text back byte for byte, a little slower.
          Freed pages go back to disk at our next VACUUM. Keep everything is our default.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm" htmlFor="retention-window">Keep block text hot for</label>
          <select id="retention-window" value={selected} disabled={!!busy}
                  onChange={(e) => { setChoice(e.target.value); setEstimate(null); }}
                  className="bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1 text-sm">
            <option value="off">ever (keep everything)</option>
            {(h.retention?.choices ?? []).map((d: number) => <option key={d} value={String(d)}>{d} days</option>)}
          </select>
          {selectedDays != null && (
            <button className={button} disabled={!!busy}
                    onClick={() => run('estimate', async () => { setEstimate(await post('/api/db/retention', { action: 'estimate', days: selectedDays })); })}>
              {busy === 'estimate' ? 'Estimating…' : 'Estimate'}
            </button>
          )}
          {changed && (selectedDays == null || estimated) && (
            <button className={button} disabled={!!busy}
                    onClick={() => run('set', async () => { await post('/api/db/retention', { action: 'set', days: selectedDays }); setEstimate(null); setChoice(''); await mutate(); })}>
              {selectedDays == null ? 'Keep everything' : `Apply ${selectedDays} days`}
            </button>
          )}
        </div>
        {changed && selectedDays != null && !estimated && (
          <p className="text-sm text-[var(--color-muted)]">Estimate first: a dry run that moves nothing.</p>
        )}
        {estimated && (
          <p className="text-sm" data-field="estimate">
            {estimate.blocks === 0
              ? <>Nothing is older than {estimate.days} days yet.</>
              : <>{Number(estimate.blocks).toLocaleString()} blocks, {formatBytes(estimate.rawBytes)} of text, would pack into about {formatBytes(estimate.estimatedColdBytes)}: roughly <b>{formatBytes(estimate.estimatedSavedBytes)}</b> back after a VACUUM.</>}
          </p>
        )}
        <p className="text-sm text-[var(--color-muted)]" data-field="cold">
          {current == null ? 'Now: keeping everything hot.' : `Now: ${current} days.`}
          {h.cold?.blocks > 0 && <> {Number(h.cold.blocks).toLocaleString()} blocks are cold: {formatBytes(h.cold.rawBytes)} of text in {formatBytes(h.cold.storedBytes)}.</>}
        </p>
        {h.cold?.blocks > 0 && (
          <button className={button} disabled={!!busy}
                  onClick={() => run('thaw', async () => {
                    // In batches, inside the current window's bounds if one is set.
                    for (let i = 0; i < 1000; i++) {
                      const r = await post('/api/db/retention', { action: 'thaw', days: current });
                      if (r.done) break;
                    }
                    await mutate();
                  })}>
            {busy === 'thaw' ? 'Bringing text back…' : current == null ? 'Bring all cold text back hot' : `Bring back text inside ${current} days`}
          </button>
        )}
      </div>
    </div>
  );
}
