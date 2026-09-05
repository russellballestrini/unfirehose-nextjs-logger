import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@unturf/unfirehose': path.resolve(__dirname, '.'),
    },
  },
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['**/*.ts'],
      exclude: ['types.ts', '**/*.test.*', 'test/**', 'vitest.config.ts'],
      // A ratchet, not an aspiration. These sit just under what the suite
      // actually holds, so `make coverage-check` fails on a regression
      // rather than sitting permanently red against a number nobody is
      // working toward. Raise them when coverage rises; never lower them to
      // make a red build green.
      // A floor, not a target. Set a few points under where each workspace
      // actually sits, so an ordinary change never trips it and a
      // wholesale loss of tests does. Raise these when the real number
      // moves up — a threshold left at its original value is a gate that
      // stopped guarding years ago, which is what these were.
      thresholds: {
        statements: 78,
        branches: 66,
        functions: 74,
        lines: 78,
      },
    },
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 10_000,
  },
});
