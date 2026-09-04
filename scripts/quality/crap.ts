/**
 * The CRAP metric itself, kept away from the report that prints it so a
 * test can hold it to the published values without running a CLI.
 *
 *   crap(f) = cc(f)² × (1 − coverage(f))³ + cc(f)
 *
 * Fully covered, a function scores exactly its complexity. Untested, it
 * scores cc² + cc, which grows fast enough that a 30-branch function nobody
 * tests lands at 930 and cannot hide in a list.
 */

export const CRAP_THRESHOLD = 30;

export function crapScore(complexity: number, coverage: number): number {
  const uncovered = 1 - Math.max(0, Math.min(1, coverage));
  return complexity ** 2 * uncovered ** 3 + complexity;
}

/** Coverage a function would need to bring its score under a threshold. */
export function coverageNeeded(complexity: number, threshold = CRAP_THRESHOLD): number | null {
  if (complexity >= threshold) return null; // No amount of testing is enough.
  const uncovered = ((threshold - complexity) / complexity ** 2) ** (1 / 3);
  return Math.max(0, 1 - uncovered);
}
