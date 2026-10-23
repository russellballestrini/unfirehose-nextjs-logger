import type uPlot from 'uplot';

/**
 * A tap equivalent for our uPlot hover readouts.
 *
 * On a phone a tap arrives as compat mouse events: mousemove (uPlot moves its
 * cursor and our readout appears), then mousedown, mouseup, click, and then
 * a mouseleave, which hides the readout again before a reader has seen it.
 * So when our last pointer was a finger or a pen, uPlot's mouseleave is
 * ignored and the readout stays on the tapped bar until the next tap moves
 * it, or a tap anywhere outside our chart clears it. A mouse behaves exactly
 * as before.
 */
export function touchHold() {
  let touch = false;
  let over: HTMLElement | null = null;
  let plot: uPlot | null = null;

  const bind: uPlot.Cursor.Bind = {
    mouseleave: (_u, _targ, handler) => (e) => (touch ? null : handler(e)),
  };

  const onDown = (e: PointerEvent) => {
    touch = e.pointerType !== 'mouse';
    if (!touch || !over || !plot) return;
    if (!over.contains(e.target as Node)) plot.setCursor({ left: -10, top: -10 });
  };

  /** Call once our chart exists; returns its cleanup. */
  function attach(u: uPlot): () => void {
    plot = u;
    over = u.over;
    // Capture on our document: a tap inside our chart and a tap outside it
    // both pass through here before any handler can stop them.
    globalThis.document?.addEventListener('pointerdown', onDown, true);
    return () => {
      globalThis.document?.removeEventListener('pointerdown', onDown, true);
      plot = null;
      over = null;
    };
  }

  return { bind, attach, isTouch: () => touch };
}
