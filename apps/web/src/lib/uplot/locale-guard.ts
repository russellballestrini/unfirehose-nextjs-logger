/**
 * Make `navigator.language` a tag Intl accepts, before uPlot loads.
 *
 * uPlot runs `new Intl.NumberFormat(navigator.language)` in its module body.
 * A browser started under a POSIX locale (LANG=C, seen in headless Chromium)
 * can report `en-US@posix`, which is not BCP 47, and that line throws
 * `RangeError: Invalid language tag` while the page's bundle is still
 * loading: every chart page goes dark. This module has no imports, so in
 * ESM it evaluates before any module listed after it; `./index.ts` imports
 * it first and uPlot second.
 */

function isValid(tag: string): boolean {
  try {
    return Intl.getCanonicalLocales(tag).length > 0;
  } catch {
    return false;
  }
}

/** A tag Intl accepts, made from what the browser reported. */
export function normaliseLanguageTag(tag: unknown): string {
  if (typeof tag === 'string' && tag) {
    if (isValid(tag)) return tag;
    // `en_US.UTF-8@posix` -> `en-US`: drop the modifier and the codeset,
    // and swap POSIX's underscore for BCP 47's hyphen.
    const stripped = tag.split('@')[0].split('.')[0].replace(/_/g, '-');
    if (stripped && isValid(stripped)) return stripped;
  }
  return 'en-US';
}

/** Patch navigator.language (and .languages) in place when invalid. */
export function guardNavigatorLanguage(
  nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator,
): void {
  if (!nav) return;
  let lang: unknown;
  try { lang = nav.language; } catch { return; }
  // A runtime without the property (no DOM) has nothing for uPlot to read.
  if (lang === undefined) return;
  const fixed = normaliseLanguageTag(lang);
  if (fixed !== lang) {
    try { Object.defineProperty(nav, 'language', { value: fixed, configurable: true }); } catch { /* frozen: nothing more to do */ }
  }
  let langs: unknown;
  try { langs = nav.languages; } catch { return; }
  if (Array.isArray(langs) && langs.some((l) => normaliseLanguageTag(l) !== l)) {
    const fixedList = Object.freeze(langs.map(normaliseLanguageTag));
    try { Object.defineProperty(nav, 'languages', { value: fixedList, configurable: true }); } catch { /* as above */ }
  }
}

guardNavigatorLanguage();
