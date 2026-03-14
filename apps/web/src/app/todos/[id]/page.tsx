'use client';

import { use, useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { formatRelativeTime, formatTimestamp } from '@unturf/unfirehose/format';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then(r => r.json());

type Tab = 'overview' | 'deployments' | 'session' | 'attachments';

export default function TodoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: todo, error, mutate } = useSWR(`/api/todos/${id}`, fetcher, { refreshInterval: 10000 });
  const [tab, setTab] = useState<Tab>('overview');
  const [copied, setCopied] = useState<string | false>(false);

  const copy = (label: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(false), 420);
  };

  if (error) return <div className="p-8 text-[var(--color-error)]">Failed to load todo</div>;
  if (!todo) return <div className="p-8 text-[var(--color-muted)]">Loading...</div>;
  if (todo.error) return <div className="p-8 text-[var(--color-error)]">{todo.error}</div>;

  const statusColor = todo.status === 'pending' ? '#fbbf24' : todo.status === 'in_progress' ? '#60a5fa' : todo.status === 'completed' ? '#22c55e' : '#ef4444';

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'deployments', label: 'Deployments', count: todo.deployments?.length },
    { id: 'session', label: 'Session' },
    { id: 'attachments', label: 'Attachments', count: todo.attachments?.length },
  ];

  return (
    <div className="space-y-4 max-w-4xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
        <Link href="/todos" className="hover:text-[var(--color-foreground)]">&larr; Todos</Link>
        <span>/</span>
        <Link href={`/projects/${encodeURIComponent(todo.project.name)}`} className="hover:text-[var(--color-accent)]">{todo.project.display}</Link>
        <span>/</span>
        <span>#{todo.id}</span>
      </div>

      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <span className={`w-3 h-3 rounded-full shrink-0 ${todo.status === 'in_progress' ? 'animate-pulse' : ''}`} style={{ backgroundColor: statusColor }} />
          <span className="text-xs font-bold uppercase" style={{ color: statusColor }}>{todo.status.replace('_', ' ')}</span>
          <button onClick={() => copy('id', `#${todo.id}`)} className="font-mono text-sm text-[var(--color-muted)] hover:text-[var(--color-accent)] cursor-pointer"
            title={`#${todo.id}`}>{copied === 'id' ? 'copied' : `#${todo.id}`}</button>
          {todo.uuid && <button onClick={() => copy('uuid', todo.uuid)} className="font-mono text-sm opacity-50 hover:opacity-100 hover:text-[var(--color-accent)] cursor-pointer"
            title={todo.uuid}>{copied === 'uuid' ? 'copied' : todo.uuid.slice(-8)}</button>}
          {todo.source && <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-muted)]">{todo.source}</span>}
          {todo.estimatedMinutes !== null && <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-muted)]">~{todo.estimatedMinutes}m</span>}
        </div>
        <h1 className="text-lg">{todo.content}</h1>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-0.5 border-b border-[var(--color-border)]">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm rounded-t border-b-2 transition-colors cursor-pointer ${
              tab === t.id ? 'border-[var(--color-accent)] text-[var(--color-foreground)] font-bold' : 'border-transparent text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
            }`}>
            {t.label}
            {t.count !== undefined && t.count > 0 && <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded-full bg-[var(--color-surface-hover)]">{t.count}</span>}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'overview' && <OverviewTab todo={todo} copy={copy} copied={copied} mutate={mutate} />}
      {tab === 'deployments' && <DeploymentsTab todo={todo} />}
      {tab === 'session' && <SessionTab todo={todo} copy={copy} copied={copied} />}
      {tab === 'attachments' && <AttachmentsTab todo={todo} />}
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 py-2 border-b border-[var(--color-border)]/50">
      <span className="text-xs text-[var(--color-muted)] w-28 shrink-0 uppercase tracking-wide pt-0.5">{label}</span>
      <div className="text-sm flex-1">{children}</div>
    </div>
  );
}

function OverviewTab({ todo, copy, copied, mutate }: { todo: any; copy: (l: string, t: string) => void; copied: string | false; mutate: () => void }) {
  const [statusChanging, setStatusChanging] = useState(false);

  const changeStatus = async (status: string) => {
    setStatusChanging(true);
    await fetch('/api/todos', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: todo.id, status }),
    });
    mutate();
    setStatusChanging(false);
  };

  return (
    <div className="space-y-1">
      <MetaRow label="ID">
        <button onClick={() => copy('id2', `#${todo.id}`)} className="font-mono hover:text-[var(--color-accent)] cursor-pointer">
          {copied === 'id2' ? 'copied' : `#${todo.id}`}
        </button>
      </MetaRow>
      <MetaRow label="UUID">
        {todo.uuid ? (
          <button onClick={() => copy('uuid2', todo.uuid)} className="font-mono hover:text-[var(--color-accent)] cursor-pointer">
            {copied === 'uuid2' ? 'copied' : todo.uuid}
          </button>
        ) : <span className="text-[var(--color-muted)]">none</span>}
      </MetaRow>
      <MetaRow label="Status">
        <div className="flex items-center gap-2">
          <span className="font-bold" style={{ color: todo.status === 'pending' ? '#fbbf24' : todo.status === 'in_progress' ? '#60a5fa' : '#22c55e' }}>
            {todo.status.replace('_', ' ')}
          </span>
          <div className="flex gap-1 ml-2">
            {['pending', 'in_progress', 'completed', 'obsolete'].filter(s => s !== todo.status).map(s => (
              <button key={s} onClick={() => changeStatus(s)} disabled={statusChanging}
                className="text-xs px-2 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] cursor-pointer disabled:opacity-50">
                {s.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>
      </MetaRow>
      <MetaRow label="Project">
        <Link href={`/projects/${encodeURIComponent(todo.project.name)}`} className="text-[var(--color-accent)] hover:underline">
          {todo.project.display}
        </Link>
        {todo.project.path && <span className="ml-2 text-xs font-mono text-[var(--color-muted)]">{todo.project.path}</span>}
      </MetaRow>
      <MetaRow label="Source">{todo.source}</MetaRow>
      {todo.externalId && <MetaRow label="External ID"><span className="font-mono">{todo.externalId}</span></MetaRow>}
      {todo.estimatedMinutes !== null && <MetaRow label="Estimate">~{todo.estimatedMinutes} minutes</MetaRow>}
      <MetaRow label="Created">
        <span title={formatTimestamp(todo.createdAt)}>{formatTimestamp(todo.createdAt)}</span>
        <span className="ml-2 text-[var(--color-muted)]">({formatRelativeTime(todo.createdAt)})</span>
      </MetaRow>
      <MetaRow label="Updated">
        <span title={formatTimestamp(todo.updatedAt)}>{formatTimestamp(todo.updatedAt)}</span>
        <span className="ml-2 text-[var(--color-muted)]">({formatRelativeTime(todo.updatedAt)})</span>
      </MetaRow>
      {todo.completedAt && (
        <MetaRow label="Completed">
          <span>{formatTimestamp(todo.completedAt)}</span>
          <span className="ml-2 text-[var(--color-muted)]">({formatRelativeTime(todo.completedAt)})</span>
        </MetaRow>
      )}
      {todo.blockedBy.length > 0 && (
        <MetaRow label="Blocked By">
          <div className="flex gap-2 flex-wrap">
            {todo.blockedByTodos.map((b: any) => (
              <Link key={b.id} href={`/todos/${b.id}`} className="text-xs font-mono text-[var(--color-accent)] hover:underline">
                #{b.id} {b.content?.slice(0, 40)}
              </Link>
            ))}
          </div>
        </MetaRow>
      )}
      {todo.activeForm && <MetaRow label="Active Form"><span className="font-mono text-xs">{todo.activeForm}</span></MetaRow>}
    </div>
  );
}

function DeploymentsTab({ todo }: { todo: any }) {
  if (!todo.deployments?.length) {
    return <p className="text-sm text-[var(--color-muted)] py-8 text-center">No deployments for this todo.</p>;
  }

  return (
    <div className="space-y-3">
      {todo.deployments.map((d: any) => (
        <div key={d.id} className="border border-[var(--color-border)] rounded-lg p-4">
          <div className="flex items-center gap-3">
            <span className={`w-2 h-2 rounded-full ${d.status === 'running' ? 'bg-blue-400 animate-pulse' : d.status === 'completed' ? 'bg-green-400' : 'bg-red-400'}`} />
            <span className={`text-sm font-bold ${d.status === 'running' ? 'text-blue-400' : d.status === 'completed' ? 'text-green-400' : 'text-red-400'}`}>
              {d.status.toUpperCase()}
            </span>
            <Link href={`/tmux/${encodeURIComponent(d.tmuxSession)}${d.tmuxWindow ? `?window=${encodeURIComponent(d.tmuxWindow)}` : ''}`}
              className="font-mono text-sm text-[var(--color-accent)] hover:underline">
              {d.tmuxSession}{d.tmuxWindow ? `:${d.tmuxWindow}` : ''}
            </Link>
            <span className="ml-auto text-xs text-[var(--color-muted)]">
              {d.startedAt && formatTimestamp(d.startedAt)}
              {d.startedAt && <span className="ml-1">({formatRelativeTime(d.startedAt)})</span>}
            </span>
          </div>
          {d.stoppedAt && (
            <div className="mt-2 text-xs text-[var(--color-muted)]">
              Stopped: {formatTimestamp(d.stoppedAt)} ({formatRelativeTime(d.stoppedAt)})
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function SessionTab({ todo, copy, copied }: { todo: any; copy: (l: string, t: string) => void; copied: string | false }) {
  if (!todo.session) {
    return <p className="text-sm text-[var(--color-muted)] py-8 text-center">No session linked to this todo.</p>;
  }

  return (
    <div className="space-y-1">
      <MetaRow label="Session UUID">
        <button onClick={() => copy('session', todo.session.uuid)} className="font-mono hover:text-[var(--color-accent)] cursor-pointer">
          {copied === 'session' ? 'copied' : todo.session.uuid}
        </button>
      </MetaRow>
      {todo.session.display && <MetaRow label="Display Name">{todo.session.display}</MetaRow>}
      {todo.session.gitBranch && <MetaRow label="Git Branch"><span className="font-mono">{todo.session.gitBranch}</span></MetaRow>}
      {todo.session.firstPrompt && <MetaRow label="First Prompt">{todo.session.firstPrompt}</MetaRow>}
      <MetaRow label="View">
        <Link href={`/projects/${encodeURIComponent(todo.project.name)}/${todo.session.uuid}`}
          className="text-[var(--color-accent)] hover:underline">
          Open session &rarr;
        </Link>
      </MetaRow>
      {todo.sessionTokens && (
        <>
          <MetaRow label="Messages">{todo.sessionTokens.messageCount.toLocaleString()}</MetaRow>
          <MetaRow label="Input Tokens">{todo.sessionTokens.input.toLocaleString()}</MetaRow>
          <MetaRow label="Output Tokens">{todo.sessionTokens.output.toLocaleString()}</MetaRow>
          <MetaRow label="Cache Read">{todo.sessionTokens.cacheRead.toLocaleString()}</MetaRow>
          <MetaRow label="Cache Write">{todo.sessionTokens.cacheWrite.toLocaleString()}</MetaRow>
        </>
      )}
    </div>
  );
}

function AttachmentsTab({ todo }: { todo: any }) {
  if (!todo.attachments?.length) {
    return <p className="text-sm text-[var(--color-muted)] py-8 text-center">No attachments.</p>;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {todo.attachments.map((a: any) => (
        <a key={a.id} href={`/api/todos/attachments/${a.hash}`} target="_blank" rel="noopener"
          className="border border-[var(--color-border)] rounded-lg p-4 hover:border-[var(--color-accent)]/50 transition-colors">
          <div className="flex items-center gap-3">
            {a.mimeType.startsWith('image/') ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/todos/attachments/${a.hash}`} alt={a.filename} className="w-12 h-12 rounded object-cover" />
            ) : (
              <span className="text-2xl">📎</span>
            )}
            <div>
              <p className="text-sm font-medium">{a.filename}</p>
              <p className="text-xs text-[var(--color-muted)]">{a.mimeType} &middot; {(a.sizeBytes / 1024).toFixed(1)} KB</p>
              <p className="text-xs text-[var(--color-muted)]">{formatRelativeTime(a.createdAt)}</p>
            </div>
          </div>
        </a>
      ))}
    </div>
  );
}
