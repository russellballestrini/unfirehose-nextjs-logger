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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-background)] overflow-hidden">
      {/* Animated background glow */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="w-[600px] h-[600px] rounded-full opacity-15 blur-[120px]" style={{ background: 'radial-gradient(circle, var(--color-accent) 0%, transparent 70%)', animation: 'pulse 4s ease-in-out infinite' }} />
      </div>

      <style>{`
        @keyframes pulse { 0%, 100% { transform: scale(1); opacity: 0.12; } 50% { transform: scale(1.15); opacity: 0.2; } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
      `}</style>

      <div className="w-full max-w-xl space-y-8 p-8 relative z-10" style={{ animation: 'slideUp 0.6s ease-out' }}>
        {/* Logo */}
        <div className="text-center">
          <h1 className="font-black leading-none" style={{ fontSize: '4rem', letterSpacing: '-0.06em', WebkitTextStroke: '0.5px currentColor' }}>
            <span className="text-[var(--color-foreground)]">un</span>
            <span className="text-[var(--color-accent)]">firehose</span>
          </h1>
          <p className="text-sm text-[var(--color-muted)] mt-2 tracking-widest uppercase">Permacomputer Dashboard</p>
        </div>

        <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-8 space-y-6 shadow-2xl" style={{ boxShadow: '0 0 60px rgba(239, 68, 68, 0.08), 0 25px 50px rgba(0,0,0,0.5)' }}>
          <div className="text-center space-y-3">
            <div className="text-5xl">{isNew ? '\u{1F510}' : '\u{1F513}'}</div>
            <h2 className="text-xl font-bold">
              {isNew ? 'Create your vault' : 'Unlock vault'}
            </h2>
            <p className="text-sm text-[var(--color-muted)] max-w-xs mx-auto">
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
              className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded-lg px-4 py-3 text-base focus:outline-none focus:border-[var(--color-accent)] focus:shadow-[0_0_20px_rgba(239,68,68,0.15)] transition-all"
            />
          </div>

          {error && (
            <div className="text-sm text-[var(--color-error)] text-center font-medium">{error}</div>
          )}

          <button
            onClick={submit}
            disabled={loading}
            className="w-full px-6 py-3 text-base font-bold text-[var(--color-background)] rounded-lg hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-40 cursor-pointer"
            style={{
              background: loading ? 'var(--color-accent)' : 'linear-gradient(135deg, var(--color-accent), #ff6b6b)',
              boxShadow: '0 4px 20px rgba(239, 68, 68, 0.3)',
            }}
          >
            {loading ? 'Working...' : isNew ? 'Create Vault' : 'Unlock'}
          </button>

          {isNew && (
            <p className="text-xs text-[var(--color-muted)] text-center">
              No recovery if you forget this password. Your encrypted keys will be lost.
            </p>
          )}

          {/* Skip option */}
          <button
            onClick={() => vault.create(crypto.randomUUID())}
            className="w-full text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)] cursor-pointer transition-colors py-1"
          >
            Skip — use without saving keys
          </button>
        </div>
      </div>
    </div>
  );
}
