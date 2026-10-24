// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { normaliseLanguageTag, guardNavigatorLanguage } from './locale-guard';

/**
 * uPlot reads navigator.language in its module body and hands it to
 * Intl.NumberFormat, which throws for a POSIX tag such as `en-US@posix`.
 * These load the real uPlot (no mock) with that tag in place.
 */

const proto = Object.getPrototypeOf(navigator);

function setLanguage(tag: string) {
  Object.defineProperty(navigator, 'language', { value: tag, configurable: true });
  Object.defineProperty(navigator, 'languages', { value: [tag], configurable: true });
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  // Drop the own properties so the prototype's getters answer again.
  delete (navigator as unknown as Record<string, unknown>).language;
  delete (navigator as unknown as Record<string, unknown>).languages;
  expect(Object.getPrototypeOf(navigator)).toBe(proto);
});

describe('normaliseLanguageTag', () => {
  it('keeps a valid tag as it is', () => {
    expect(normaliseLanguageTag('en-US')).toBe('en-US');
    expect(normaliseLanguageTag('de')).toBe('de');
  });
  it('strips a POSIX modifier and codeset', () => {
    expect(normaliseLanguageTag('en-US@posix')).toBe('en-US');
    expect(normaliseLanguageTag('en_GB.UTF-8@euro')).toBe('en-GB');
  });
  it('falls back to en-US for anything unusable', () => {
    expect(normaliseLanguageTag('C')).toBe('en-US');
    expect(normaliseLanguageTag('')).toBe('en-US');
    expect(normaliseLanguageTag(undefined)).toBe('en-US');
  });
});

describe('guardNavigatorLanguage', () => {
  it('rewrites an invalid language and languages in place', () => {
    setLanguage('en-US@posix');
    guardNavigatorLanguage();
    expect(navigator.language).toBe('en-US');
    expect(navigator.languages).toEqual(['en-US']);
  });
  it('leaves a valid language alone', () => {
    setLanguage('fr-CA');
    guardNavigatorLanguage();
    expect(navigator.language).toBe('fr-CA');
  });
  it('does nothing without a navigator', () => {
    expect(() => guardNavigatorLanguage(undefined)).not.toThrow();
  });
});

// The control (a direct import throwing) lives in uplot-unguarded.test.ts:
// a module that failed to evaluate stays failed in the native module cache,
// which vi.resetModules does not reach, so the two cannot share a file.
describe('loading uPlot under a POSIX locale', () => {
  it('loads through our wrapper', async () => {
    setLanguage('en-US@posix');
    const mod = await import('./index');
    expect(typeof mod.default).toBe('function');
    expect(navigator.language).toBe('en-US');
  });
});
