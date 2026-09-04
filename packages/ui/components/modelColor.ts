/**
 * A colour for a model, derived rather than looked up.
 *
 * Both the dashboard and the tokens page used to carry the same hardcoded map
 * of seven exact model ids. On 2026-09-04 this database held 33 distinct
 * models and the map matched NONE of the ones in current use, so every slice
 * of the model donut fell through to one grey default and the chart carried
 * no information at all. A list of exact ids cannot win: a model ships, the
 * list does not know it, and the chart quietly goes monochrome.
 *
 * So: hue comes from the model FAMILY, which is stable across releases, and
 * lightness from a hash of the full id, which separates siblings. An
 * unrecognised model still gets a distinct, stable colour instead of grey.
 */

/** Family → hue. Opus purple, Sonnet green and Haiku amber match the palette
 *  these pages have used since March; the rest are spaced around the wheel so
 *  no two vendors read as the same colour. */
const FAMILY_HUE: Array<[RegExp, number]> = [
  [/opus/i, 275],
  [/sonnet/i, 158],
  [/haiku/i, 43],
  [/fable|mythos/i, 322],
  [/qwen/i, 190],
  [/hermes|nous/i, 22],
  [/gemini|google/i, 217],
  [/grok|x-ai|xai/i, 4],
  [/gpt|openai|codex/i, 168],
  [/llama/i, 248],
  [/deepseek/i, 232],
  [/mistral|mixtral/i, 18],
  [/longcat|meituan/i, 96],
  [/phi/i, 292],
  [/gemma/i, 205],
];

/** Deterministic, order-independent hash. Small and stable is all it needs. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * `hsl()` string, safe as an SVG `fill` and as a CSS `background`.
 *
 * Lightness stays between 58% and 74% so every slice reads on our dark
 * surface without washing out; saturation likewise avoids the muddy end.
 */
export function getModelColor(model: string | null | undefined): string {
  const id = (model ?? '').trim();
  if (!id) return 'hsl(220 9% 46%)';           // genuinely unknown: our muted grey

  const family = FAMILY_HUE.find(([re]) => re.test(id));
  const h = hash(id);

  if (!family) {
    // Unrecognised vendor. Spread over the whole wheel, skipping the narrow
    // band our known families cluster in only by luck — collisions here cost
    // nothing, because two unknown models are not claimed to be related.
    return `hsl(${h % 360} 62% 64%)`;
  }

  const [, hue] = family;
  // ±12° of hue and a lightness spread separate siblings (opus-5 from
  // opus-4-8) while keeping the family legible as one colour.
  const hueShift = ((h % 25) - 12);
  const light = 58 + (h % 5) * 4;
  return `hsl(${(hue + hueShift + 360) % 360} 70% ${light}%)`;
}

/** Every family hue, for a legend or a styleguide swatch row. */
export const MODEL_FAMILIES = FAMILY_HUE.map(([re, hue]) => ({
  pattern: re.source,
  hue,
}));
