// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

/**
 * Our time-series chart, without a canvas.
 *
 * uPlot draws to a canvas jsdom cannot provide, so it is replaced by a
 * stand-in that records the options it was handed and lets the hooks in
 * them be called directly. What that leaves under test is all of our own
 * code: the data shaping, the axis and scale decisions, and the hooks that
 * turn a drag into a zoom and a cursor into a row of value labels.
 */

/** The options object the component built, and the instance it got back. */
let built: Array<{ opts: any; data: any; el: HTMLElement; inst: FakeUPlot }>;

class FakeUPlot {
  data: any;
  select = { left: 0, top: 0, width: 0, height: 0 };
  cursor: { idx: number | null } = { idx: null };
  scales: Record<string, { min: number; max: number }> = { x: { min: 0, max: 1 } };
  over = document.createElement('div');
  root = document.createElement('div');
  setDataCalls: any[] = [];
  setScaleCalls: any[] = [];
  destroyed = false;

  constructor(public opts: any, data: any, public el: HTMLElement) {
    this.data = data;
    el.appendChild(this.root);
    built.push({ opts, data, el, inst: this });
  }
  setData(d: any) { this.data = d; this.setDataCalls.push(d); }
  setScale(k: string, v: any) { this.setScaleCalls.push([k, v]); }
  setSelect(sel: any) { this.select = { ...this.select, ...sel }; }
  setSize() {}
  destroy() { this.destroyed = true; }
  posToVal(pos: number) { return pos; }
  valToPos(v: number) { return v; }
}

vi.mock('uplot/dist/uPlot.min.css', () => ({}));
vi.mock('uplot', () => ({
  default: Object.assign(FakeUPlot, {
    pxRatio: 1,
    paths: { stepped: () => () => null },
    sync: () => ({ sub() {}, unsub() {} }),
  }),
}));

const { UPlotTimeChart, buildData } = await import('./UPlotTimeChart');

const SERIES = [
  { key: 'watts', label: 'watts', stroke: '#a78bfa' },
  { key: 'load', label: 'load', stroke: '#60a5fa' },
];

const rows = [
  { tsMs: 1_757_000_000_000, timestamp: '2026-09-04 12:00:00', watts: 142, load: 9.3 },
  { tsMs: 1_757_000_060_000, timestamp: '2026-09-04 12:01:00', watts: 150, load: 8.1 },
];

beforeEach(() => {
  built = [];
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 200 });
});
afterEach(cleanup);

describe('buildData', () => {
  it('gives uPlot seconds, since every row carries milliseconds', () => {
    const [xs] = buildData(rows, SERIES) as unknown as number[][];
    expect(xs).toEqual([1_757_000_000, 1_757_000_060]);
  });

  it('puts one column per series, in the order they were asked for', () => {
    const [, watts, load] = buildData(rows, SERIES) as unknown as number[][];
    expect(watts).toEqual([142, 150]);
    expect(load).toEqual([9.3, 8.1]);
  });

  it('reads a missing reading as a gap, not as zero', () => {
    // A zero on a watts chart is a machine that was off. A null is a
    // sample we never took, and uPlot draws the difference.
    const [, watts] = buildData(
      [{ tsMs: 1, watts: 10 }, { tsMs: 2 }, { tsMs: 3, watts: 12 }], [SERIES[0]],
    ) as unknown as (number | null)[][];
    expect(watts).toEqual([10, null, 12]);
  });

  it('reads a string where a number belongs as a gap too', () => {
    // Rows carry their own timestamp as a string alongside their numbers.
    const [, watts] = buildData(
      [{ tsMs: 1, watts: 'n/a' }], [SERIES[0]],
    ) as unknown as (number | null)[][];
    expect(watts).toEqual([null]);
  });

  it('still produces a column per series with no rows at all', () => {
    // uPlot indexes its series by position; a short array is a crash on
    // mount rather than an empty chart.
    const built = buildData([], SERIES) as unknown as unknown[][];
    expect(built).toHaveLength(3);
    expect(built.every(c => c.length === 0)).toBe(true);
  });
});

const show = (props: Record<string, unknown> = {}) => {
  const view = render(
    <UPlotTimeChart
      data={rows} series={SERIES} height={200} syncKey="test"
      domain={null} {...props as never}
    />,
  );
  return view;
};

describe('UPlotTimeChart', () => {
  it('mounts one chart with the data it was given', () => {
    show();
    expect(built).toHaveLength(1);
    expect(built[0].data[0]).toEqual([1_757_000_000, 1_757_000_060]);
  });

  it('locks its crosshair to every other chart with the same key', () => {
    // Eight charts on the node page read as one instrument only if their
    // cursors move together.
    show({ syncKey: 'node-detail' });
    expect(built[0].opts.cursor.sync.key).toBe('node-detail');
  });

  it('reports a drag as a time range, in milliseconds', () => {
    // The parent applies the zoom through the domain prop, so this hook
    // must hand back a range and clear its own selection rather than
    // zooming itself.
    const onZoom = vi.fn();
    show({ onZoom });
    const { opts, inst } = built[0];
    inst.select = { left: 100, top: 0, width: 50, height: 10 };
    act(() => { opts.hooks.setSelect[0](inst); });
    expect(onZoom).toHaveBeenCalledWith([100_000, 150_000]);
    expect(inst.select.width).toBe(0);
  });

  it('ignores a click that was not a drag', () => {
    // A three-pixel selection is a click, and zooming to it leaves a chart
    // showing a single sample.
    const onZoom = vi.fn();
    show({ onZoom });
    const { opts, inst } = built[0];
    inst.select = { left: 100, top: 0, width: 2, height: 10 };
    act(() => { opts.hooks.setSelect[0](inst); });
    expect(onZoom).not.toHaveBeenCalled();
  });

  it('reports the cursor position as a timestamp', () => {
    const onCursor = vi.fn();
    show({ onCursor });
    const { opts, inst } = built[0];
    inst.cursor.idx = 1;
    act(() => { opts.hooks.setCursor[0](inst); });
    expect(onCursor).toHaveBeenCalledWith(1, 1_757_000_060_000);
  });

  it('reports the cursor leaving, so a linked readout can clear', () => {
    const onCursor = vi.fn();
    show({ onCursor });
    const { opts, inst } = built[0];
    inst.cursor.idx = null;
    act(() => { opts.hooks.setCursor[0](inst); });
    expect(onCursor).toHaveBeenCalledWith(null, null);
  });

  it('hands new data to the existing chart rather than rebuilding it', () => {
    // Remounting on every poll is a visible flash and loses the zoom.
    const { rerender } = show();
    rerender(
      <UPlotTimeChart
        data={[...rows, { tsMs: 1_757_000_120_000, watts: 160, load: 7 }]}
        series={SERIES} height={200} syncKey="test" domain={null}
      />,
    );
    expect(built).toHaveLength(1);
    expect(built[0].inst.setDataCalls.length).toBeGreaterThan(0);
  });

  it('tears the chart down when it goes away', () => {
    // uPlot registers window listeners and a sync group; leaking those
    // across a page's charts is a leak per navigation.
    show();
    const { inst } = built[0];
    cleanup();
    expect(inst.destroyed).toBe(true);
  });
});
