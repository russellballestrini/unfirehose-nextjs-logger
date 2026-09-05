import '@testing-library/jest-dom/vitest';


// jsdom has no matchMedia and no ResizeObserver. uPlot asks for both at
// module load — matchMedia for the device pixel ratio — so any page that
// imports a uPlot chart could not even be required under test. These are
// the smallest stand-ins that let the module load; the chart components
// themselves are mocked where a test cares about what they drew.
if (typeof window !== 'undefined') {
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
    })) as unknown as typeof window.matchMedia;
  }
  if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
}

// jsdom's canvas has no drawing context, so uPlot's first draw dereferences
// null. A context whose every method is a no-op lets a chart mount and do
// nothing, which under jsdom is exactly right: what a page test asserts is
// the page around the chart. Tests of the charts themselves replace uPlot
// with a stand-in and read the options it was given.
if (typeof HTMLCanvasElement !== 'undefined') {
  const noop = () => {};
  const ctx2d = new Proxy({} as Record<string, unknown>, {
    get: (_t, k) => (k === 'canvas' ? null : k === 'measureText' ? () => ({ width: 0 }) : noop),
    set: () => true,
  });
  HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

// uPlot's bar paths are built with Path2D, which jsdom does not have either.
if (typeof (globalThis as { Path2D?: unknown }).Path2D === 'undefined') {
  (globalThis as { Path2D?: unknown }).Path2D = class {
    moveTo() {} lineTo() {} rect() {} closePath() {} arc() {} bezierCurveTo() {} quadraticCurveTo() {} addPath() {}
  };
}
