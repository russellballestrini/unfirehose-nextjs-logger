'use client';

import { useState, useCallback } from 'react';
import useSWR from 'swr';

const fetcher = (url: string) => fetch(url).then(r => r.json());

interface ApiKey {
  id: string;
  keyPrefix: string;
  label: string | null;
  parentKeyId: string | null;
  scopes: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface AccountInfo {
  tier: number;
}

export default function KeysPage() {
  const { data, error, mutate } = useSWR<{ keys: ApiKey[] }>('/api/keys', fetcher);
  const { data: accountData } = useSWR<AccountInfo>('/api/account', fetcher);
  const [newLabel, setNewLabel] = useState('');
  const [newScopes, setNewScopes] = useState('ingest');
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);

  const [subLabel, setSubLabel] = useState('');
  const [subParentId, setSubParentId] = useState('');
  const [subScopes, setSubScopes] = useState('ingest');
  const [creatingSubKey, setCreatingSubKey] = useState(false);
  const [createdSubKey, setCreatedSubKey] = useState<string | null>(null);

  const isTeam = (accountData?.tier ?? 0) >= 33;

  const createKey = useCallback(async () => {
    setCreating(true);
    setCreatedKey(null);
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: newLabel.trim() || undefined,
          scopes: newScopes,
        }),
      });
      const result = await res.json();
      if (res.ok && result.key) {
        setCreatedKey(result.key);
        setNewLabel('');
        mutate();
      }
    } finally {
      setCreating(false);
    }
  }, [newLabel, newScopes, mutate]);

  const createSubKey = useCallback(async () => {
    if (!subParentId) return;
    setCreatingSubKey(true);
    setCreatedSubKey(null);
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: subLabel.trim() || undefined,
          scopes: subScopes,
          parentKeyId: subParentId,
        }),
      });
      const result = await res.json();
      if (res.ok && result.key) {
        setCreatedSubKey(result.key);
        setSubLabel('');
        mutate();
      }
    } finally {
      setCreatingSubKey(false);
    }
  }, [subLabel, subScopes, subParentId, mutate]);

  const revokeKey = useCallback(async (keyId: string) => {
    const res = await fetch('/api/keys', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyId }),
    });
    if (res.ok) mutate();
  }, [mutate]);

  if (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-bold">API Keys</h1>
        <p className="text-base text-[var(--color-muted)]">
          Key management is only available in cloud mode.
        </p>
      </div>
    );
  }

  const keys = data?.keys ?? [];
  const activeKeys = keys.filter(k => !k.revokedAt);
  const revokedKeys = keys.filter(k => k.revokedAt);

  const activeRootKeys = activeKeys.filter(k => !k.parentKeyId);
  const activeSubKeys = activeKeys.filter(k => k.parentKeyId);
  const subKeysByParent = new Map<string, ApiKey[]>();
  for (const sk of activeSubKeys) {
    const list = subKeysByParent.get(sk.parentKeyId!) ?? [];
    list.push(sk);
    subKeysByParent.set(sk.parentKeyId!, list);
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">API Keys</h1>
        <span className="text-base text-[var(--color-muted)]">
          {activeKeys.length} active
        </span>
      </div>

      {/* Create new key */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
        <h2 className="text-base font-bold">Create new key</h2>
        <div className="flex gap-3 items-end">
          <div className="flex-1">
            <label className="text-base text-[var(--color-muted)] block mb-1">Label</label>
            <input
              type="text"
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              placeholder="e.g. fox-laptop, ci-server"
              className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono"
            />
          </div>
          <div className="w-40">
            <label className="text-base text-[var(--color-muted)] block mb-1">Scopes</label>
            <select
              value={newScopes}
              onChange={e => setNewScopes(e.target.value)}
              className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base"
            >
              <option value="ingest">ingest</option>
              <option value="ingest,read">ingest, read</option>
              <option value="ingest,read,admin">ingest, read, admin</option>
            </select>
          </div>
          <button
            onClick={createKey}
            disabled={creating}
            className="px-4 py-1.5 text-base font-bold rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            {creating ? 'Creating...' : 'Create Key'}
          </button>
        </div>

        {createdKey && (
          <div className="bg-[var(--color-background)] border border-green-600/40 rounded p-3 space-y-2">
            <p className="text-base text-green-400 font-bold">
              Key created — copy it now, it won&apos;t be shown again
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-base font-mono bg-[var(--color-surface)] px-3 py-1.5 rounded select-all break-all">
                {createdKey}
              </code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(createdKey);
                }}
                className="px-3 py-1.5 text-base rounded border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer shrink-0"
              >
                Copy
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Team sub-key creation */}
      {isTeam && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
          <h2 className="text-base font-bold">Team Sub-Keys</h2>
          <p className="text-base text-[var(--color-muted)]">
            Create sub-keys scoped to a root key for team members.
          </p>
          <div className="flex gap-3 items-end flex-wrap">
            <div className="flex-1 min-w-[160px]">
              <label className="text-base text-[var(--color-muted)] block mb-1">Label</label>
              <input
                type="text"
                value={subLabel}
                onChange={e => setSubLabel(e.target.value)}
                placeholder="e.g. alice-laptop"
                className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono"
              />
            </div>
            <div className="w-48">
              <label className="text-base text-[var(--color-muted)] block mb-1">Parent key</label>
              <select
                value={subParentId}
                onChange={e => setSubParentId(e.target.value)}
                className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono"
              >
                <option value="">select root key</option>
                {activeRootKeys.map(k => (
                  <option key={k.id} value={k.id}>
                    {k.keyPrefix}... {k.label ? `(${k.label})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="w-40">
              <label className="text-base text-[var(--color-muted)] block mb-1">Scopes</label>
              <select
                value={subScopes}
                onChange={e => setSubScopes(e.target.value)}
                className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base"
              >
                <option value="ingest">ingest</option>
                <option value="ingest,read">ingest, read</option>
                <option value="ingest,read,admin">ingest, read, admin</option>
              </select>
            </div>
            <button
              onClick={createSubKey}
              disabled={creatingSubKey || !subParentId}
              className="px-4 py-1.5 text-base font-bold rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              {creatingSubKey ? 'Creating...' : 'Create Sub-Key'}
            </button>
          </div>

          {createdSubKey && (
            <div className="bg-[var(--color-background)] border border-green-600/40 rounded p-3 space-y-2">
              <p className="text-base text-green-400 font-bold">
                Sub-key created — copy it now, it won&apos;t be shown again
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-base font-mono bg-[var(--color-surface)] px-3 py-1.5 rounded select-all break-all">
                  {createdSubKey}
                </code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(createdSubKey);
                  }}
                  className="px-3 py-1.5 text-base rounded border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer shrink-0"
                >
                  Copy
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Active keys */}
      <div className="space-y-2">
        <h2 className="text-base font-bold text-[var(--color-muted)]">Active keys</h2>
        {activeKeys.length === 0 ? (
          <p className="text-base text-[var(--color-muted)]">No active keys</p>
        ) : (
          <div className="space-y-1">
            {activeRootKeys.map(k => {
              const children = subKeysByParent.get(k.id) ?? [];
              return (
                <div key={k.id}>
                  <KeyRow apiKey={k} onRevoke={revokeKey} />
                  {children.length > 0 && (
                    <div className="ml-6 mt-1 space-y-1 border-l-2 border-[var(--color-border)] pl-3">
                      {children.map(sk => (
                        <KeyRow key={sk.id} apiKey={sk} onRevoke={revokeKey} isSubKey />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {/* Orphaned sub-keys whose parent was revoked or missing */}
            {activeSubKeys.filter(sk => !activeRootKeys.some(rk => rk.id === sk.parentKeyId)).map(sk => (
              <div key={sk.id} className="ml-6">
                <KeyRow apiKey={sk} onRevoke={revokeKey} isSubKey />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Revoked keys */}
      {revokedKeys.length > 0 && (
        <div className="space-y-2">
          <button
            onClick={() => setShowRevoked(!showRevoked)}
            className="text-base text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors cursor-pointer"
          >
            {showRevoked ? '▾' : '▸'} {revokedKeys.length} revoked key{revokedKeys.length !== 1 ? 's' : ''}
          </button>
          {showRevoked && (
            <div className="space-y-1 opacity-50">
              {revokedKeys.map(k => (
                <KeyRow key={k.id} apiKey={k} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function KeyRow({ apiKey, onRevoke, isSubKey }: { apiKey: ApiKey; onRevoke?: (id: string) => void; isSubKey?: boolean }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] px-4 py-2.5 flex items-center gap-4">
      <code className="text-base font-mono text-[var(--color-accent)] shrink-0">
        {apiKey.keyPrefix}...
      </code>
      <span className="text-base flex-1 truncate">
        {apiKey.label || <span className="text-[var(--color-muted)]">no label</span>}
      </span>
      <span className="text-base text-[var(--color-muted)] shrink-0">
        {apiKey.scopes}
      </span>
      {isSubKey && (
        <span className="text-[10px] uppercase tracking-wider bg-[var(--color-surface-hover)] px-1.5 py-0.5 rounded text-[var(--color-muted)]">
          sub-key
        </span>
      )}
      <span className="text-base text-[var(--color-muted)] shrink-0 w-24 text-right" title={apiKey.lastUsedAt ?? 'never'}>
        {apiKey.lastUsedAt ? timeAgo(apiKey.lastUsedAt) : 'never used'}
      </span>
      {apiKey.revokedAt ? (
        <span className="text-base text-red-400 shrink-0 w-16 text-right">revoked</span>
      ) : onRevoke ? (
        confirming ? (
          <div className="flex gap-1 shrink-0">
            <button
              onClick={() => onRevoke(apiKey.id)}
              className="text-base text-red-400 hover:text-red-300 cursor-pointer"
            >
              confirm
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="text-base text-[var(--color-muted)] hover:text-[var(--color-foreground)] cursor-pointer"
            >
              cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="text-base text-[var(--color-muted)] hover:text-red-400 transition-colors cursor-pointer shrink-0"
          >
            revoke
          </button>
        )
      ) : null}
    </div>
  );
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
