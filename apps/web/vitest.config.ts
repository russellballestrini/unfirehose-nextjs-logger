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
      // A floor, not a target. Set a few points under where each workspace
      // actually sits, so an ordinary change never trips it and a
      // wholesale loss of tests does. Raise these when the real number
      // moves up — a threshold left at its original value is a gate that
      // stopped guarding years ago, which is what these were.
      thresholds: {
        statements: 64,
        branches: 55,
        functions: 56,
        lines: 64,
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
