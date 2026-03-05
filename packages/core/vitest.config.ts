import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@unfirehose/core': path.resolve(__dirname, '.'),
    },
  },
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['**/*.ts'],
      exclude: ['types.ts', '**/*.test.*', 'test/**', 'vitest.config.ts'],
      thresholds: {
        statements: 50,
        branches: 35,
        functions: 70,
        lines: 50,
      },
    },
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 10_000,
  },
});
