'use client';

import { useState } from 'react';

export default function LoginPage() {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key.trim() }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Login failed');
        setLoading(false);
        return;
      }

      // Redirect to the originally requested page or dashboard
      const params = new URLSearchParams(window.location.search);
      const redirect = params.get('redirect') || '/';
      window.location.href = redirect;
    } catch {
      setError('Network error');
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center -m-6">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">unfirehose</h1>
          <p className="text-base text-[var(--color-muted)]">
            Paste your API key to sign in
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-4">
            <div>
              <label className="text-base text-[var(--color-muted)] block mb-1">
                API Key
              </label>
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="unfh_..."
                autoFocus
                className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base font-mono"
              />
            </div>

            {error && (
              <div className="text-base text-[var(--color-error)]">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !key.trim()}
              className="w-full px-4 py-2 text-base font-bold rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </div>
        </form>

        <p className="text-center text-base text-[var(--color-muted)]">
          Need a key?{' '}
          <a
            href="https://unsandbox.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-accent)] hover:underline"
          >
            Get one at unsandbox.com
          </a>
        </p>
      </div>
    </div>
  );
}
