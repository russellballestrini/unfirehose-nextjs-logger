import { describe, it, expect } from 'vitest';
import { parseNvidiaSmi, raplWatts } from './mesh-local';

/**
 * The two power readings only this machine can make, fed fixture output.
 *
 * mesh-local.test.ts runs getLocalStats against the real box, which on a
 * machine with no GPU and no RAPL (most CI runners) never reaches either
 * parser. These pin what they make of the output when it is there.
 */

describe('parseNvidiaSmi', () => {
  it('reads nothing from no output: nvidia-smi absent or failed', () => {
    expect(parseNvidiaSmi(null)).toEqual({ watts: null });
    expect(parseNvidiaSmi('')).toEqual({ watts: null });
  });

  it('reads one card', () => {
    expect(parseNvidiaSmi('245.31, NVIDIA GeForce RTX 4090, 24564, 1830, 87')).toEqual({
      watts: 245.3,
      model: 'NVIDIA GeForce RTX 4090',
      memTotalMB: 24564,
      memUsedMB: 1830,
      util: 87,
    });
  });

  it('sums power and memory across cards, keeps the first model and the busiest card', () => {
    const out = [
      '100.0, NVIDIA A100-SXM4-80GB, 81920, 1000, 20',
      '150.5, NVIDIA H100 80GB HBM3, 81920, 4000, 95',
    ].join('\n');
    expect(parseNvidiaSmi(out)).toEqual({
      watts: 250.5,
      model: 'NVIDIA A100-SXM4-80GB',
      memTotalMB: 163840,
      memUsedMB: 5000,
      util: 95,
    });
  });

  it('reads a card that does not report power as no wattage, not zero watts', () => {
    // Older and laptop GPUs print [N/A] for power.draw.
    const r = parseNvidiaSmi('[N/A], NVIDIA GeForce GTX 1050, 4096, 512, 3');
    expect(r.watts).toBeNull();
    expect(r.model).toBe('NVIDIA GeForce GTX 1050');
    expect(r.memTotalMB).toBe(4096);
    expect(r.util).toBe(3);
  });

  it('leaves fields a short line does not carry undefined', () => {
    expect(parseNvidiaSmi('75')).toEqual({ watts: 75 });
  });
});

describe('raplWatts', () => {
  it('turns microjoules over the interval into watts, summed across packages', () => {
    // 3 J and 2 J over 0.1 s = 30 W + 20 W.
    expect(raplWatts(['1000000', '5000000'], ['4000000', '7000000'], 0.1)).toBe(50);
  });

  it('unwraps a 32-bit counter that rolled over between reads', () => {
    const before = String(2 ** 32 - 500_000);
    expect(raplWatts([before], ['500000'], 0.1)).toBe(10);
  });

  it('refuses a partial sum when any package could not be read', () => {
    expect(raplWatts(['1', null], ['2', '3'], 0.1)).toBeNull();
    expect(raplWatts(['1', '2'], ['2', null], 0.1)).toBeNull();
  });

  it('rounds to one decimal', () => {
    expect(raplWatts(['0'], ['1234567'], 0.1)).toBe(12.3);
  });
});
