import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.test.*'],
      // Low, because most of this app is pages no unit test enters. It is
      // still a ratchet: it catches the day a tested route stops being
      // tested. Raise it when coverage rises.
      thresholds: {
        statements: 11,
        branches: 5,
        functions: 5,
        lines: 12,
      },
    },
    restoreMocks: true,
    clearMocks: true,
    // Raised from 10s when the harness suites landed. Each of those tests
    // imports or mounts a whole page or route, and the first in a file pays
    // for compiling its module graph — several hundred files across the
    // three of them. Under parallel load that crossed 10s and showed up as
    // four unrelated tests timing out at once, which is what a budget below
    // the work looks like rather than a defect.
    testTimeout: 30_000,
  },
});
