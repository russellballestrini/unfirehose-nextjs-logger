import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    env: {
      // See PBKDF2_ITERATIONS in components/vault.ts: the shipped count is
      // asserted by a test, and the rest of the suite exercises vault logic
      // without paying 2s per derivation. This took the suite from 101s to
      // roughly a tenth of that.
      UNFIREHOSE_TEST_KDF_ROUNDS: '1000',
    },
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
    //
    // Raised from 30s as this suite grew: the derivations are CPU-bound and
    // now compete with far more parallel work, so the wall-clock cost of a
    // fixed amount of work went up and the vault tests started failing
    // intermittently while passing alone. The budget tracks the suite, not
    // the machine.
    testTimeout: 60_000,
  },
});
