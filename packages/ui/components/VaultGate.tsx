'use client';

import { useState, type ReactNode } from 'react';
import { useVault } from './VaultProvider';

export function VaultGate({ children }: { children: ReactNode }) {
  const vault = useVault();
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Still loading vault state
  if (!vault.ready) {
    return (
      <div className="h-screen flex items-center justify-center bg-[var(--color-background)]">
        <div className="text-[var(--color-muted)] animate-pulse">Loading...</div>
      </div>
    );
  }

  // Vault is unlocked — render app
  if (vault.unlocked) {
    return <>{children}</>;
  }

  const isNew = !vault.exists;

  async function submit() {
    setError('');
    if (isNew && pw.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (!pw) {
      setError('Enter a password');
      return;
    }
    setLoading(true);
    try {
      if (isNew) {
        await vault.create(pw);
      } else {
        const ok = await vault.unlock(pw);
        if (!ok) setError('Wrong password');
      }
    } catch {
      setError('Something went wrong');
    }
    setLoading(false);
  }

  return (
    <div className="h-screen flex items-center justify-center bg-[var(--color-background)]">
      <div className="w-full max-w-sm space-y-6 p-8">
        {/* Logo */}
        <div className="text-center">
          <h1 className="font-black leading-none" style={{ fontSize: '2.4rem', letterSpacing: '-0.06em', WebkitTextStroke: '0.5px currentColor' }}>
            <span className="text-[var(--color-foreground)]">un</span>
            <span className="text-[var(--color-accent)]">firehose</span>
          </h1>
        </div>

        <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-6 space-y-4">
          <div className="text-center space-y-2">
            <div className="text-2xl">{isNew ? '\u{1F510}' : '\u{1F513}'}</div>
            <h2 className="text-base font-bold">
              {isNew ? 'Create your vault' : 'Unlock vault'}
            </h2>
            <p className="text-xs text-[var(--color-muted)]">
              {isNew
                ? 'Choose a password to encrypt your API keys locally. Keys never leave your browser unencrypted.'
                : 'Enter your vault password to decrypt your saved keys.'}
            </p>
          </div>

          <div>
            <input
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              placeholder={isNew ? 'Choose a password (8+ chars)' : 'Vault password'}
              autoFocus
              className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
            />
          </div>

          {error && (
            <div className="text-xs text-[var(--color-error)] text-center">{error}</div>
          )}

          <button
            onClick={submit}
            disabled={loading}
            className="w-full px-4 py-2 text-sm font-bold bg-[var(--color-accent)] text-[var(--color-background)] rounded hover:opacity-90 transition-opacity disabled:opacity-40 cursor-pointer"
          >
            {loading ? 'Working...' : isNew ? 'Create Vault' : 'Unlock'}
          </button>

          {isNew && (
            <p className="text-[10px] text-[var(--color-muted)] text-center">
              No recovery if you forget this password. Your encrypted keys will be lost.
            </p>
          )}

          {/* Skip option — vault is optional, mesh fallbacks still work */}
          <button
            onClick={() => vault.create(crypto.randomUUID())}
            className="w-full text-[10px] text-[var(--color-muted)] hover:text-[var(--color-foreground)] cursor-pointer transition-colors"
          >
            Skip — use without saving keys
          </button>
        </div>
      </div>
    </div>
  );
}
