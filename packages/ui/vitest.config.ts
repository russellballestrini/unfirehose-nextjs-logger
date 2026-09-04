import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      include: ['components/**/*.{ts,tsx}', 'hooks/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
      exclude: ['**/*.test.*'],
    },
    restoreMocks: true,
    clearMocks: true,
    // The vault derives its key with PBKDF2 at 600,000 iterations, which is
    // the point of it — that is the OWASP figure and the one that ships. A
    // single derivation runs 1.5–2.5s here, and a lock-then-unlock test pays
    // it twice, so against the 5s default these tests were racing the clock:
    // whichever one happened to cross the line failed, and which one it was
    // changed run to run. Nothing was broken and nothing was flaky in the
    // usual sense; the budget was simply below the work.
    //
    // The alternative was lowering the iteration count under test, which
    // buys speed by no longer exercising the parameter that ships.
    testTimeout: 30_000,
  },
});
