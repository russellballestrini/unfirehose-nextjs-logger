// Numbers out of command output, where every tool has its own way of
// saying "no value". Shared because four probe modules parse the same
// kinds of field and had eighteen copies of the same fallback between
// them.

/**
 * A number out of one field of command output.
 *
 * Every tool here has its own way of saying "no value": nvidia-smi prints
 * `[N/A]` for a field a card does not expose, df prints `-` for a
 * pseudo-filesystem, /proc pads with blanks. All of them parse to NaN, and
 * NaN reaches a gauge as an empty bar rather than as an error — so the
 * absence becomes a zero once, here, instead of eighteen times below.
 */
export const num = (v: string | undefined): number => {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : 0;
};

/** The same, for fields that are counts rather than measurements. */
export const int = (v: string | undefined): number => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : 0;
};
