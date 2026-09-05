// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { layout, angleOf, Donut } from './donut';

/**
 * A donut chart built the way uPlot is built.
 *
 * The geometry is pure and tested as arithmetic: arcs that close the circle,
 * gaps that come out of each slice rather than off the total, hit-tests that
 * land on the slice under the pointer and nowhere in the hole. The class is
 * tested against jsdom's no-op canvas from the test setup — what it draws is
 * not observable there, but what it computes, which hooks it fires and what
 * it tears down are.
 */

const TAU = Math.PI * 2;
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

describe('layout', () => {
  it('closes the circle', () => {
    const s = layout([1, 2, 3]);
    expect(close(s.at(-1)!.end - s[0].start, TAU)).toBe(true);
  });

  it('gives each slice its share of the whole', () => {
    const s = layout([1, 3]);
    expect(s.map((x) => x.frac)).toEqual([0.25, 0.75]);
    expect(close(s[0].end - s[0].start, TAU / 4)).toBe(true);
  });

  it('starts at twelve o\'clock, the way people read a clock face', () => {
    expect(layout([1])[0].start).toBe(-Math.PI / 2);
  });

  it('takes the gap out of each slice, so the total still closes', () => {
    // Padding off the total would leave a wedge of nothing at the end.
    const s = layout([1, 1], -Math.PI / 2, 0.1);
    expect(close(s[0].end - s[0].start, Math.PI - 0.1)).toBe(true);
    expect(close(s[1].start - s[0].end, 0.1)).toBe(true);
    expect(close(s[1].end - s[0].start + 0.1, TAU)).toBe(true);
  });

  it('does not gap a lone slice, which has nothing to be separated from', () => {
    const [s] = layout([5], -Math.PI / 2, 0.1);
    expect(close(s.end - s.start, TAU)).toBe(true);
  });

  it('skips zero and negative values but keeps everyone else\'s index', () => {
    // The index is how a slice finds its colour and label. Dropping a value
    // must not shift the ones after it onto the wrong colour.
    const s = layout([2, 0, -1, 2]);
    expect(s.map((x) => x.idx)).toEqual([0, 3]);
    expect(s.map((x) => x.frac)).toEqual([0.5, 0.5]);
  });

  it('has nothing to draw when everything is zero', () => {
    expect(layout([0, 0])).toEqual([]);
    expect(layout([])).toEqual([]);
  });
});

describe('angleOf', () => {
  it('measures from the start angle so a slice starting at twelve is first', () => {
    const start = -Math.PI / 2;
    expect(close(angleOf(0, -1, start), start)).toBe(true);           // straight up
    expect(close(angleOf(1, 0, start), 0)).toBe(true);                // three o'clock
    expect(close(angleOf(0, 1, start), Math.PI / 2)).toBe(true);      // six
    expect(close(angleOf(-1, 0, start), Math.PI)).toBe(true);         // nine
  });

  it('never returns an angle outside one turn from the start', () => {
    for (const [dx, dy] of [[1, 1], [-1, -1], [0.001, -1], [-0.001, -1]]) {
      const a = angleOf(dx, dy, -Math.PI / 2);
      expect(a).toBeGreaterThanOrEqual(-Math.PI / 2);
      expect(a).toBeLessThan(-Math.PI / 2 + TAU);
    }
  });
});

const mount = (opts: Partial<ConstructorParameters<typeof Donut>[0]> = {}, values = [1, 1, 2]) => {
  const el = document.createElement('div');
  const d = new Donut({ width: 200, height: 200, lift: 0, ...opts }, {
    values, colors: ['#a', '#b', '#c'], labels: ['a', 'b', 'c'],
  }, el);
  return { d, el };
};

describe('Donut', () => {
  it('appends one canvas to the element it was given, sized in CSS pixels', () => {
    const { d, el } = mount();
    expect(el.querySelectorAll('canvas')).toHaveLength(1);
    expect(d.canvas.style.width).toBe('200px');
  });

  it('finds the slice under a point', () => {
    // values 1,1,2 from twelve o'clock: a spans 12→3, b spans 3→6, c the
    // left half. A point at two o'clock, mid-ring, is a; nine o'clock is c.
    const { d } = mount({ inner: 0.5 });
    const r = d.geometry.outer * 0.75;
    expect(d.idxAt(100 + r * Math.cos(-Math.PI / 4), 100 + r * Math.sin(-Math.PI / 4))).toBe(0);
    expect(d.idxAt(100 - r, 100)).toBe(2);
  });

  it('finds nothing in the hole or outside the ring', () => {
    const { d } = mount({ inner: 0.5 });
    expect(d.idxAt(100, 100)).toBeNull();
    expect(d.idxAt(100, 100 - d.geometry.inner * 0.5)).toBeNull();
    expect(d.idxAt(199, 199)).toBeNull();
  });

  it('counts the gap as part of the slice it came from, so hovering never flickers off', () => {
    const { d } = mount({ inner: 0.5, padAngle: 0.2 }, [1, 1]);
    // Exactly on the boundary between the two slices, mid-ring.
    const r = d.geometry.outer * 0.75;
    expect(d.idxAt(100 + r * Math.cos(Math.PI / 2), 100 + r * Math.sin(Math.PI / 2))).not.toBeNull();
  });

  it('fires setCursor hooks only when the hovered slice changes', () => {
    const hook = vi.fn();
    const { d } = mount({ inner: 0.5, hooks: { setCursor: [hook] } });
    const r = d.geometry.outer * 0.75;
    d.setCursor(100 - r, 100); d.setCursor(100 - r + 1, 100);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(d.cursor.idx).toBe(2);
    d.setCursor(-1, -1);
    expect(hook).toHaveBeenCalledTimes(2);
    expect(d.cursor.idx).toBeNull();
  });

  it('fires draw hooks after every redraw, with itself', () => {
    const hook = vi.fn();
    const { d } = mount({ hooks: { draw: [hook] } });
    const before = hook.mock.calls.length;
    d.setData({ values: [3], colors: ['#a'], labels: ['a'] });
    expect(hook).toHaveBeenCalledTimes(before + 1);
    expect(hook).toHaveBeenLastCalledWith(d);
  });

  it('asks for centre text on every draw, so a total can follow the data', () => {
    const center = vi.fn(() => ['42']);
    const { d } = mount({ center });
    const before = center.mock.calls.length;
    d.setData({ values: [1], colors: ['#a'], labels: ['a'] });
    expect(center.mock.calls.length).toBe(before + 1);
  });

  it('re-lays out on resize', () => {
    const { d } = mount();
    const outer = d.geometry.outer;
    d.setSize({ width: 400, height: 400 });
    expect(d.geometry.outer).toBeGreaterThan(outer);
    expect(d.canvas.style.width).toBe('400px');
  });

  it('removes its root and its listeners on destroy', () => {
    const { d, el } = mount();
    const rm = vi.spyOn(d.canvas, 'removeEventListener');
    d.destroy();
    expect(el.querySelector('canvas')).toBeNull();
    expect(rm).toHaveBeenCalledWith('mousemove', expect.any(Function));
  });
});
