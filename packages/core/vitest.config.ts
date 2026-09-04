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
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 63,
        lines: 62,
      },
    },
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 10_000,
  },
});
