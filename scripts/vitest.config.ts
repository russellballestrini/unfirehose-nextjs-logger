import { defineConfig } from 'vitest/config';

/**
 * Our reporting tools measure the rest of the repo, so they are held to the
 * same standard they apply: the CRAP formula, the complexity walk and the
 * import resolver each have a suite, because a report nobody can check is
 * worse than no report at all.
 */
export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['quality/**/*.ts'],
      exclude: ['**/*.test.*'],
      // A floor, not a target. Set a few points under where each workspace
      // actually sits, so an ordinary change never trips it and a
      // wholesale loss of tests does. Raise these when the real number
      // moves up — a threshold left at its original value is a gate that
      // stopped guarding years ago, which is what these were.
      thresholds: {
        statements: 76,
        branches: 74,
        functions: 69,
        lines: 76,
      },
    },
    // A report walks every source file in the repo and parses each one, so
    // a single call is seconds of real work. The default 5s budget is below
    // that, and a report that has to scan the tree cannot be made faster by
    // being given less time.
    testTimeout: 60_000,
    restoreMocks: true,
    clearMocks: true,
  },
});
