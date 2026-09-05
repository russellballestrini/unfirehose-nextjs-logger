'use client';

import { useState, useRef } from 'react';
import useSWR from 'swr';
import { fetcher } from '@unturf/unfirehose-ui/fetcher';

/**
 * One accent-colour picker, shared by settings and our styleguide.
 *
 * Both pages had their own copy. That is a worse defect here than it
 * sounds: a styleguide whose colour picker is a fork of the real one
 * stops being a styleguide. It documents a component that no longer
 * exists, and a change to the real picker silently leaves the reference
 * behind — which is exactly backwards from what the page is for.
 */

/** HSL to a hex triplet. The slider works in hue; settings are stored as hex. */
export function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Hex back to a hue, so a stored colour can position the slider. */
export function hexToHue(hex: string): number {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let hue = 0;
  if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) hue = ((b - r) / d + 2) * 60;
  else hue = ((r - g) / d + 4) * 60;
  return Math.round(hue);
}

/** Saturation and lightness the slider holds fixed, so its gradient matches its output. */
const SLIDER_S = 0.7, SLIDER_L = 0.55;
/** Thirteen stops, one per 30°, closing the circle back on red. */
const HUE_STOPS = 13;

export const RED_PRESETS = [
  { label: 'unfirehose', hex: '#d40000', desc: 'Deep vermilion — our pivot' },
  { label: 'Netflix', hex: '#e50914', desc: 'Streaming red' },
  { label: 'YouTube', hex: '#ff0000', desc: 'Pure saturated' },
  { label: 'Oxblood', hex: '#800020', desc: 'Dark, luxurious' },
  { label: 'Crimson', hex: '#dc143c', desc: 'Classic warm red' },
  { label: 'Brick', hex: '#cb4154', desc: 'Earthy, grounded' },
];

/** The tonal steps our CSS derives from the accent. Read live, never hardcoded. */
export const TONAL_STEPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];

export function normaliseHex(text: string): string | null {
  const clean = text.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length === 6) return '#' + clean.toLowerCase();
  if (clean.length === 3) return '#' + clean.split('').map(c => c + c).join('').toLowerCase();
  return null;
}

/** Our own red, when settings have not loaded or hold something unusable. */
export const DEFAULT_ACCENT = '#d40000';

export function HexColorPicker({
  value,
  settingKey,
  showTonalScale = true,
}: { value?: string | null; settingKey: string; showTonalScale?: boolean }) {
  // Settings arrive over SWR, so this mounts before there is a colour, and a
  // stored value can be anything a past version wrote. Both call sites had
  // their own `?? '#d40000'`; keeping the guard here means neither can forget.
  const initial = normaliseHex(String(value ?? '')) ?? DEFAULT_ACCENT;
  const [color, setColor] = useState(initial);
  const [hexText, setHexText] = useState(initial.replace('#', ''));
  const hexRef = useRef(initial.replace('#', ''));
  const { mutate: mutateSettings } = useSWR('/api/settings', fetcher);

  const hue = hexToHue(color);

  function save(hex: string) {
    const clean = hex.startsWith('#') ? hex : '#' + hex;
    setColor(clean);
    setHexText(clean.replace('#', ''));
    hexRef.current = clean.replace('#', '');
    document.documentElement.style.setProperty('--color-accent', clean);
    document.documentElement.style.setProperty('--color-assistant', clean);
    // Optimistic SWR update — prevents ThemeProvider from overwriting with stale value
    // revalidate: false avoids refetch that would cause parent re-render / scroll jump
    mutateSettings((prev: Record<string, string> | undefined) => ({ ...prev, [settingKey]: clean }), { revalidate: false });
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set', key: settingKey, value: clean }),
    });
  }

  function tryCommit(text: string) {
    const hex = normaliseHex(text);
    if (hex) save(hex);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg border border-[var(--color-border)]" style={{ backgroundColor: color }} />
        <div className="flex items-center gap-1">
          <span className="text-base text-[var(--color-muted)]">#</span>
          <input
            type="text"
            value={hexText}
            onChange={(e) => {
              const v = e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
              setHexText(v);
              hexRef.current = v;
            }}
            onBlur={() => tryCommit(hexRef.current)}
            onKeyDown={(e) => { if (e.key === 'Enter') tryCommit(hexRef.current); }}
            className="w-24 bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1.5 text-base font-mono"
            maxLength={6}
            spellCheck={false}
            aria-label="Accent colour hex"
          />
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={360}
        value={hue}
        onChange={(e) => save(hslToHex(Number(e.target.value), SLIDER_S, SLIDER_L))}
        className="w-full h-3 rounded-full appearance-none cursor-pointer"
        aria-label="Accent hue"
        style={{
          background: `linear-gradient(to right, ${Array.from({ length: HUE_STOPS }, (_, i) => hslToHex(i * 30, SLIDER_S, SLIDER_L)).join(', ')})`,
        }}
      />
      <div className="space-y-2">
        <span className="text-sm text-[var(--color-muted)]">Brand reds</span>
        <div className="flex flex-wrap gap-2">
          {RED_PRESETS.map((p) => (
            <button
              key={p.hex}
              onClick={() => save(p.hex)}
              title={`${p.label} — ${p.desc}`}
              className={`flex items-center gap-1.5 px-2 py-1 rounded border text-sm cursor-pointer transition-colors ${
                color.toLowerCase() === p.hex.toLowerCase()
                  ? 'border-[var(--color-accent)] text-[var(--color-foreground)]'
                  : 'border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-accent)]'
              }`}
            >
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: p.hex }} />
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {showTonalScale && (
        <div className="space-y-2">
          <span className="text-sm text-[var(--color-muted)]">Tonal scale</span>
          <div className="flex gap-0.5 rounded overflow-hidden">
            {TONAL_STEPS.map((step) => (
              <div key={step} className="flex-1 text-center" title={`red-${step}`}>
                <div className="h-6" style={{ backgroundColor: `var(--color-red-${step})` }} />
                <div className="text-xs text-[var(--color-muted)] mt-0.5">{step}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
