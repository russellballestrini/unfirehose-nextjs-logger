import { describe, it, expect } from 'vitest';
import { sumNvidiaRows } from './gpu-sum';
import { parseWireProbe } from './userland/parse';

/**
 * A node is the unit we price, so a node's GPU draw is the sum of its
 * cards (ticket 4004, fox: "sum GPUs per node until nvidia-smi gives us a
 * per-process mapping").
 */
describe('sumNvidiaRows', () => {
  it('sums power and memory across every card, and keeps the busiest card', () => {
    const g = sumNvidiaRows([
      '281.40, NVIDIA GeForce RTX 3090, 24576, 21000, 97',
      '96.10, NVIDIA GeForce RTX 3090, 24576, 400, 3',
    ]);
    expect(g.watts).toBeCloseTo(377.5, 5);
    expect(g.count).toBe(2);
    expect(g.memTotalMB).toBe(49152);
    expect(g.memUsedMB).toBe(21400);
    expect(g.util).toBe(97);
    expect(g.model).toBe('NVIDIA GeForce RTX 3090');
  });

  it('a card that prints [N/A] adds nothing instead of poisoning the sum', () => {
    const g = sumNvidiaRows(['[N/A], Tesla K80, 12288, 0, 0', '149.9, Tesla K80, 12288, 100, 40']);
    expect(g.watts).toBeCloseTo(149.9, 5);
    expect(g.count).toBe(2);
  });

  it('no card with power reads as unknown, not zero watts', () => {
    expect(sumNvidiaRows(['[N/A], Tesla K80, 12288, 0, 0']).watts).toBeNull();
    expect(sumNvidiaRows([]).watts).toBeNull();
    expect(sumNvidiaRows(['', '  ']).count).toBe(0);
  });
});

describe('remote probe GPU rows', () => {
  it('a two-GPU node reports one summed draw', () => {
    const wire = [
      'uf=1',
      'GPU 250.0, NVIDIA GeForce RTX 4090, 24564, 20000, 90',
      'GPU 210.5, NVIDIA GeForce RTX 4090, 24564, 18000, 70',
      'END',
    ].join('\n');
    const node = parseWireProbe('gpu-box', wire);
    expect(node.gpuPowerWatts).toBeCloseTo(460.5, 1);
    expect(node.gpuMemTotalMB).toBe(49128);
    expect(node.gpuUtil).toBe(90);
  });
});
