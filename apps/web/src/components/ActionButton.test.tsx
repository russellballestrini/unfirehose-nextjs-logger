// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ActionButton, type ActionState } from './ActionButton';

/**
 * A button that runs something and reports how it went.
 *
 * Two of these were written out longhand on our usage page, each with two
 * three-way ternary chains — four chains for one idea, and the two copies
 * had already drifted apart in their colours.
 */

const labels = { idle: 'Do it', pending: 'Doing...', done: 'Done', error: 'Failed' };
const btn = () => screen.getByRole('button');
afterEach(cleanup);

const show = (state: ActionState, over = {}) =>
  render(<ActionButton state={state} onClick={vi.fn()} labels={labels} {...over} />);

describe('what it says', () => {
  it('shows the label for the state it is in', () => {
    for (const [kind, text] of Object.entries(labels)) {
      cleanup();
      show(kind === 'error' ? { kind: 'error', msg: 'boom' } : { kind } as ActionState);
      expect(btn().textContent).toBe(text);
    }
  });

  it('styles each state differently, so the outcome is visible without reading', () => {
    const classes = new Set<string>();
    for (const kind of ['idle', 'pending', 'done', 'error'] as const) {
      cleanup();
      show(kind === 'error' ? { kind: 'error', msg: 'boom' } : { kind } as ActionState);
      classes.add(btn().className);
    }
    expect(classes.size).toBe(4);
  });

  it('keeps the caller\'s own classes alongside its own', () => {
    show({ kind: 'idle' }, { className: 'text-xs px-2' });
    expect(btn().className).toContain('text-xs');
    expect(btn().className).toContain('px-2');
  });
});

describe('clicking', () => {
  it('runs the action', () => {
    const onClick = vi.fn();
    render(<ActionButton state={{ kind: 'idle' }} onClick={onClick} labels={labels} />);
    fireEvent.click(btn());
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('refuses while the action is already running', () => {
    // Both call sites disabled on pending by hand. Enforcing it here means
    // a third one cannot forget and fire the request twice.
    const onClick = vi.fn();
    render(<ActionButton state={{ kind: 'pending' }} onClick={onClick} labels={labels} />);
    expect(btn()).toBeDisabled();
    fireEvent.click(btn());
    expect(onClick).not.toHaveBeenCalled();
  });

  it('honours a caller that disables it for its own reasons', () => {
    // Acknowledge-all is disabled when there is nothing to acknowledge.
    show({ kind: 'idle' }, { disabled: true });
    expect(btn()).toBeDisabled();
  });

  it('is clickable again after it finished', () => {
    const onClick = vi.fn();
    render(<ActionButton state={{ kind: 'done' }} onClick={onClick} labels={labels} />);
    fireEvent.click(btn());
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('is clickable again after it failed, so a retry needs no reload', () => {
    const onClick = vi.fn();
    render(<ActionButton state={{ kind: 'error', msg: 'boom' }} onClick={onClick} labels={labels} />);
    fireEvent.click(btn());
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('the tooltip', () => {
  it('carries the error, so a truncated label is still readable', () => {
    show({ kind: 'error', msg: 'the server said 503' });
    expect(btn().title).toBe('the server said 503');
  });

  it('shows the caller\'s explanation the rest of the time', () => {
    show({ kind: 'idle' }, { title: 'what this does' });
    expect(btn().title).toBe('what this does');
  });

  it('lets an error displace the caller\'s explanation', () => {
    // What just went wrong matters more than what the button is for.
    show({ kind: 'error', msg: 'boom' }, { title: 'what this does' });
    expect(btn().title).toBe('boom');
  });
});
