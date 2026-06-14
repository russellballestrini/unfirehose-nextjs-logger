// Global loading fallback — anchored to <main> via position:absolute so it
// always lands in the body content area regardless of how Next 16's
// streaming hands the layout off mid-navigation. Requires the parent
// (<main> in apps/web/src/app/layout.tsx) to be position:relative so the
// absolute resolves against main rather than escaping to <body> and
// overlapping the sidebar.
export function Splash({ label = 'loading' }: { label?: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center select-none">
      <div className="flex flex-col items-center gap-5">
        {/* Spinning ring — uses theme accent */}
        <div className="relative w-12 h-12 animate-spin" style={{ animationDuration: '1.1s' }}>
          <div
            className="absolute inset-0 rounded-full"
            style={{
              border: '2px solid color-mix(in srgb, var(--color-accent) 18%, transparent)',
              borderTopColor: 'var(--color-accent)',
              boxShadow: '0 0 18px color-mix(in srgb, var(--color-accent) 35%, transparent)',
            }}
          />
        </div>

        {/* Label with progressive pulsing dots */}
        <div className="flex items-baseline gap-1.5 font-mono tracking-[0.25em] uppercase text-sm text-[var(--color-muted)]">
          <span>{label}</span>
          <span className="inline-flex gap-0.5">
            <span
              className="inline-block w-1 h-1 rounded-full"
              style={{
                backgroundColor: 'var(--color-accent)',
                animation: 'block-pulse 0.9s ease-in-out infinite alternate',
              }}
            />
            <span
              className="inline-block w-1 h-1 rounded-full"
              style={{
                backgroundColor: 'var(--color-accent)',
                animation: 'block-pulse 0.9s ease-in-out 0.15s infinite alternate',
              }}
            />
            <span
              className="inline-block w-1 h-1 rounded-full"
              style={{
                backgroundColor: 'var(--color-accent)',
                animation: 'block-pulse 0.9s ease-in-out 0.3s infinite alternate',
              }}
            />
          </span>
        </div>
      </div>
    </div>
  );
}
