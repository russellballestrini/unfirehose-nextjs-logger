// @vitest-environment jsdom
import { it, expect } from 'vitest';

/**
 * The control for locale-guard.test.ts: the real uPlot, imported without our
 * wrapper under a POSIX tag, throws while loading. If this ever stops
 * throwing, uPlot fixed it upstream and the guard can go.
 */
it('throws when uPlot is imported directly under en-US@posix', async () => {
  Object.defineProperty(navigator, 'language', { value: 'en-US@posix', configurable: true });
  try {
    await expect(import('uplot')).rejects.toThrow(RangeError);
  } finally {
    delete (navigator as unknown as Record<string, unknown>).language;
  }
});
