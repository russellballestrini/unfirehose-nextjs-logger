'use client';

export default function StyleguideError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="p-6 space-y-4">
      <h2 className="text-lg font-bold text-[var(--color-error)]">Styleguide failed to load</h2>
      <p className="text-base text-[var(--color-muted)]">
        This usually happens when chunks are still compiling. Try again.
      </p>
      <pre className="text-sm text-[var(--color-muted)] bg-[var(--color-surface)] p-4 rounded overflow-auto max-h-48 whitespace-pre-wrap">
        {error.message}
      </pre>
      <button
        onClick={reset}
        className="px-4 py-2 text-base rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 cursor-pointer"
      >
        Retry
      </button>
    </div>
  );
}
