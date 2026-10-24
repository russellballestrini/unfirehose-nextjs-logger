'use client';

import { fetcher } from '@unturf/unfirehose-ui/fetcher';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import { EmptyState } from '@unturf/unfirehose-ui/EmptyState';
import { TimeRangeSelect, useTimeRange, getTimeRangeFrom } from '@unturf/unfirehose-ui/TimeRangeSelect';
import { useStickyState } from '@unturf/unfirehose-ui/useStickyState';
import { formatRelativeTime } from '@unturf/unfirehose/format';

/**
 * Actions: what our agents did on this machine.
 *
 * Every tool call that read or wrote a file, ran git, or reached the
 * network, newest first, with the ones worth a second look — destructive
 * commands, force pushes, credentials, sudo, curl | sh — highlighted. Each
 * row links to its session at that tool call.
 *
 * `?project=` and `?session=` deep-link a filter (the project page links
 * here); the rest are sticky so a person's usual view survives a reload.
 */

interface Row {
  id: number;
  timestamp: string;
  kind: string;
  tool: string;
  harness: string | null;
  paths: string[];
  command: string | null;
  flags: string[];
  reasons: string;
  projectName: string | null;
  projectDisplayName: string | null;
  sessionUuid: string | null;
  toolUseId: string | null;
}

interface Page {
  rows: Row[];
  nextCursor: string | null;
  total: number;
  kinds: Record<string, number>;
  flags: Record<string, number>;
  flaggedRows: number;
  status: { rows: number; backfillRemaining: number; headLag: number; rulesVersion: number };
}

const KINDS: Array<[string, string]> = [
  ['fs-read', 'read a file'],
  ['fs-write', 'wrote, moved or deleted a file'],
  ['git', 'ran git'],
  ['network', 'reached the network'],
  ['shell', 'ran some other command'],
];

const FLAG_HELP: Record<string, string> = {
  destructive: 'throws away work or damages the machine: rm -r of home or system paths, git reset --hard, git clean -f, dd onto a device, DROP TABLE',
  'force-push': 'git push --force overwrote a remote branch',
  'force-with-lease': 'git push --force-with-lease: a force push that checks the remote first',
  'secrets-in-diff': 'wrote a credential into a file',
  'secret-in-command': 'carried a credential on a command line, or sent one to a network or MCP tool',
  sudo: 'ran as root',
  'curl-pipe-shell': 'piped a download straight into a shell',
  'secret-in-output': 'its output held a credential, which then went to the model with the rest of the session',
};

const KIND_COLOR: Record<string, string> = {
  'fs-read': 'var(--color-muted)',
  'fs-write': 'var(--color-tool)',
  git: 'var(--color-thinking)',
  network: 'var(--color-user)',
  shell: 'var(--color-foreground)',
};

function sessionHref(r: Row): string | null {
  if (!r.projectName || !r.sessionUuid) return null;
  const anchor = r.toolUseId ? `#tool-${encodeURIComponent(r.toolUseId)}` : '';
  return `/projects/${encodeURIComponent(r.projectName)}/${r.sessionUuid}${anchor}`;
}

function ActionRow({ r }: { r: Row }) {
  const flagged = r.flags.length > 0;
  const href = sessionHref(r);
  const what = r.command ?? r.paths.join('  ');
  return (
    <tr
      data-flagged={flagged ? 'true' : undefined}
      className={`border-b border-[var(--color-border)] align-top ${flagged ? 'bg-[color-mix(in_srgb,var(--color-error)_10%,transparent)]' : ''}`}
      style={flagged ? { boxShadow: 'inset 3px 0 0 var(--color-error)' } : undefined}
    >
      <td className="py-1.5 px-2 whitespace-nowrap text-[var(--color-muted)]" title={r.timestamp}>{formatRelativeTime(r.timestamp)}</td>
      <td className="py-1.5 px-2 whitespace-nowrap">
        <span style={{ color: KIND_COLOR[r.kind] }}>{r.kind}</span>
        <span className="text-[var(--color-muted)]"> · {r.tool}</span>
      </td>
      <td className="py-1.5 px-2 min-w-0">
        <div className="font-mono break-all line-clamp-3" title={what}>{what || '—'}</div>
        {r.command && r.paths.length > 0 && (
          <div className="font-mono text-[var(--color-muted)] break-all line-clamp-1" title={r.paths.join('\n')}>{r.paths.join('  ')}</div>
        )}
        {flagged && (
          <div className="grid grid-flow-col auto-cols-max gap-1.5 mt-1">
            {r.flags.map((f) => (
              <span key={f} title={FLAG_HELP[f]} className="px-1.5 rounded border border-[var(--color-error)] text-[var(--color-error)]">{f}</span>
            ))}
          </div>
        )}
        {flagged && r.reasons && <div className="text-[var(--color-muted)] mt-0.5">{r.reasons}</div>}
      </td>
      <td className="py-1.5 px-2 whitespace-nowrap">
        {r.projectName ? (
          <Link href={`/projects/${encodeURIComponent(r.projectName)}`} className="hover:text-[var(--color-accent)]">
            {r.projectDisplayName ?? r.projectName}
          </Link>
        ) : <span className="text-[var(--color-muted)]">—</span>}
        {r.harness && <div className="text-[var(--color-muted)]">{r.harness}</div>}
      </td>
      <td className="py-1.5 px-2 whitespace-nowrap">
        {href ? <Link href={href} className="text-[var(--color-accent)] hover:underline">session →</Link> : null}
      </td>
    </tr>
  );
}

export default function ActionsPage() {
  const [range, setRange] = useTimeRange('actions_range', '7d');
  const [kind, setKind] = useStickyState<string>('actions_kind', '');
  const [flag, setFlag] = useStickyState<string>('actions_flag', '');
  const [path, setPath] = useState('');
  const [command, setCommand] = useState('');
  const [harness, setHarness] = useState('');
  const [project, setProject] = useState('');
  const [session, setSession] = useState('');
  // Pages walked under one filter; a different filter starts at the newest again.
  const [paging, setPaging] = useState<{ key: string; cursors: string[] }>({ key: '', cursors: [] });

  // Deep links: ?project=, ?session=, ?flag=, ?kind= win over sticky values.
  /* eslint-disable react-hooks/set-state-in-effect -- sync from the URL on mount */
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('project')) setProject(sp.get('project')!);
    if (sp.get('session')) setSession(sp.get('session')!);
    if (sp.get('flag') !== null) setFlag(sp.get('flag')!);
    if (sp.get('kind') !== null) setKind(sp.get('kind')!);
  }, [setFlag, setKind]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const params = new URLSearchParams();
  // To the minute, so our request key holds still between renders.
  const fromRaw = getTimeRangeFrom(range);
  const from = fromRaw ? new Date(Math.floor(Date.parse(fromRaw) / 60_000) * 60_000).toISOString() : undefined;
  if (from) params.set('from', from);
  if (kind) params.set('kind', kind);
  if (flag) params.set('flag', flag);
  if (path.trim()) params.set('path', path.trim());
  if (command.trim()) params.set('command', command.trim());
  if (harness.trim()) params.set('harness', harness.trim());
  if (project) params.set('project', project);
  if (session) params.set('session', session);
  const filterKey = [range, kind, flag, path, command, harness, project, session].join('\u0000');
  const cursors = paging.key === filterKey ? paging.cursors : [];
  const setCursors = (next: (c: string[]) => string[]) => setPaging({ key: filterKey, cursors: next(cursors) });
  const cursor = cursors[cursors.length - 1];
  const pageParams = new URLSearchParams(params);
  pageParams.set('limit', '100');
  if (cursor) pageParams.set('cursor', cursor);

  const { data, error, isLoading } = useSWR<Page>(`/api/actions?${pageParams}`, fetcher, {
    refreshInterval: cursor ? 0 : 30_000,
    keepPreviousData: true,
  });

  const rows = data?.rows ?? [];
  const status = data?.status;
  const filtered = Boolean(kind || flag || path.trim() || command.trim() || harness.trim() || project || session || range !== 'all');
  const clearFilters = () => {
    setKind(''); setFlag(''); setPath(''); setCommand(''); setHarness(''); setProject(''); setSession(''); setRange('all');
  };
  const input = 'text-base bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1';

  return (
    <div className="space-y-5">
      <PageContext
        pageType="actions"
        summary={`Agent actions: ${data?.total ?? 0} tool call(s) that touched files, git or the network`
          + `${flag ? ` flagged ${flag}` : ''}${kind ? ` of kind ${kind}` : ''} over ${range === 'all' ? 'lifetime' : range}.`}
        metrics={{ total: data?.total ?? 0, range, kind, flag, ledger_rows: status?.rows ?? 0 }}
        details={rows.slice(0, 20).map((r) => `${r.timestamp} ${r.kind} ${r.tool} ${r.flags.join(',')} ${r.command ?? r.paths.join(' ')}`).join('\n')}
      />

      <div className="grid gap-1">
        <h1 className="text-2xl font-bold">Actions</h1>
        <p className="text-[var(--color-muted)]">
          Every tool call our agents made that read or wrote a file, ran git, or reached the network. Flagged rows threw away work,
          force-pushed, handled a credential, ran as root, or piped a download into a shell.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[auto_auto_auto_1fr_1fr_auto] gap-2 items-center">
        <TimeRangeSelect value={range} onChange={setRange} />
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} className={input}>
          <option value="">every kind</option>
          {KINDS.map(([k, help]) => <option key={k} value={k} title={help}>{k}</option>)}
        </select>
        <select aria-label="Flag" value={flag} onChange={(e) => setFlag(e.target.value)} className={input} title={FLAG_HELP[flag] ?? 'Every action, flagged or not.'}>
          <option value="">flagged or not</option>
          <option value="any">flagged only</option>
          {Object.keys(FLAG_HELP).map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <input aria-label="Path" placeholder="path, URL or host contains…" value={path} onChange={(e) => setPath(e.target.value)} className={input} />
        <input aria-label="Command" placeholder="command contains…" value={command} onChange={(e) => setCommand(e.target.value)} className={input} />
        <input aria-label="Harness" placeholder="harness" value={harness} onChange={(e) => setHarness(e.target.value)} className={`${input} md:w-36`} />
      </div>

      {(project || session) && (
        <div className="grid grid-flow-col auto-cols-max gap-3 items-center">
          {project && <span>project <span className="font-mono">{project}</span></span>}
          {session && <span>session <span className="font-mono">{session}</span></span>}
          <button type="button" onClick={() => { setProject(''); setSession(''); }} className="cursor-pointer text-[var(--color-accent)] hover:underline">
            every project
          </button>
        </div>
      )}

      <div className="grid grid-flow-col auto-cols-max gap-2 overflow-x-auto">
        {KINDS.map(([k, help]) => (
          <button
            key={k}
            type="button"
            title={help}
            onClick={() => setKind(kind === k ? '' : k)}
            className={`cursor-pointer px-2 py-0.5 rounded border ${kind === k ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}
          >
            <span style={{ color: KIND_COLOR[k] }}>{k}</span> {data?.kinds?.[k] ?? 0}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setFlag(flag === 'any' ? '' : 'any')}
          className={`cursor-pointer px-2 py-0.5 rounded border ${flag === 'any' ? 'border-[var(--color-error)]' : 'border-[var(--color-border)]'} text-[var(--color-error)]`}
          title="Rows with any flag"
        >
          flagged {data?.flaggedRows ?? 0}
        </button>
        <a href={`/api/actions?${params}&format=csv`} className="px-2 py-0.5 text-[var(--color-accent)] hover:underline">CSV</a>
      </div>

      {status && status.backfillRemaining > 0 && (
        <p className="text-[var(--color-muted)]">
          Our worker is still classifying older history ({status.backfillRemaining.toLocaleString()} block ids to go); older actions fill in newest first.
        </p>
      )}

      {error && !data && (
        <EmptyState
          what="Our action ledger could not be read."
          action="The API did not answer; check that our web app can open the database, then reload."
        />
      )}

      {!error && !isLoading && rows.length === 0 && (status?.rows ?? 0) === 0 && (
        <EmptyState
          what="Every file read, write, git command and network call an agent makes will appear here, with risky ones flagged."
          action={status && status.backfillRemaining > 0
            ? 'Our worker is classifying the tool calls already ingested; this fills in within minutes.'
            : 'Run a harness such as Claude Code in a project; its tool calls land here within a minute of ingest.'}
          command={status && status.backfillRemaining > 0 ? undefined : 'make dev'}
          link={{ href: '/live', label: 'Watch our live feed' }}
        />
      )}

      {!error && !isLoading && rows.length === 0 && (status?.rows ?? 0) > 0 && (
        <EmptyState
          kind="quiet"
          range={range}
          what="No action matches these filters."
          action={filtered ? 'Our ledger holds actions outside this view; clear our filters to see every one.' : undefined}
          onWiden={clearFilters}
          widenLabel="Clear filters"
        />
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="text-[var(--color-muted)]">
              <tr className="border-b border-[var(--color-border)]">
                <th className="py-1.5 px-2 font-normal">when</th>
                <th className="py-1.5 px-2 font-normal">what</th>
                <th className="py-1.5 px-2 font-normal">command or path</th>
                <th className="py-1.5 px-2 font-normal">project</th>
                <th className="py-1.5 px-2 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => <ActionRow key={r.id} r={r} />)}
            </tbody>
          </table>
        </div>
      )}

      {(cursors.length > 0 || data?.nextCursor) && (
        <div className="grid grid-flow-col auto-cols-max gap-3 items-center">
          <button
            type="button"
            disabled={cursors.length === 0}
            onClick={() => setCursors((c) => c.slice(0, -1))}
            className="cursor-pointer disabled:cursor-default disabled:opacity-40 px-2 py-0.5 rounded border border-[var(--color-border)]"
          >
            ← newer
          </button>
          <span className="text-[var(--color-muted)]">{(data?.total ?? 0).toLocaleString()} action(s)</span>
          <button
            type="button"
            disabled={!data?.nextCursor}
            onClick={() => data?.nextCursor && setCursors((c) => [...c, data.nextCursor!])}
            className="cursor-pointer disabled:cursor-default disabled:opacity-40 px-2 py-0.5 rounded border border-[var(--color-border)]"
          >
            older →
          </button>
        </div>
      )}
    </div>
  );
}
