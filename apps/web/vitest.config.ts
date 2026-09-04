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
        statements: 9,
        branches: 5,
        functions: 5,
        lines: 9,
      },
    },
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 10_000,
  },
});
