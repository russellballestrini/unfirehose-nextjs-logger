'use client';

import { useEffect, useState } from 'react';

/**
 * Our boot animation, once.
 *
 * This existed twice — privately inside VaultGate and again as a page-level
 * component in apps/web — in two dialects of the same markup. The copies had
 * already diverged on something that matters: one seeded its decorative
 * blocks with Math.random() during render, which gives the server and the
 * client different values and hydrates wrong. The deterministic sequence is
 * the one that survives.
 *
 * `fullscreen` is the only real difference between the two callers: the
 * vault covers the viewport before anything else can paint, a page waits
 * inside its own layout.
 */

const BOOT_LINES = [
  'UNFIREHOSE v1.0',
  'initializing data layer...',
  'connecting sqlite pipeline',
  'scanning JSONL harnesses',
  'loading mesh topology',
  'calibrating token counters',
  'mounting dashboard',
];

/** Fixed, so server and client agree on what the blocks look like. */
const BLOCK_OPACITY = [
  0.73, 0.91, 0.64, 0.85, 0.77, 0.98, 0.68, 0.82,
  0.95, 0.71, 0.88, 0.62, 0.79, 0.93, 0.66, 0.87,
];

const ACCENT = 'var(--color-accent, #d40000)';
const MUTED = 'var(--color-muted, #a1a1aa)';
const FOREGROUND = 'var(--color-foreground, #fafafa)';
const SURFACE = 'var(--color-surface, #18181b)';

export function BootScreen({ fullscreen = false }: { fullscreen?: boolean }) {
  const [visibleLines, setVisibleLines] = useState(0);
  const [progress, setProgress] = useState(0);
  const [dots, setDots] = useState('');

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

    return () => {
      clearInterval(lineTimer);
      clearInterval(progressTimer);
      clearInterval(dotTimer);
    };
  }, []);

  const frame = fullscreen
    ? 'fixed inset-0 z-50 flex items-center justify-center overflow-hidden'
    : 'relative flex items-center justify-center min-h-[70vh]';

  return (
    <div
      className={frame}
      style={{
        fontFamily: 'var(--font-mono, monospace)',
        ...(fullscreen ? { background: 'var(--color-background)' } : {}),
      }}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03]"
        style={{ backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.1) 2px, rgba(255,255,255,0.1) 4px)' }}
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.4) 100%)' }}
      />

      <div className="relative w-full max-w-lg px-8">
        <div className="mb-8 text-center">
          <h1
            className="text-3xl font-bold tracking-widest uppercase"
            style={{ color: ACCENT, textShadow: `0 0 10px ${ACCENT}, 0 0 40px rgba(212,0,0,0.4)` }}
          >
            UNFIREHOSE
          </h1>
          <div className="mt-1 text-sm tracking-[0.3em]" style={{ color: MUTED }}>
            AGENT DASHBOARD
          </div>
        </div>

        <div className="mb-6 text-sm space-y-1" style={{ height: '180px' }}>
          {BOOT_LINES.slice(0, visibleLines).map((line, i) => {
            const done = i < visibleLines - 1;
            return (
              <div key={line} className="flex items-center gap-2" style={{ animation: 'bootLineIn 0.2s ease-out' }}>
                <span className="shrink-0" style={{ color: i === 0 ? ACCENT : done ? '#10b981' : MUTED }}>
                  {i === 0 ? '>' : done ? '✓' : '▸'}
                </span>
                <span style={{ color: i === 0 || !done ? FOREGROUND : MUTED }}>
                  {line}
                  {i === visibleLines - 1 && i !== 0 && <span style={{ color: ACCENT }}>{dots}</span>}
                </span>
              </div>
            );
          })}
        </div>

        <div
          className="relative overflow-hidden"
          style={{ height: '8px', borderRadius: '9999px', background: SURFACE, border: '1px solid var(--color-border, #3f3f46)' }}
        >
          <div
            className="absolute inset-y-0 left-0"
            style={{
              width: `${progress}%`,
              borderRadius: '9999px',
              background: `linear-gradient(90deg, ${ACCENT}, #f59e0b)`,
              boxShadow: progress > 10 ? `0 0 12px ${ACCENT}, 0 0 4px #f59e0b` : 'none',
              transition: 'width 0.1s',
            }}
          />
          <div
            className="absolute inset-0"
            style={{ background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.15) 50%, transparent 100%)', animation: 'shimmer 1.5s infinite' }}
          />
        </div>

        <div className="mt-2 text-right text-sm" style={{ color: MUTED }}>
          {Math.round(progress)}%
        </div>

        <div className="mt-6 flex justify-center gap-1">
          {BLOCK_OPACITY.map((opacity, i) => {
            const lit = i / BLOCK_OPACITY.length < progress / 100;
            return (
              <div
                key={i}
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '2px',
                  backgroundColor: lit ? ACCENT : SURFACE,
                  opacity: lit ? opacity : 0.2,
                  animation: lit ? `blockPulse ${0.8 + (i % 3) * 0.2}s ease-in-out infinite alternate` : 'none',
                }}
              />
            );
          })}
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
