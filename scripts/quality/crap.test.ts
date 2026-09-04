import { describe, it, expect } from 'vitest';
import { crapScore, coverageNeeded, CRAP_THRESHOLD } from './crap.ts';

describe('CRAP', () => {
  it('scores a fully covered function as its own complexity', () => {
    // The property the whole metric rests on: tests retire risk completely,
    // so a covered function is only as risky as it is complex.
    for (const cc of [1, 5, 20, 100]) {
      expect(crapScore(cc, 1)).toBe(cc);
    }
  });

  it('scores an untested function as cc squared plus cc', () => {
    expect(crapScore(1, 0)).toBe(2);
    expect(crapScore(10, 0)).toBe(110);
    expect(crapScore(30, 0)).toBe(930);
  });

  it('punishes partial coverage of a branchy function', () => {
    // Half-covering 20 branches leaves 8 of the 400 risk points standing,
    // not 200 — the cube is what stops "we tested the happy path" from
    // reading as safety.
    expect(crapScore(20, 0.5)).toBeCloseTo(20 ** 2 * 0.125 + 20, 6);
    expect(crapScore(20, 0.5)).toBeCloseTo(70, 6);
  });

  it('rises with complexity and falls with coverage, always', () => {
    expect(crapScore(15, 0)).toBeGreaterThan(crapScore(14, 0));
    expect(crapScore(15, 0.9)).toBeLessThan(crapScore(15, 0.5));
  });

  it('treats coverage outside 0..1 as the nearest real reading', () => {
    expect(crapScore(10, 1.4)).toBe(crapScore(10, 1));
    expect(crapScore(10, -0.2)).toBe(crapScore(10, 0));
  });

  it('a simple function passes the threshold untested', () => {
    // cc 5 untested scores 30 — exactly the line. Nothing simpler needs a
    // test to clear it, which is the point of ranking by CRAP and not by
    // coverage alone.
    expect(crapScore(5, 0)).toBe(CRAP_THRESHOLD);
    expect(crapScore(4, 0)).toBeLessThan(CRAP_THRESHOLD);
  });

  it('says how much coverage would bring a function under the line', () => {
    const needed = coverageNeeded(10)!;
    expect(crapScore(10, needed)).toBeCloseTo(CRAP_THRESHOLD, 6);
    // Under the threshold already, so no coverage is required at all.
    expect(coverageNeeded(4)).toBe(0);
  });

  it('reports no reachable coverage once complexity alone exceeds the threshold', () => {
    // A 40-branch function scores 40 even fully tested. Tests cannot fix it;
    // splitting it can. Saying "split" is more useful than a percentage.
    expect(coverageNeeded(40)).toBeNull();
    expect(coverageNeeded(30)).toBeNull();
  });
});
