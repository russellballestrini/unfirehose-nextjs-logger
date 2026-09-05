/**
 * A donut chart, built the way uPlot is built.
 *
 * uPlot is a cartesian library — everything it draws sits on an x and a y
 * scale — so a pie cannot be one of its plugins. But it can be made in its
 * image: one canvas, sized in device pixels and scaled back with pxRatio;
 * an options object and a data tuple handed to a constructor that appends
 * to an element you own; `setData`, `setSize`, `destroy`; hooks that fire
 * around a draw and on cursor movement; and hover handled with native
 * listeners so nothing re-renders per mouse move. No React inside, no
 * library outside. The twelve donuts in this app cost 326KB of recharts;
 * this file is the whole cost of the replacement.
 *
 * Data is columnar, as uPlot's is: parallel arrays of values, colours and
 * labels. Colours are plain CSS colours — a canvas cannot resolve a custom
 * property.
 */

export interface DonutData {
  values: number[];
  colors: string[];
  labels: string[];
}

export interface DonutOpts {
  width: number;
  height: number;
  /** Hole radius as a fraction of the outer radius. 0 is a pie. */
  inner?: number;
  /** Gap between slices, in radians. */
  padAngle?: number;
  /** Where the first slice begins. Default is twelve o'clock. */
  startAngle?: number;
  /** How far a hovered slice lifts, in CSS pixels. */
  lift?: number;
  /** Lines to draw in the hole — a total, a caption. Recomputed on every draw. */
  center?: (d: Donut) => string[];
  cursor?: { show?: boolean };
  hooks?: {
    /** After the slices are drawn; the context is still transformed to CSS pixels. */
    draw?: Array<(d: Donut) => void>;
    /** Whenever the hovered slice changes, including to none. */
    setCursor?: Array<(d: Donut) => void>;
  };
}

export interface Slice {
  idx: number;
  start: number;
  end: number;
  /** Share of the total, 0..1. */
  frac: number;
}

const TAU = Math.PI * 2;

/** Device pixels per CSS pixel, read once like uPlot's `pxRatio`. */
export const pxRatio = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;

/**
 * The arcs, from the values. Pure, so it can be tested without a canvas:
 * zero and negative values take no arc, gaps come out of each slice rather
 * than off the total, and the arcs always close the circle.
 */
export function layout(values: number[], startAngle = -Math.PI / 2, padAngle = 0): Slice[] {
  const total = values.reduce((s, v) => s + (v > 0 ? v : 0), 0);
  if (total <= 0) return [];
  const drawn = values.filter((v) => v > 0).length;
  // A single slice has nothing to be separated from.
  const pad = drawn > 1 ? padAngle : 0;
  const out: Slice[] = [];
  let a = startAngle;
  values.forEach((v, idx) => {
    if (v <= 0) return;
    const frac = v / total;
    const span = frac * TAU;
    out.push({ idx, start: a + pad / 2, end: a + span - pad / 2, frac });
    a += span;
  });
  return out;
}

/** The angle of a point around the centre, normalised into [start, start+2π). */
export function angleOf(dx: number, dy: number, startAngle: number): number {
  let a = Math.atan2(dy, dx);
  while (a < startAngle) a += TAU;
  while (a >= startAngle + TAU) a -= TAU;
  return a;
}

export class Donut {
  readonly root: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D | null;
  opts: DonutOpts;
  data: DonutData;
  slices: Slice[] = [];
  /** Which slice the pointer is over, and where the pointer is, in CSS px. */
  cursor: { idx: number | null; left: number; top: number } = { idx: null, left: -1, top: -1 };
  private width = 0;
  private height = 0;
  private onMove = (e: MouseEvent) => {
    const r = this.canvas.getBoundingClientRect();
    this.setCursor(e.clientX - r.left, e.clientY - r.top);
  };
  private onLeave = () => this.setCursor(-1, -1);

  constructor(opts: DonutOpts, data: DonutData, el: HTMLElement) {
    this.opts = opts;
    this.data = data;
    this.root = document.createElement('div');
    this.root.className = 'd-root';
    this.root.style.cssText = 'position:relative;display:inline-block;line-height:0;';
    this.canvas = document.createElement('canvas');
    this.root.appendChild(this.canvas);
    el.appendChild(this.root);
    this.ctx = this.canvas.getContext('2d');
    if (opts.cursor?.show !== false) {
      this.canvas.addEventListener('mousemove', this.onMove);
      this.canvas.addEventListener('mouseleave', this.onLeave);
    }
    this.setSize({ width: opts.width, height: opts.height });
  }

  /** Geometry every draw and hit-test shares. */
  get geometry() {
    const r = Math.max(0, Math.min(this.width, this.height) / 2 - (this.opts.lift ?? 4) - 1);
    return {
      cx: this.width / 2,
      cy: this.height / 2,
      outer: r,
      inner: r * Math.min(Math.max(this.opts.inner ?? 0.55, 0), 0.95),
    };
  }

  setData(data: DonutData, redraw = true): void {
    this.data = data;
    this.slices = layout(data.values, this.opts.startAngle ?? -Math.PI / 2, this.opts.padAngle ?? 0.02);
    if (redraw) this.redraw();
  }

  setSize({ width, height }: { width: number; height: number }): void {
    this.width = Math.max(0, Math.floor(width));
    this.height = Math.max(0, Math.floor(height));
    // Draw at device resolution, lay out in CSS pixels — uPlot's arrangement.
    this.canvas.width = Math.round(this.width * pxRatio);
    this.canvas.height = Math.round(this.height * pxRatio);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.setData(this.data);
  }

  /** The slice under a CSS-pixel point, or null for the hole and the outside. */
  idxAt(x: number, y: number): number | null {
    const { cx, cy, outer, inner } = this.geometry;
    const dx = x - cx, dy = y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < inner || dist > outer + (this.opts.lift ?? 4)) return null;
    const start = this.opts.startAngle ?? -Math.PI / 2;
    const a = angleOf(dx, dy, start);
    // Pads belong to the slice they were taken from, so the gap is not dead.
    const pad = (this.opts.padAngle ?? 0.02) / 2;
    const hit = this.slices.find((s) => a >= s.start - pad && a < s.end + pad);
    return hit ? hit.idx : null;
  }

  setCursor(left: number, top: number): void {
    const idx = left < 0 ? null : this.idxAt(left, top);
    const changed = idx !== this.cursor.idx;
    this.cursor = { idx, left, top };
    if (changed) {
      this.redraw();
      for (const fn of this.opts.hooks?.setCursor ?? []) fn(this);
    }
  }

  redraw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { cx, cy, outer, inner } = this.geometry;
    const lift = this.opts.lift ?? 4;
    ctx.save();
    ctx.setTransform(pxRatio, 0, 0, pxRatio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    for (const s of this.slices) {
      const hovered = s.idx === this.cursor.idx;
      const ro = outer + (hovered ? lift : 0);
      ctx.beginPath();
      ctx.arc(cx, cy, ro, s.start, s.end);
      ctx.arc(cx, cy, inner, s.end, s.start, true);
      ctx.closePath();
      ctx.fillStyle = this.data.colors[s.idx] ?? '#888';
      ctx.globalAlpha = this.cursor.idx == null || hovered ? 1 : 0.55;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const center = this.opts.center?.(this);
    if (center?.length) {
      ctx.fillStyle = '#fafafa';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lineH = Math.max(12, inner * 0.28);
      center.forEach((line, i) => {
        ctx.font = `${i === 0 ? 'bold ' : ''}${i === 0 ? lineH : lineH * 0.7}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = i === 0 ? '#fafafa' : '#a1a1aa';
        ctx.fillText(line, cx, cy + (i - (center.length - 1) / 2) * lineH * 1.1);
      });
    }
    for (const fn of this.opts.hooks?.draw ?? []) fn(this);
    ctx.restore();
  }

  destroy(): void {
    this.canvas.removeEventListener('mousemove', this.onMove);
    this.canvas.removeEventListener('mouseleave', this.onLeave);
    this.root.remove();
  }
}
