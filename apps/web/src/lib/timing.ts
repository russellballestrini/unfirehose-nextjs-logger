/**
 * Server-Timing instrumentation helper.
 *
 * Usage:
 *   const t = new Timing();
 *   const rows = db.prepare('...').all(); t.mark('query');
 *   const enriched = await Promise.all(...); t.mark('enrich');
 *   return NextResponse.json(data, { headers: { 'Server-Timing': t.header() } });
 *
 * Each `.mark(name)` records the elapsed time since the last mark (or the
 * Timing's construction) and resets the running stopwatch. The resulting
 * `Server-Timing` header is browser-supported and surfaces in Chrome
 * DevTools → Network → Timing panel so we can see exactly where a slow
 * request spent its time.
 *
 * Server-Timing names should be short tokens (no spaces). We sanitise
 * them defensively so callers can pass human-friendly labels.
 */
export class Timing {
  private marks: Array<[string, number]> = [];
  private start = performance.now();

  mark(name: string): void {
    const elapsed = performance.now() - this.start;
    this.marks.push([sanitize(name), elapsed]);
    this.start = performance.now();
  }

  header(): string {
    return this.marks.map(([n, ms]) => `${n};dur=${ms.toFixed(1)}`).join(', ');
  }
}

function sanitize(name: string): string {
  // Server-Timing metric names must be valid token chars per RFC 7230.
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'mark';
}
