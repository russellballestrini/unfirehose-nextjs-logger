import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { gaugeColor, GaugeTrack, GaugePill, UTILISATION, SATURATION } from './Gauge';

// The container is itself a div, so `div > div` would match the track.
const fillOf = (container: HTMLElement) =>
  container.firstElementChild!.firstElementChild as HTMLElement;

describe('gaugeColor', () => {
  it('turns yellow then red as a thing fills up', () => {
    expect(gaugeColor(10)).toBe('var(--color-accent)');
    expect(gaugeColor(70)).toBe('#eab308');
    expect(gaugeColor(90)).toBe('#ef4444');
  });

  it('treats each threshold as the last good value', () => {
    // Exactly 60% is not yet a warning; 60.1 is.
    expect(gaugeColor(UTILISATION.warn)).toBe('var(--color-accent)');
    expect(gaugeColor(UTILISATION.danger)).toBe('#eab308');
  });

  it('sounds the alarm far earlier for saturation than for utilisation', () => {
    // A machine with half its cores committed is already queueing work,
    // while half a disk is unremarkable. Same bar, different question.
    expect(gaugeColor(55, SATURATION)).toBe('#ef4444');
    expect(gaugeColor(55, UTILISATION)).toBe('var(--color-accent)');
  });
});

describe('GaugeTrack', () => {
  it('fills in proportion', () => {
    const { container } = render(<GaugeTrack pct={40} />);
    expect(fillOf(container)).toHaveStyle({ width: '40%' });
  });

  it('clamps rather than spilling its row', () => {
    // A percentage from a stale or zero denominator can arrive above 100,
    // and a fill wider than its track breaks the layout around it.
    expect(fillOf(render(<GaugeTrack pct={140} />).container)).toHaveStyle({ width: '100%' });
    expect(fillOf(render(<GaugeTrack pct={-20} />).container)).toHaveStyle({ width: '0%' });
  });

  it('lets a caller keep its own colour', () => {
    const { container } = render(<GaugeTrack pct={95} color="#60a5fa" />);
    // Even at 95%, an explicit colour wins — the series is not an alarm.
    expect(fillOf(container)).toHaveStyle({ backgroundColor: '#60a5fa' });
  });
});

describe('GaugePill', () => {
  it('reads a figure against its ceiling', () => {
    const { container } = render(<GaugePill label="1m" value={8} max={16} />);
    const fill = container.querySelector('.flex-1')!.firstElementChild as HTMLElement;
    expect(fill).toHaveStyle({ width: '50%' });
    expect(container.textContent).toContain('8.0');
  });

  it('reads an unknown ceiling as empty rather than dividing by zero', () => {
    const { container } = render(<GaugePill label="1m" value={4} max={0} />);
    const fill = container.querySelector('.flex-1')!.firstElementChild as HTMLElement;
    expect(fill).toHaveStyle({ width: '0%' });
    expect(container.textContent).toContain('4.0');
  });
});
