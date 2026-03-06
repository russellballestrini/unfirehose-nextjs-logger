'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" className="dark">
      <body style={{ fontFamily: 'monospace', background: '#09090b', color: '#fafafa', padding: 24 }}>
        <h2 style={{ color: '#f87171' }}>Something went wrong</h2>
        <p style={{ color: '#a1a1aa', marginTop: 8 }}>
          {error.message || 'A client-side exception occurred.'}
        </p>
        <button
          onClick={reset}
          style={{
            marginTop: 16, padding: '8px 16px', border: '1px solid #d40000',
            color: '#d40000', background: 'transparent', borderRadius: 4, cursor: 'pointer',
          }}
        >
          Retry
        </button>
      </body>
    </html>
  );
}
