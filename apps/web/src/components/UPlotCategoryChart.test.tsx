// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

/**
 * Bars and lines over a labelled axis, without a canvas.
 *
 * uPlot draws to a canvas jsdom cannot provide, so a stand-in records the
 * options it was handed. What that leaves under test is our own decisions:
 * one tick per label, bars that sit between the half-marks, per-bar colours
 * routed through `disp` (uPlot's only per-point colour path), and a hover
 * readout that names the bar and its value.
 */

let built: Array<{ opts: any; data: any; inst: FakeUPlot }>;
class FakeUPlot {
  cursor: { idx: number | null; left?: number } = { idx: null, left: 0 };
  over = document.createElement('div');
  destroyed = false;
  constructor(public opts: any, public data: any, public el: HTMLElement) {
    Object.assign(this.over.style, { width: '600px' });
    Object.defineProperty(this.over, 'clientWidth', { value: 600 });
    el.appendChild(this.over);
    built.push({ opts, data, inst: this });
  }
  setSize() {}
  destroy() { this.destroyed = true; }
}
const barsPaths = vi.fn(() => 'BARS');
vi.mock('uplot/dist/uPlot.min.css', () => ({}));
vi.mock('uplot', () => ({ default: Object.assign(FakeUPlot, { paths: { bars: barsPaths }, pxRatio: 1 }) }));

const { UPlotCategoryChart } = await import('./UPlotCategoryChart');

const ROWS = [
  { day: 'Mon', dow: 1, count: 4 },
  { day: 'Tue', dow: 2, count: 9 },
  { day: 'Wed', dow: 3, count: 2 },
];
const COLOURS = ['#111', '#222', '#333'];

beforeEach(() => { built = []; (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} }; });
afterEach(cleanup);

const opts = () => built.at(-1)!.opts;
const hover = (idx: number | null, left = 100) => {
  const { inst } = built.at(-1)!;
  inst.cursor = { idx, left };
  act(() => { opts().hooks.setCursor[0](inst); });
  return inst.over.querySelector('div') as HTMLDivElement;
};

describe('bars', () => {
  it('draws one tick per label, in order', () => {
    // uPlot would otherwise pick "nice" numbers and label every fifth bar.
    render(<UPlotCategoryChart data={ROWS} labelKey="day" series={[{ key: 'count', label: 'msgs', color: '#f00' }]} height={100} />);
    const x = opts().axes[0];
    expect(x.splits()).toEqual([0, 1, 2]);
    expect(x.values(null, [0, 1, 2])).toEqual(['Mon', 'Tue', 'Wed']);
  });

  it('gives the first and last bar room by ranging the axis half a step past them', () => {
    render(<UPlotCategoryChart data={ROWS} labelKey="day" series={[{ key: 'count', label: 'msgs', color: '#f00' }]} height={100} />);
    expect(opts().scales.x.range).toEqual([-0.5, 2.5]);
  });

  it('hands uPlot the values as columns, indexed by position', () => {
    render(<UPlotCategoryChart data={ROWS} labelKey="day" series={[{ key: 'count', label: 'msgs', color: '#f00' }]} height={100} />);
    expect(built.at(-1)!.data).toEqual([[0, 1, 2], [4, 9, 2]]);
  });

  it('uses the bars path and one fill for a single-colour series', () => {
    render(<UPlotCategoryChart data={ROWS} labelKey="day" series={[{ key: 'count', label: 'msgs', color: '#f00' }]} height={100} />);
    expect(opts().series[1].paths).toBe('BARS');
    expect(opts().series[1].fill).toBe('#f00');
  });

  it('colours each bar on its own through disp, which is uPlot\'s per-point path', () => {
    // Day-of-week is drawn with a colour per weekday. `fill` is one colour
    // for the whole series; per-bar colour only exists through disp.
    render(<UPlotCategoryChart data={ROWS} labelKey="day" series={[{ key: 'count', label: 'msgs', color: COLOURS }]} height={100} />);
    const s = opts().series[1];
    expect(s.fill).toBeUndefined();
    expect(s.disp.fill.values()).toEqual(COLOURS);
  });

  it('treats a missing or non-numeric value as zero rather than a hole', () => {
    // A weekday with no activity is a zero-height bar, not a gap that makes
    // the neighbours look like they belong together.
    render(<UPlotCategoryChart data={[{ day: 'Mon', count: 3 }, { day: 'Tue' }, { day: 'Wed', count: 'x' }]} labelKey="day" series={[{ key: 'count', label: 'n', color: '#f00' }]} height={100} />);
    expect(built.at(-1)!.data[1]).toEqual([3, 0, 0]);
  });

  it('renders nothing for no rows rather than an empty chart with an axis', () => {
    render(<UPlotCategoryChart data={[]} labelKey="day" series={[{ key: 'count', label: 'n', color: '#f00' }]} height={100} />);
    expect(built).toHaveLength(0);
  });
});

describe('lines', () => {
  it('draws lines with a stroke and no bars path', () => {
    render(<UPlotCategoryChart kind="lines" data={ROWS} labelKey="day" series={[{ key: 'count', label: 'msgs', color: '#0f0', fill: 'rgba(0,255,0,.1)' }]} height={100} />);
    const s = opts().series[1];
    expect(s.paths).toBeUndefined();
    expect(s.stroke).toBe('#0f0');
    expect(s.fill).toBe('rgba(0,255,0,.1)');
    expect(opts().scales.x.range).toEqual([0, 2]);
  });

  it('carries several series over the same labels', () => {
    const rows = [{ h: 0, Sun: 1, Mon: 2 }, { h: 1, Sun: 3, Mon: 4 }];
    render(<UPlotCategoryChart kind="lines" data={rows} labelKey="h" series={[{ key: 'Sun', label: 'Sun', color: '#a' }, { key: 'Mon', label: 'Mon', color: '#b' }]} height={100} />);
    expect(built.at(-1)!.data).toEqual([[0, 1], [1, 3], [2, 4]]);
  });
});

describe('horizontal', () => {
  it('turns the chart on its side for long labels', () => {
    render(<UPlotCategoryChart horizontal data={ROWS} labelKey="day" series={[{ key: 'count', label: 'n', color: '#f00' }]} height={100} />);
    expect(opts().scales.x.ori).toBe(1);
    expect(opts().scales.y.ori).toBe(0);
    expect(opts().axes[0].side).toBe(3);
  });
});

describe('the hover readout', () => {
  it('names the bar and shows its value', () => {
    render(<UPlotCategoryChart data={ROWS} labelKey="day" series={[{ key: 'count', label: 'msgs', color: '#f00' }]} height={100} />);
    const box = hover(1);
    expect(box.innerHTML).toContain('Tue');
    expect(box.innerHTML).toContain('msgs: 9');
    expect(box.style.opacity).toBe('1');
  });

  it('formats the value the way the caller asked', () => {
    render(<UPlotCategoryChart data={ROWS} labelKey="day" series={[{ key: 'count', label: 'msgs', color: '#f00' }]} height={100} format={(v) => `${v} things`} />);
    expect(hover(0).innerHTML).toContain('4 things');
  });

  it('adds the caller\'s extra line, which is how the hour chart shows local time', () => {
    render(<UPlotCategoryChart data={ROWS} labelKey="day" series={[{ key: 'count', label: 'msgs', color: '#f00' }]} height={100} hover={(_r, i) => `row ${i}`} />);
    expect(hover(2).innerHTML).toContain('row 2');
  });

  it('hides when the cursor leaves', () => {
    render(<UPlotCategoryChart data={ROWS} labelKey="day" series={[{ key: 'count', label: 'msgs', color: '#f00' }]} height={100} />);
    hover(1);
    expect(hover(null).style.opacity).toBe('0');
  });

  it('flips to the left of the cursor near the right edge, so it stays on screen', () => {
    render(<UPlotCategoryChart data={ROWS} labelKey="day" series={[{ key: 'count', label: 'msgs', color: '#f00' }]} height={100} />);
    expect(hover(2, 500).style.right).not.toBe('auto');
    expect(hover(0, 50).style.left).not.toBe('auto');
  });
});

describe('lifecycle', () => {
  it('destroys the chart on unmount', () => {
    const { unmount } = render(<UPlotCategoryChart data={ROWS} labelKey="day" series={[{ key: 'count', label: 'n', color: '#f00' }]} height={100} />);
    unmount();
    expect(built.at(-1)!.inst.destroyed).toBe(true);
  });
});

describe('stacking, a second axis, and a line over bars', () => {
  const rows = [{ d: 'a', x: 1, y: 10, total: 11 }, { d: 'b', x: 2, y: 20, total: 33 }];

  it('sums each bar series onto the ones before it', () => {
    // uPlot has no stacking; the second series carries first+second so the
    // segments read as heights rather than overlapping from zero.
    render(<UPlotCategoryChart stacked data={rows} labelKey="d" series={[{ key: 'x', label: 'x', color: '#1' }, { key: 'y', label: 'y', color: '#2' }]} height={100} />);
    const d = built.at(-1)!.data;
    // Drawn back-to-front: the tallest (summed) series comes first.
    expect(d[1]).toEqual([11, 22]);
    expect(d[2]).toEqual([1, 2]);
    expect(opts().series[1].label).toBe('y');
    expect(opts().series[2].label).toBe('x');
  });

  it('shows the real value in the readout, not the stacked sum', () => {
    render(<UPlotCategoryChart stacked data={rows} labelKey="d" series={[{ key: 'x', label: 'x', color: '#1' }, { key: 'y', label: 'y', color: '#2' }]} height={100} />);
    expect(hover(1).innerHTML).toContain('y: 20');
    expect(hover(1).innerHTML).not.toContain('22');
  });

  it('puts a series on a right-hand axis with its own scale and format', () => {
    // A running total beside a daily figure: the same axis would flatten
    // the daily bars to nothing.
    render(<UPlotCategoryChart data={rows} labelKey="d"
      series={[{ key: 'x', label: 'daily', color: '#1' }, { key: 'total', label: 'total', color: '#2', kind: 'lines', axis: 'right' }]}
      height={100} formatRight={(v) => `$${v}`} />);
    expect(opts().scales.r).toBeDefined();
    expect(opts().series[2].scale).toBe('r');
    expect(opts().axes).toHaveLength(3);
    expect(opts().axes[2].side).toBe(1);
    expect(opts().axes[2].values(null, [33])).toEqual(['$33']);
    expect(hover(1).innerHTML).toContain('total: $33');
  });

  it('draws one series as a line over the bars', () => {
    render(<UPlotCategoryChart data={rows} labelKey="d"
      series={[{ key: 'x', label: 'daily', color: '#1' }, { key: 'total', label: 'total', color: '#2', kind: 'lines' }]} height={100} />);
    expect(opts().series[1].paths).toBe('BARS');
    expect(opts().series[2].paths).toBeUndefined();
    expect(opts().series[2].stroke).toBe('#2');
  });

  it('adds no right axis when nobody asked for one', () => {
    render(<UPlotCategoryChart data={rows} labelKey="d" series={[{ key: 'x', label: 'x', color: '#1' }]} height={100} />);
    expect(opts().scales.r).toBeUndefined();
    expect(opts().axes).toHaveLength(2);
  });
});

describe('guide lines and the legend', () => {
  const rows = [{ d: 'a', v: 1 }, { d: 'b', v: 5 }];

  it('draws a dashed guide at the value asked for, on the axis asked for', () => {
    render(<UPlotCategoryChart data={rows} labelKey="d" series={[{ key: 'v', label: 'v', color: '#1' }]} height={100}
      refLines={[{ value: 3, color: '#f00', label: '$3 actual' }]} />);
    const draw = opts().hooks.draw[0];
    const calls: string[] = [];
    const ctx = new Proxy({}, { get: (_t, k) => (k === 'canvas' ? undefined : (..._a: unknown[]) => { calls.push(String(k)); }) });
    const u = { ctx, bbox: { left: 0, width: 100 }, valToPos: vi.fn(() => 42) };
    draw(u);
    expect(u.valToPos).toHaveBeenCalledWith(3, 'y', true);
    expect(calls).toEqual(expect.arrayContaining(['setLineDash', 'moveTo', 'lineTo', 'stroke', 'fillText']));
  });

  it('registers no draw hook when there are no guides', () => {
    render(<UPlotCategoryChart data={rows} labelKey="d" series={[{ key: 'v', label: 'v', color: '#1' }]} height={100} />);
    expect(opts().hooks.draw).toEqual([]);
  });

  it('names each series in a legend when asked', () => {
    render(<UPlotCategoryChart legend data={rows} labelKey="d" series={[{ key: 'v', label: 'opus', color: '#1' }, { key: 'v', label: 'sonnet', color: ['#2', '#3'] }]} height={100} />);
    const items = document.querySelectorAll('[role=listitem]');
    expect([...items].map((i) => i.textContent)).toEqual(['opus', 'sonnet']);
  });

  it('shows no legend by default, since a single series names itself in the hover', () => {
    render(<UPlotCategoryChart data={rows} labelKey="d" series={[{ key: 'v', label: 'v', color: '#1' }]} height={100} />);
    expect(document.querySelector('[role=list]')).toBeNull();
  });
});

