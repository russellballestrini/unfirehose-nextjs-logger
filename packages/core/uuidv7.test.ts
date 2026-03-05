import { describe, it, expect } from 'vitest';
import { uuidv7, uuidv7Timestamp } from './uuidv7';

describe('uuidv7', () => {
  it('generates a valid UUID format (8-4-4-4-12)', () => {
    const uuid = uuidv7();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('has version nibble 7', () => {
    const uuid = uuidv7();
    expect(uuid[14]).toBe('7');
  });

  it('has variant bits 10xx', () => {
    const uuid = uuidv7();
    const variantChar = uuid[19];
    expect(['8', '9', 'a', 'b']).toContain(variantChar);
  });

  it('generates unique UUIDs', () => {
    const set = new Set(Array.from({ length: 100 }, () => uuidv7()));
    expect(set.size).toBe(100);
  });

  it('is time-ordered (different timestamps)', () => {
    const a = uuidv7(1000000000000);
    const b = uuidv7(1000000000001);
    expect(a < b).toBe(true);
  });

  it('accepts custom timestamp', () => {
    const ts = 1709683200000; // 2024-03-06T00:00:00Z
    const uuid = uuidv7(ts);
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    const extracted = uuidv7Timestamp(uuid);
    expect(extracted).toBe(ts);
  });

  it('extracts timestamp from UUID', () => {
    const now = Date.now();
    const uuid = uuidv7(now);
    expect(uuidv7Timestamp(uuid)).toBe(now);
  });

  it('sorts chronologically by string comparison', () => {
    const early = uuidv7(1000000000000); // 2001
    const late = uuidv7(1800000000000);  // 2027
    expect(early < late).toBe(true);
  });
});
