// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { hslToHex, hexToHue, normaliseHex, RED_PRESETS, TONAL_STEPS, DEFAULT_ACCENT, HexColorPicker } from './HexColorPicker';

vi.mock('swr', () => ({ default: () => ({ data: undefined, mutate: vi.fn() }) }));

/**
 * Our accent picker's colour maths.
 *
 * Settings and our styleguide each had a copy of this. A styleguide whose
 * picker is a fork of the real one stops being a styleguide — it documents
 * a component that no longer exists.
 */

describe('hslToHex', () => {
  it('puts red at 0 degrees and again at 360, so the slider closes its circle', () => {
    expect(hslToHex(0, 0.7, 0.55)).toBe(hslToHex(360, 0.7, 0.55));
  });

  it('is grey at zero saturation, whatever the hue', () => {
    expect(hslToHex(0, 0, 0.5)).toBe(hslToHex(210, 0, 0.5));
  });

  it('emits six hex digits with a leading hash', () => {
    for (const h of [0, 37, 180, 359]) {
      expect(hslToHex(h, 0.7, 0.55)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('pads a single-digit channel, so #0a does not collapse to #a', () => {
    // Math.round(...).toString(16) gives 'a' for 10. Unpadded, the string
    // is five characters and every colour after it shifts.
    expect(hslToHex(0, 1, 0.02)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('hexToHue', () => {
  it('round-trips the hue the slider produced', () => {
    // This is the invariant the picker rests on: a stored hex must put the
    // slider handle back where the user left it.
    for (const h of [0, 30, 90, 150, 210, 270, 330]) {
      expect(hexToHue(hslToHex(h, 0.7, 0.55))).toBe(h);
    }
  });

  it('reads a three-digit hex the same as its expanded form', () => {
    expect(hexToHue('#f00')).toBe(hexToHue('#ff0000'));
  });

  it('calls grey zero rather than dividing by a zero range', () => {
    expect(hexToHue('#808080')).toBe(0);
    expect(hexToHue('#000000')).toBe(0);
    expect(hexToHue('#ffffff')).toBe(0);
  });

  it('tolerates a hex with no leading hash', () => {
    expect(hexToHue('ff0000')).toBe(hexToHue('#ff0000'));
  });
});

describe('normaliseHex', () => {
  it('expands three digits to six', () => {
    expect(normaliseHex('f00')).toBe('#ff0000');
  });

  it('lowercases, so a preset compares equal however it was typed', () => {
    // The preset buttons highlight on a lowercase comparison. Storing
    // uppercase would leave the active preset looking unselected.
    expect(normaliseHex('D40000')).toBe('#d40000');
  });

  it('strips what is not a hex digit', () => {
    expect(normaliseHex('#d4:00/00')).toBe('#d40000');
  });

  it('refuses a length it cannot expand, rather than saving a broken colour', () => {
    // Half-typed input reaches this on every blur. Saving '#d400' would
    // write an invalid custom property and blank the accent everywhere.
    for (const bad of ['', 'd', 'd4', 'd400', 'd4000', 'd4000000']) {
      expect(normaliseHex(bad)).toBeNull();
    }
  });
});

describe('the palette we ship', () => {
  it('offers presets that are all valid six-digit hexes', () => {
    for (const p of RED_PRESETS) expect(p.hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('names our own red first', () => {
    expect(RED_PRESETS[0]).toMatchObject({ label: 'unfirehose', hex: '#d40000' });
  });

  it('lists the tonal steps our CSS actually defines', () => {
    expect(TONAL_STEPS).toEqual(['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950']);
  });
});

describe('mounting before settings have arrived', () => {
  afterEach(cleanup);

  it('shows our own red rather than throwing on an absent value', () => {
    // Settings come over SWR: this mounts with value undefined on the first
    // paint of every reload. Reading .replace off it threw.
    render(<HexColorPicker settingKey="theme_accent_color" />);
    expect((screen.getByLabelText('Accent colour hex') as HTMLInputElement).value)
      .toBe(DEFAULT_ACCENT.replace('#', ''));
  });

  it('falls back rather than trusting a stored value it cannot parse', () => {
    // A past version, or a hand-edited settings row, can hold anything.
    render(<HexColorPicker settingKey="theme_accent_color" value="not-a-colour" />);
    expect((screen.getByLabelText('Accent colour hex') as HTMLInputElement).value)
      .toBe(DEFAULT_ACCENT.replace('#', ''));
  });

  it('expands a stored three-digit hex on mount', () => {
    render(<HexColorPicker settingKey="theme_accent_color" value="#f00" />);
    expect((screen.getByLabelText('Accent colour hex') as HTMLInputElement).value).toBe('ff0000');
  });

  it('positions the hue slider from the stored colour', () => {
    render(<HexColorPicker settingKey="theme_accent_color" value="#00ff00" />);
    expect((screen.getByLabelText('Accent hue') as HTMLInputElement).value).toBe('120');
  });
});
