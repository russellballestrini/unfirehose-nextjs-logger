'use client';

import { fetcher } from '@unturf/unfirehose-ui/fetcher';
import { useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SETTINGS_KEYS = {
  unsandboxPublicKey: 'unsandbox_public_key',
  unsandboxSecretKey: 'unsandbox_secret_key',
  unsandboxEnabled: 'unsandbox_enabled',
};

// ============================================================
// Unsandbox Panel
// ============================================================

export function UnsandboxPanel() {
  const router = useRouter();
  const { data: settings, mutate: mutateSettings } = useSWR('/api/settings', fetcher);
  const { data: status, mutate: mutateStatus } = useSWR('/api/unsandbox', fetcher, { refreshInterval: 60000 });
  const [showSecret, setShowSecret] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; tier?: number; error?: string } | null>(null);
  const [booting, setBooting] = useState(false);
  const [bootResult, setBootResult] = useState<any>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootPrompt, setBootPrompt] = useState('');
  const [bootLog, setBootLog] = useState<string[]>([]);

  const publicKey = settings?.[SETTINGS_KEYS.unsandboxPublicKey] ?? '';
  const secretKey = settings?.[SETTINGS_KEYS.unsandboxSecretKey] ?? '';
  const enabled = settings?.[SETTINGS_KEYS.unsandboxEnabled] === 'true';

  const saveSetting = async (key: string, value: string) => {
    mutateSettings((prev: Record<string, string> | undefined) => ({ ...prev, [key]: value }), { revalidate: false });
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set', key, value }) });
    mutateStatus();
  };

  const testConnection = async () => {
    setTesting(true); setTestResult(null);
    try {
      const res = await fetch('/api/unsandbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'test' }) });
      const result = await res.json();
      setTestResult(result);
      if (result.ok) {
        // Success — redirect to unsandbox node page
        setTimeout(() => router.push('/permacomputer/unsandbox'), 400);
      }
    } catch (err) { setTestResult({ ok: false, error: String(err) }); }
    finally { setTesting(false); }
  };

  const bootOnUnsandbox = async () => {
    setBooting(true); setBootResult(null); setBootError(null); setBootLog([]);
    try {
      const res = await fetch('/api/boot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: 'unsandbox', projectPath: '/workspace', harness: 'claude', prompt: bootPrompt.trim() || undefined }),
      });
      const data = await res.json();
      if (res.ok) setBootResult(data); else setBootError(data.error || 'Boot failed');
    } catch (err) { setBootError(String(err)); }
    finally { setBooting(false); }
  };

  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-bold text-[var(--color-muted)]">unsandbox.com</h3>
          <p className="text-base text-[var(--color-muted)] mt-0.5">
            Cloud compute for agent harnesses. Free tier or paid for sessions + semitrust network.
          </p>
        </div>
        <label className="flex items-center gap-2 text-base shrink-0">
          <input type="checkbox" checked={enabled} className="accent-[var(--color-accent)]"
            onChange={(e) => saveSetting(SETTINGS_KEYS.unsandboxEnabled, String(e.target.checked))} />
          <span className={enabled ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'}>
            {enabled ? 'Enabled' : 'Disabled'}
          </span>
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Public Key</label>
          <input type="text" defaultValue={publicKey} placeholder="unsb-pk-xxxx-xxxx-xxxx-xxxx"
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono"
            autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other"
            onBlur={(e) => { if (e.target.value !== publicKey) saveSetting(SETTINGS_KEYS.unsandboxPublicKey, e.target.value.trim()); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        </div>
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Secret Key</label>
          <div className="flex gap-2">
            <input type={showSecret ? 'text' : 'password'} defaultValue={secretKey} placeholder="unsb-sk-xxxx-xxxx-xxxx-xxxx"
              className="flex-1 bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono"
              autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other"
              onBlur={(e) => { if (e.target.value !== secretKey) saveSetting(SETTINGS_KEYS.unsandboxSecretKey, e.target.value.trim()); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
            <button onClick={() => setShowSecret(!showSecret)}
              className="px-2 text-base text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors cursor-pointer">
              {showSecret ? 'hide' : 'show'}
            </button>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        {status?.connected && (
          <Link href="/permacomputer/unsandbox" className="flex items-center gap-3 text-base hover:opacity-80 transition-opacity">
            <span className="text-green-400">● connected</span>
            <span className="text-[var(--color-muted)]">tier {status.tier}</span>
            <span className="text-[var(--color-muted)]">{status.rateLimit} rpm</span>
            <span className="text-[var(--color-muted)]">{status.maxSessions} session{status.maxSessions !== 1 ? 's' : ''}</span>
            {status.network && <span className="text-[var(--color-muted)]">{status.network}</span>}
            <span className="text-[var(--color-accent)] text-xs font-bold">open &rarr;</span>
          </Link>
        )}
        {status && !status.connected && publicKey && (
          <span className="text-base text-red-400">○ {status.error || 'disconnected'}</span>
        )}
        <button onClick={testConnection} disabled={testing || !publicKey || !secretKey}
          className="px-3 py-1 text-base rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:border-[var(--color-muted)] transition-colors disabled:opacity-50 cursor-pointer">
          {testing ? 'testing...' : 'test connection'}
        </button>
        {testResult && (
          <span className={`text-base font-bold ${testResult.ok ? 'text-green-400' : 'text-red-400'}`}>
            {testResult.ok ? `tier ${testResult.tier}` : testResult.error}
          </span>
        )}
      </div>

      {enabled && publicKey && secretKey && (
        <div className="border-t border-[var(--color-border)] pt-3 space-y-3">
          <h4 className="text-base font-bold text-[var(--color-muted)]">Boot on unsandbox</h4>
          <div className="flex gap-2">
            <input type="text" value={bootPrompt} onChange={e => setBootPrompt(e.target.value)}
              placeholder="initial prompt (optional)"
              className="flex-1 bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base"
              onKeyDown={e => { if (e.key === 'Enter') bootOnUnsandbox(); }} />
            <button onClick={bootOnUnsandbox} disabled={booting}
              className="px-4 py-1.5 text-base font-bold rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors disabled:opacity-50 cursor-pointer whitespace-nowrap">
              {booting ? 'Booting...' : 'Boot Claude on unsandbox'}
            </button>
          </div>
          {bootLog.length > 0 && (
            <div className="font-mono text-xs bg-[var(--color-background)] rounded border border-[var(--color-border)] p-2 space-y-0.5 max-h-40 overflow-y-auto">
              {bootLog.map((line, i) => (
                <div key={i} className={line.includes('error') || line.includes('Failed') ? 'text-red-400' : line.includes('complete') || line.includes('ready') || line.includes('installed') || line.includes('running') ? 'text-green-400' : 'text-[var(--color-muted)]'}>{line}</div>
              ))}
            </div>
          )}
          {bootResult && (
            <div className="text-base text-green-400 font-mono">
              session: {bootResult.sessionId}
              {bootResult.domain && <span className="ml-2 text-[var(--color-muted)]">{bootResult.domain}</span>}
            </div>
          )}
          {bootError && <div className="text-base text-red-400">{bootError}</div>}
        </div>
      )}

      {!publicKey && (
        <div className="text-base text-[var(--color-muted)] space-y-1">
          <div>
            Free code execution for anyone. Get keys at{' '}
            <a href="https://unsandbox.com" target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] hover:underline">unsandbox.com</a>
            {' '}— free tier runs 42 languages, paid tiers add sessions + semitrust network for agent harnesses.
          </div>
          <div>
            Tier formula: <span className="font-mono text-[var(--color-foreground)]">$7*N/mo</span> for <span className="font-mono text-[var(--color-foreground)]">N*7 rpm</span> + sessions.
            CLI: <code className="font-mono text-[var(--color-foreground)]">curl -O unsandbox.com/cli/typescript</code>
          </div>
        </div>
      )}
    </div>
  );
}
