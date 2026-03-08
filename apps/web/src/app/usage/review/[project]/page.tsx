'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import useSWR from 'swr';
import Link from 'next/link';
import { useVault } from '@unturf/unfirehose-ui/VaultProvider';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function ReviewPage() {
  const params = useParams();
  const router = useRouter();
  const project = params.project as string;
  const { data, error, mutate } = useSWR(
    `/api/projects/${encodeURIComponent(project)}/git`,
    fetcher
  );
  const [commitMsg, setCommitMsg] = useState('');
  const [addAll, setAddAll] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<any>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const vault = useVault();

  const generateMessage = async () => {
    setGenerating(true);
    setGenerateError(null);
    try {
      // Pass decrypted vault API key to server — keys never stored server-side
      const preferred = vault.data?.preferred || '';
      const vaultApiKey = preferred ? vault.getKey(preferred) : '';
      const headers: Record<string, string> = {};
      if (vaultApiKey) headers['x-vault-api-key'] = vaultApiKey;

      const res = await fetch(`/api/projects/${encodeURIComponent(project)}/git/suggest`, {
        method: 'POST',
        headers,
      });
      const result = await res.json();
      if (result.message) {
        setCommitMsg(result.message);
      } else {
        setGenerateError(result.error || 'Failed to generate');
      }
    } catch (err) {
      setGenerateError(String(err));
    }
    setGenerating(false);
  };

  const doCommit = async () => {
    if (!commitMsg.trim()) return;
    setCommitting(true);
    setCommitResult(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project)}/git`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: commitMsg.trim(), addAll }),
      });
      const result = await res.json();
      setCommitResult(result);
      if (result.success) {
        setCommitMsg('');
        mutate();
      }
    } catch (err) {
      setCommitResult({ error: String(err) });
    }
    setCommitting(false);
  };

  const displayName = project.replace(/^-home-fox-git-/, '');

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/usage"
          className="text-[var(--color-muted)] hover:text-[var(--color-foreground)] text-sm"
        >
          &larr; Usage
        </Link>
        <h2 className="text-lg font-bold">Review: {displayName}</h2>
      </div>

      {error && (
        <div className="text-[var(--color-error)] text-sm">
          Failed to load git status: {error.message}
        </div>
      )}

      {data?.error && (
        <div className="text-[var(--color-error)] text-sm bg-red-950/30 rounded p-3">
          {data.error}: {data.detail}
        </div>
      )}

      {data && !data.error && (
        <>
          {/* Branch + status summary */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <div className="flex items-center gap-4 text-sm">
              <span className="font-mono text-[var(--color-accent)]">{data.branch}</span>
              <span className="text-[var(--color-muted)]">{data.repoPath}</span>
              <span className={`ml-auto font-bold ${data.isDirty ? 'text-yellow-400' : 'text-[var(--color-accent)]'}`}>
                {data.isDirty ? `${data.files.length} changed files` : 'Clean'}
              </span>
            </div>
          </div>

          {/* Changed files list */}
          {data.files.length > 0 && (
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
              <h3 className="text-sm font-bold text-[var(--color-muted)] mb-2">Changed Files</h3>
              <div className="space-y-0.5">
                {data.files.map((f: any, i: number) => (
                  <div key={i} className="flex items-center gap-2 text-sm font-mono">
                    <span className={`w-5 text-center text-xs font-bold ${
                      f.status === 'M' ? 'text-yellow-400' :
                      f.status === 'A' || f.status === '?' ? 'text-green-400' :
                      f.status === 'D' ? 'text-red-400' :
                      'text-[var(--color-muted)]'
                    }`}>
                      {f.status === '?' ? 'U' : f.status}
                    </span>
                    <span className="text-[var(--color-foreground)]">{f.file}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Full diff */}
          {data.diff && (
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
              <h3 className="text-sm font-bold text-[var(--color-muted)] mb-2">Diff</h3>
              <pre className="text-xs font-mono overflow-x-auto max-h-[70vh] overflow-y-auto leading-relaxed">
                {data.diff.split('\n').map((line: string, i: number) => (
                  <div
                    key={i}
                    className={
                      line.startsWith('+++') || line.startsWith('---') ? 'text-[var(--color-muted)] font-bold' :
                      line.startsWith('+') ? 'text-green-400 bg-green-500/10' :
                      line.startsWith('-') ? 'text-red-400 bg-red-500/10' :
                      line.startsWith('@@') ? 'text-cyan-400 mt-2' :
                      line.startsWith('diff ') ? 'text-[var(--color-accent)] font-bold mt-4 border-t border-[var(--color-border)] pt-2' :
                      'text-[var(--color-muted)]'
                    }
                  >
                    {line || '\u00A0'}
                  </div>
                ))}
              </pre>
            </div>
          )}

          {/* Commit form — hero action */}
          {data.isDirty && (
            <div className="border-2 border-[var(--color-accent)] rounded-lg p-5 bg-[var(--color-surface)]">
              <div className="relative">
                <textarea
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doCommit(); }
                  }}
                  placeholder="Commit message... (Ctrl+Enter to commit)"
                  rows={3}
                  className="w-full px-3 py-2 pr-24 text-base bg-[var(--color-background)] border border-[var(--color-border)] rounded-lg focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] resize-y font-mono"
                  disabled={committing || generating}
                />
                <button
                  onClick={generateMessage}
                  disabled={generating || committing}
                  className="absolute top-2 right-2 px-3 py-1 text-xs font-bold bg-[var(--color-surface-hover)] text-[var(--color-foreground)] rounded-md hover:bg-[var(--color-border)] transition-colors disabled:opacity-40 cursor-pointer"
                  title="Generate commit message from diff using LLM"
                >
                  {generating ? 'Generating...' : 'Generate'}
                </button>
              </div>
              {generateError && (
                <div className="mt-2 text-xs text-[var(--color-error)]">
                  {generateError}
                  {(generateError.includes('No LLM provider') || generateError.includes('Configure')) && (
                    <> — <Link href="/settings" className="underline">Configure in Settings</Link></>
                  )}
                </div>
              )}
              <div className="flex items-center justify-between mt-3">
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm text-[var(--color-muted)] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={addAll}
                      onChange={(e) => setAddAll(e.target.checked)}
                      className="accent-[var(--color-accent)]"
                    />
                    Include untracked files (git add -A)
                  </label>
                  <span className="text-xs text-[var(--color-muted)]">Ctrl+Enter to commit</span>
                </div>
                <button
                  onClick={doCommit}
                  disabled={committing || !commitMsg.trim()}
                  className="px-6 py-2 text-sm font-bold bg-[var(--color-accent)] text-[var(--color-background)] rounded-lg hover:opacity-90 transition-opacity disabled:opacity-40 cursor-pointer"
                >
                  {committing ? 'Committing...' : 'Commit'}
                </button>
              </div>

              {commitResult && (
                <div className={`mt-3 text-sm rounded-lg p-3 ${
                  commitResult.success
                    ? 'bg-green-500/10 text-green-400 border border-green-500/30'
                    : 'bg-red-500/10 text-red-400 border border-red-500/30'
                }`}>
                  {commitResult.success ? (
                    <div className="space-y-1">
                      <div>Committed: {commitResult.commit}</div>
                      {commitResult.pushed && <div className="text-xs opacity-80">Pushed to remote</div>}
                      {commitResult.pushError && <div className="text-xs text-yellow-400">Push failed: {commitResult.pushError}</div>}
                      {!commitResult.pushed && !commitResult.pushError && (
                        <button
                          onClick={async () => {
                            try {
                              const res = await fetch(`/api/projects/${encodeURIComponent(project)}/git`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ action: 'push' }),
                              });
                              const r = await res.json();
                              setCommitResult({ ...commitResult, pushed: r.success, pushError: r.error });
                            } catch (err) {
                              setCommitResult({ ...commitResult, pushError: String(err) });
                            }
                          }}
                          className="text-xs px-2 py-0.5 rounded bg-green-500/20 hover:bg-green-500/30 transition-colors cursor-pointer font-bold"
                        >
                          Push Now
                        </button>
                      )}
                    </div>
                  ) : (
                    `Error: ${commitResult.error} ${commitResult.detail ?? ''}`
                  )}
                </div>
              )}
            </div>
          )}

          {!data.isDirty && (
            <div className="text-sm text-[var(--color-accent)] text-center py-6 border-2 border-[var(--color-accent)]/30 rounded-lg bg-[var(--color-surface)]">
              Working tree is clean. Nothing to commit.
            </div>
          )}

          {/* Recent commits */}
          {data.recentCommits && (
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
              <h3 className="text-sm font-bold text-[var(--color-muted)] mb-2">Recent Commits</h3>
              <pre className="text-xs font-mono text-[var(--color-muted)]">{data.recentCommits}</pre>
            </div>
          )}
        </>
      )}

      {!data && !error && (
        <div className="text-sm text-[var(--color-muted)] text-center py-8">Loading...</div>
      )}
    </div>
  );
}
