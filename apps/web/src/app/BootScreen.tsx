'use client';

import { useEffect, useState } from 'react';

const BOOT_LINES = [
  'UNFIREHOSE v1.0',
  'initializing data layer...',
  'connecting sqlite pipeline',
  'scanning JSONL harnesses',
  'loading mesh topology',
  'calibrating token counters',
  'mounting dashboard',
];

export function BootScreen() {
  const [visibleLines, setVisibleLines] = useState(0);
  const [progress, setProgress] = useState(0);
  const [dots, setDots] = useState('');
  // Deterministic pseudo-random opacities for decorative blocks
  const blockOpacities = [0.73, 0.91, 0.64, 0.85, 0.77, 0.98, 0.68, 0.82, 0.95, 0.71, 0.88, 0.62, 0.79, 0.93, 0.66, 0.87];

  useEffect(() => {
    const lineTimer = setInterval(() => {
      setVisibleLines((v) => {
        if (v >= BOOT_LINES.length) {
          clearInterval(lineTimer);
          return v;
        }
        return v + 1;
      });
    }, 180);

    const progressTimer = setInterval(() => {
      setProgress((p) => {
        if (p >= 100) {
          clearInterval(progressTimer);
          return 100;
        }
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

  return (
    <div className="flex items-center justify-center min-h-[70vh] relative">
      {/* Scanlines overlay */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.1) 2px, rgba(255,255,255,0.1) 4px)',
        }}
      />

      {/* CRT vignette */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.4) 100%)',
        }}
      />

      <div className="relative w-full max-w-lg px-8">
        {/* Logo / title with glow */}
        <div className="mb-8 text-center">
          <h1
            className="text-3xl font-bold tracking-widest uppercase"
            style={{
              color: 'var(--color-accent)',
              textShadow:
                '0 0 10px var(--color-accent), 0 0 40px color-mix(in srgb, var(--color-accent) 40%, transparent)',
            }}
          >
            UNFIREHOSE
          </h1>
          <div className="mt-1 text-[var(--color-muted)] text-sm tracking-[0.3em]">
            AGENT DASHBOARD
          </div>
        </div>

        {/* Boot log */}
        <div className="mb-6 font-mono text-sm space-y-1 h-[180px]">
          {BOOT_LINES.slice(0, visibleLines).map((line, i) => (
            <div
              key={i}
              className="flex items-center gap-2"
              style={{ animation: 'boot-line-in 0.2s ease-out' }}
            >
              <span
                className="shrink-0"
                style={{
                  color:
                    i === 0
                      ? 'var(--color-accent)'
                      : i < visibleLines - 1
                        ? '#10b981'
                        : 'var(--color-muted)',
                }}
              >
                {i === 0 ? '>' : i < visibleLines - 1 ? '\u2713' : '\u25B8'}
              </span>
              <span
                style={{
                  color:
                    i === 0
                      ? 'var(--color-foreground)'
                      : i < visibleLines - 1
                        ? 'var(--color-muted)'
                        : 'var(--color-foreground)',
                }}
              >
                {line}
                {i === visibleLines - 1 && i !== 0 && (
                  <span className="text-[var(--color-accent)]">{dots}</span>
                )}
              </span>
            </div>
          ))}
        </div>

        {/* Progress bar */}
        <div className="relative h-2 rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full transition-all duration-100"
            style={{
              width: `${progress}%`,
              background: 'linear-gradient(90deg, var(--color-accent), #f59e0b)',
              boxShadow:
                progress > 10
                  ? '0 0 12px var(--color-accent), 0 0 4px #f59e0b'
                  : 'none',
            }}
          />
          {/* Shimmer */}
          <div
            className="absolute inset-0"
            style={{
              background:
                'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.15) 50%, transparent 100%)',
              animation: 'shimmer 1.5s infinite',
            }}
          />
        </div>

        {/* Percentage */}
        <div className="mt-2 text-right text-sm font-mono text-[var(--color-muted)]">
          {Math.round(progress)}%
        </div>

        {/* Bottom decorative blocks */}
        <div className="mt-6 flex justify-center gap-1">
          {blockOpacities.map((opacity, i) => (
            <div
              key={i}
              className="w-2 h-2 rounded-sm"
              style={{
                backgroundColor:
                  i / 16 < progress / 100
                    ? 'var(--color-accent)'
                    : 'var(--color-surface)',
                opacity: i / 16 < progress / 100 ? opacity : 0.2,
                animation:
                  i / 16 < progress / 100
                    ? `block-pulse ${0.8 + (i % 3) * 0.2}s ease-in-out infinite alternate`
                    : 'none',
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
