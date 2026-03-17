'use client';

import { useState, useEffect, useRef, type ReactNode } from 'react';
import { useVault } from './VaultProvider';

const BOOT_LINES = [
  'UNFIREHOSE v1.0',
  'initializing data layer...',
  'connecting sqlite pipeline',
  'scanning JSONL harnesses',
  'loading mesh topology',
  'calibrating token counters',
  'mounting dashboard',
];

function BootScreen() {
  const [visibleLines, setVisibleLines] = useState(0);
  const [progress, setProgress] = useState(0);
  const [dots, setDots] = useState('');
  const blockOpacities = useRef<number[]>(
    Array.from({ length: 16 }, () => 0.6 + Math.random() * 0.4)
  );

  useEffect(() => {
    const lineTimer = setInterval(() => {
      setVisibleLines((v) => {
        if (v >= BOOT_LINES.length) { clearInterval(lineTimer); return v; }
        return v + 1;
      });
    }, 180);
    const progressTimer = setInterval(() => {
      setProgress((p) => {
        if (p >= 100) { clearInterval(progressTimer); return 100; }
        const step = p < 60 ? 4 + Math.random() * 6 : 1 + Math.random() * 2;
        return Math.min(100, p + step);
      });
    }, 80);
    const dotTimer = setInterval(() => {
      setDots((d) => (d.length >= 3 ? '' : d + '.'));
    }, 400);
    return () => { clearInterval(lineTimer); clearInterval(progressTimer); clearInterval(dotTimer); };
  }, []);

  return (
    <div className="h-screen flex items-center justify-center bg-[var(--color-background)] relative overflow-hidden" style={{ fontFamily: 'var(--font-mono, monospace)' }}>
      {/* Scanlines */}
      <div className="pointer-events-none absolute inset-0 opacity-[0.03]" style={{ backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.1) 2px, rgba(255,255,255,0.1) 4px)' }} />
      {/* CRT vignette */}
      <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.4) 100%)' }} />

      <div className="relative w-full max-w-lg px-8">
        {/* Logo */}
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-widest uppercase" style={{ color: 'var(--color-accent, #d40000)', textShadow: '0 0 10px var(--color-accent, #d40000), 0 0 40px rgba(212,0,0,0.4)' }}>
            UNFIREHOSE
          </h1>
          <div className="mt-1 text-sm tracking-[0.3em]" style={{ color: 'var(--color-muted, #a1a1aa)' }}>
            AGENT DASHBOARD
          </div>
        </div>

        {/* Boot log */}
        <div className="mb-6 text-sm space-y-1" style={{ height: '180px' }}>
          {BOOT_LINES.slice(0, visibleLines).map((line, i) => (
            <div key={i} className="flex items-center gap-2" style={{ animation: 'bootLineIn 0.2s ease-out' }}>
              <span className="shrink-0" style={{ color: i === 0 ? 'var(--color-accent, #d40000)' : i < visibleLines - 1 ? '#10b981' : 'var(--color-muted, #a1a1aa)' }}>
                {i === 0 ? '>' : i < visibleLines - 1 ? '\u2713' : '\u25B8'}
              </span>
              <span style={{ color: i === 0 ? 'var(--color-foreground, #fafafa)' : i < visibleLines - 1 ? 'var(--color-muted, #a1a1aa)' : 'var(--color-foreground, #fafafa)' }}>
                {line}
                {i === visibleLines - 1 && i !== 0 && <span style={{ color: 'var(--color-accent, #d40000)' }}>{dots}</span>}
              </span>
            </div>
          ))}
        </div>

        {/* Progress bar */}
        <div className="relative overflow-hidden" style={{ height: '8px', borderRadius: '9999px', background: 'var(--color-surface, #18181b)', border: '1px solid var(--color-border, #3f3f46)' }}>
          <div className="absolute inset-y-0 left-0" style={{ width: `${progress}%`, borderRadius: '9999px', background: 'linear-gradient(90deg, var(--color-accent, #d40000), #f59e0b)', boxShadow: progress > 10 ? '0 0 12px var(--color-accent, #d40000), 0 0 4px #f59e0b' : 'none', transition: 'width 0.1s' }} />
          <div className="absolute inset-0" style={{ background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.15) 50%, transparent 100%)', animation: 'shimmer 1.5s infinite' }} />
        </div>

        <div className="mt-2 text-right text-sm" style={{ color: 'var(--color-muted, #a1a1aa)' }}>
          {Math.round(progress)}%
        </div>

        {/* Bottom blocks */}
        <div className="mt-6 flex justify-center gap-1">
          {blockOpacities.current.map((opacity, i) => (
            <div key={i} style={{ width: '8px', height: '8px', borderRadius: '2px', backgroundColor: i / 16 < progress / 100 ? 'var(--color-accent, #d40000)' : 'var(--color-surface, #18181b)', opacity: i / 16 < progress / 100 ? opacity : 0.2, animation: i / 16 < progress / 100 ? `blockPulse ${0.8 + (i % 3) * 0.2}s ease-in-out infinite alternate` : 'none' }} />
          ))}
        </div>
      </div>

      <style>{`
        @keyframes bootLineIn { 0% { opacity: 0; transform: translateX(-8px); } 100% { opacity: 1; transform: translateX(0); } }
        @keyframes shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(200%); } }
        @keyframes blockPulse { 0% { opacity: 0.4; } 100% { opacity: 1; } }
      `}</style>
    </div>
  );
}

export function VaultGate({ children }: { children: ReactNode }) {
  const vault = useVault();
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Still loading vault state — show boot screen
  if (!vault.ready) {
    return <BootScreen />;
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
    <div className="flex-1 flex items-center justify-center bg-[var(--color-background)] relative overflow-hidden">
      {/* Animated background glow */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="w-[600px] h-[600px] rounded-full opacity-15 blur-[120px]" style={{ background: 'radial-gradient(circle, var(--color-accent) 0%, transparent 70%)', animation: 'pulse 4s ease-in-out infinite' }} />
      </div>

      <style>{`
        @keyframes pulse { 0%, 100% { transform: scale(1); opacity: 0.12; } 50% { transform: scale(1.15); opacity: 0.2; } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
      `}</style>

      <div className="w-full max-w-lg space-y-8 p-8 relative z-10" style={{ animation: 'slideUp 0.6s ease-out' }}>
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
            <h2 className="text-2xl font-bold">
              {isNew ? 'Create your vault' : 'Unlock vault'}
            </h2>
            <p className="text-base text-[var(--color-muted)] max-w-sm mx-auto">
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
              className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded-lg px-5 py-4 text-lg focus:outline-none focus:border-[var(--color-accent)] focus:shadow-[0_0_20px_rgba(239,68,68,0.15)] transition-all"
            />
          </div>

          {error && (
            <div className="text-sm text-[var(--color-error)] text-center font-medium">{error}</div>
          )}

          <button
            onClick={submit}
            disabled={loading}
            className="w-full px-6 py-4 text-lg font-bold text-[var(--color-background)] rounded-lg hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-40 cursor-pointer"
            style={{
              background: loading ? 'var(--color-accent)' : 'linear-gradient(135deg, var(--color-accent), #ff6b6b)',
              boxShadow: '0 4px 20px rgba(239, 68, 68, 0.3)',
            }}
          >
            {loading ? 'Working...' : isNew ? 'Create Vault' : 'Unlock'}
          </button>

          {isNew && (
            <p className="text-sm text-[var(--color-muted)] text-center">
              No recovery if you forget this password. Your encrypted keys will be lost.
            </p>
          )}

          {/* Skip option */}
          <button
            onClick={() => vault.create(crypto.randomUUID())}
            className="w-full text-sm text-[var(--color-muted)] hover:text-[var(--color-foreground)] cursor-pointer transition-colors py-1"
          >
            Skip — use without saving keys
          </button>
        </div>
      </div>
    </div>
  );
}
