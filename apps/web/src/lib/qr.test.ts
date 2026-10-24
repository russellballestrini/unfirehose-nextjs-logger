import { describe, it, expect } from 'vitest';
import {
  encodeQr, qrPath, rsDivisor, rsRemainder, formatBits, alignmentPositions,
  byteCapacity, dataCodewords, penalty, QrTooLong,
} from './qr';

/**
 * Our in-repo QR encoder. The golden symbol below was produced by an
 * independent encoder (uqr 0.1.2, a port of Nayuki's) for the same text,
 * level and mask, and our output matched it module for module; jsQR 1.4.0
 * decoded our symbols back to their text for 27 text × level cases. Neither
 * library is a dependency of ours: the check ran once, outside this repo,
 * and this pins its answer.
 */

const GOLDEN_TEXT = 'http://192.168.1.20:3000/';
const GOLDEN = [
  '#######..#.##.#...#######',
  '#.....#.....##.#..#.....#',
  '#.###.#.###.....#.#.###.#',
  '#.###.#.######....#.###.#',
  '#.###.#.#.#.#.#...#.###.#',
  '#.....#.###....##.#.....#',
  '#######.#.#.#.#.#.#######',
  '........#...#..#.........',
  '#.#####..##.##.##.#####..',
  '....#...##.#.##..#.....#.',
  '...#..###.##.#.#..##.#.##',
  '#..##..#.#..#...#...#...#',
  '.##.###..#.###....###.###',
  '#..##..#.##...#......#.#.',
  '#...######.###.#.#.#.#.##',
  '#..#.#..#.##..##.....#..#',
  '#.#...#...####..#####.#..',
  '........##..#.#.#...###..',
  '#######..##.....#.#.#####',
  '#.....#.#.##...##...##.##',
  '#.###.#.######.########..',
  '#.###.#.#.###.###.###.###',
  '#.###.#.###.#....#....#.#',
  '#.....#..#..#...#.####..#',
  '#######.#....#.#.########',
];

const draw = (m: boolean[][]) => m.map((row) => row.map((v) => (v ? '#' : '.')).join(''));

describe('Reed–Solomon', () => {
  // The worked example every QR tutorial uses: "HELLO WORLD" at 1-M.
  it('gives the known ten error-correction codewords for HELLO WORLD at 1-M', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsRemainder(data, rsDivisor(10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });
});

describe('tables', () => {
  it('knows the format bits from the standard', () => {
    expect(formatBits('M', 0).toString(2).padStart(15, '0')).toBe('101010000010010');
    expect(formatBits('L', 4).toString(2).padStart(15, '0')).toBe('110011000101111');
    expect(formatBits('H', 7).toString(2).padStart(15, '0')).toBe('000100000111011');
  });

  it('places alignment patterns where the standard does', () => {
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(2)).toEqual([6, 18]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(10)).toEqual([6, 28, 50]);
  });

  it('agrees with the capacity table for byte mode', () => {
    expect(dataCodewords(1, 'M')).toBe(16);
    expect(byteCapacity(1, 'L')).toBe(17);
    expect(byteCapacity(1, 'M')).toBe(14);
    expect(byteCapacity(2, 'M')).toBe(26);
    expect(byteCapacity(10, 'M')).toBe(213);
    expect(byteCapacity(10, 'H')).toBe(119);
  });
});

describe('encodeQr', () => {
  it('draws a LAN address module for module as an independent encoder does', () => {
    const qr = encodeQr(GOLDEN_TEXT, { ecl: 'M' });
    expect(qr.version).toBe(2);
    expect(qr.size).toBe(25);
    expect(qr.mask).toBe(2);
    expect(draw(qr.modules)).toEqual(GOLDEN);
  });

  it('picks the mask with the lowest penalty', () => {
    const chosen = encodeQr(GOLDEN_TEXT);
    for (let m = 0; m < 8; m++) {
      expect(penalty(encodeQr(GOLDEN_TEXT, { mask: m }).modules)).toBeGreaterThanOrEqual(penalty(chosen.modules));
    }
  });

  it('grows the version with the text, and draws the version block from 7 up', () => {
    expect(encodeQr('x'.repeat(14)).version).toBe(1);
    expect(encodeQr('x'.repeat(15)).version).toBe(2);
    const v7 = encodeQr('x'.repeat(120));
    expect(v7.version).toBe(7);
    expect(v7.size).toBe(45);
    // Version 7's 18-bit block is 0x07C94 in the standard's table D.1,
    // read back from the copy beside the top-right finder.
    let bits = 0;
    for (let i = 17; i >= 0; i--) bits = (bits << 1) | (v7.modules[Math.floor(i / 3)][v7.size - 11 + (i % 3)] ? 1 : 0);
    expect(bits).toBe(0x07c94);
  });

  it('draws the three finders and the always-dark module', () => {
    const { modules, size } = encodeQr('http://10.0.0.5:3010/');
    const finder = ['#######', '#.....#', '#.###.#', '#.###.#', '#.###.#', '#.....#', '#######'];
    const at = (x0: number, y0: number) => finder.map((_, y) => modules[y0 + y].slice(x0, x0 + 7).map((v) => (v ? '#' : '.')).join(''));
    expect(at(0, 0)).toEqual(finder);
    expect(at(size - 7, 0)).toEqual(finder);
    expect(at(0, size - 7)).toEqual(finder);
    expect(modules[size - 8][8]).toBe(true);
  });

  it('encodes UTF-8, not UTF-16', () => {
    // 'ü' is two bytes, so 13 of them need 26 bytes: version 2 at level M.
    expect(encodeQr('ü'.repeat(13)).version).toBe(2);
    expect(encodeQr('ü'.repeat(14)).version).toBe(3);
  });

  it('refuses text past version 10 rather than drawing a broken code', () => {
    expect(() => encodeQr('x'.repeat(214))).toThrow(QrTooLong);
  });
});

describe('qrPath', () => {
  it('draws one rectangle per dark run, offset by the quiet zone', () => {
    const qr = { version: 1, size: 3, ecl: 'M' as const, mask: 0, modules: [[true, true, false], [false, false, false], [false, true, false]] };
    expect(qrPath(qr, 4)).toBe('M4,4h2v1h-2zM5,6h1v1h-1z');
  });
});
