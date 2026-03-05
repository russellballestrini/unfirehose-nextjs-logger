/**
 * Generate a UUIDv7 (RFC 9562) — time-ordered, sortable, no fragmentation.
 *
 * Format: xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
 *
 * Layout (128 bits):
 *   48-bit unix_ts_ms | 4-bit ver(0111) | 12-bit rand_a | 2-bit var(10) | 62-bit rand_b
 *
 * Optionally accepts a timestamp to generate deterministic UUIDs for backfill.
 */
export function uuidv7(timestampMs?: number): string {
  const ts = timestampMs ?? Date.now();

  // 48-bit timestamp → 12 hex chars
  const tsHex = ts.toString(16).padStart(12, '0');

  // Random bytes for the rest
  const rand = new Array(20);
  for (let i = 0; i < 20; i++) {
    rand[i] = ((Math.random() * 16) | 0).toString(16);
  }

  // Build: timestamp(8) - timestamp(4) + ver(1) + rand_a(3) - var(2) + rand_b(2,4) - rand_b(12)
  return [
    tsHex.slice(0, 8),                                          // time_high (8)
    tsHex.slice(8, 12),                                         // time_low (4)
    '7' + rand.slice(0, 3).join(''),                            // ver=7 + rand_a (4)
    ((0x8 | ((Math.random() * 4) | 0)).toString(16))            // var=10xx (1)
      + rand.slice(3, 6).join(''),                              // + rand_b (3) = 4
    rand.slice(6, 18).join(''),                                 // rand_b (12)
  ].join('-');
}

/**
 * Extract unix timestamp (ms) from a UUIDv7 string.
 */
export function uuidv7Timestamp(uuid: string): number {
  const clean = uuid.replace(/-/g, '');
  return parseInt(clean.slice(0, 12), 16);
}
