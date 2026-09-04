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
    },
    restoreMocks: true,
    clearMocks: true,
  },
});
