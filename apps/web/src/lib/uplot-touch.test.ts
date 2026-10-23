// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import type uPlot from '@/lib/uplot';
import { touchHold } from './uplot-touch';

/**
 * A tap shows a chart's readout and leaves it up: uPlot's mouseleave, which
 * a phone sends straight after the tap's click, is ignored for a finger and
 * passed through for a mouse; a tap outside our chart clears it.
 */

function pointer(target: EventTarget, pointerType: string) {
  const e = new Event('pointerdown', { bubbles: true }) as Event & { pointerType: string };
  Object.defineProperty(e, 'pointerType', { value: pointerType });
  target.dispatchEvent(e);
}

function fakePlot() {
  const over = document.createElement('div');
  document.body.appendChild(over);
  return { over, setCursor: vi.fn() } as unknown as uPlot & { setCursor: ReturnType<typeof vi.fn> };
}

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); document.body.innerHTML = ''; });

describe('touchHold', () => {
  it('passes mouseleave through for a mouse', () => {
    const hold = touchHold();
    const u = fakePlot();
    cleanups.push(hold.attach(u));
    const handler = vi.fn(() => null);
    const listener = hold.bind.mouseleave!(u, u.over, handler)!;
    pointer(u.over, 'mouse');
    listener(new MouseEvent('mouseleave'));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(hold.isTouch()).toBe(false);
  });

  it('ignores mouseleave after a tap, so the readout stays', () => {
    const hold = touchHold();
    const u = fakePlot();
    cleanups.push(hold.attach(u));
    const handler = vi.fn(() => null);
    const listener = hold.bind.mouseleave!(u, u.over, handler)!;
    pointer(u.over, 'touch');
    expect(listener(new MouseEvent('mouseleave'))).toBeNull();
    expect(handler).not.toHaveBeenCalled();
    expect(u.setCursor).not.toHaveBeenCalled();
  });

  it('clears our cursor on a tap outside our chart', () => {
    const hold = touchHold();
    const u = fakePlot();
    cleanups.push(hold.attach(u));
    const elsewhere = document.createElement('p');
    document.body.appendChild(elsewhere);
    pointer(elsewhere, 'touch');
    expect(u.setCursor).toHaveBeenCalledWith({ left: -10, top: -10 });
  });

  it('stops listening once released', () => {
    const hold = touchHold();
    const u = fakePlot();
    hold.attach(u)();
    pointer(document.body, 'touch');
    expect(u.setCursor).not.toHaveBeenCalled();
    expect(hold.isTouch()).toBe(false);
  });
});
