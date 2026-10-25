/**
 * A QR code encoder, small on purpose: byte mode, versions 1 to 10, any of
 * the four error-correction levels. Enough for a LAN address such as
 * `http://192.168.1.20:3000/` (version 2 at level M), and up to 213 bytes at
 * level M, which no URL of ours comes near.
 *
 * Written from ISO/IEC 18004 rather than pulled in: the Settings → Phone tab
 * is its only caller, it draws one short URL, and a dependency would be the
 * larger, less legible half of the feature. No network, no canvas: our
 * caller gets a matrix and draws it as SVG.
 *
 * Steps, in the standard's order: encode the bytes into data codewords, add
 * Reed–Solomon error correction per block, interleave the blocks, draw the
 * function patterns, place the codewords in the zigzag, then try all eight
 * masks and keep the one with the lowest penalty.
 */

export type Ecl = 'L' | 'M' | 'Q' | 'H';

export interface QrCode {
  version: number;
  size: number;
  ecl: Ecl;
  mask: number;
  /** modules[y][x], true is dark. */
  modules: boolean[][];
}

export const MAX_VERSION = 10;

const ECL_INDEX: Record<Ecl, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** The two format bits each level writes, from the standard's table 12. */
const ECL_FORMAT_BITS: Record<Ecl, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Index 0 unused; one row per level L, M, Q, H; versions 1..10 (table 9).
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
];
const NUM_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
];

/** Modules left for data and error correction once every function pattern is drawn. */
function rawDataModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

export function dataCodewords(ver: number, ecl: Ecl): number {
  const e = ECL_INDEX[ecl];
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[e][ver] * NUM_BLOCKS[e][ver];
}

/** Byte-mode capacity in bytes: 4 mode bits and an 8- or 16-bit count come first. */
export function byteCapacity(ver: number, ecl: Ecl): number {
  const countBits = ver <= 9 ? 8 : 16;
  return Math.floor((dataCodewords(ver, ecl) * 8 - 4 - countBits) / 8);
}

// ---- Reed–Solomon over GF(2^8), polynomial x^8 + x^4 + x^3 + x^2 + 1 ----

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Generator polynomial of the given degree, highest term dropped (it is always 1). */
export function rsDivisor(degree: number): number[] {
  const out = new Array<number>(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < degree) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return out;
}

/** The error-correction codewords for one block: the remainder of data · x^n divided by our generator. */
export function rsRemainder(data: number[], divisor: number[]): number[] {
  const out = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (out.shift() as number);
    out.push(0);
    divisor.forEach((coef, i) => { out[i] ^= gfMul(coef, factor); });
  }
  return out;
}

// ---- Data codewords ----

function encodeData(bytes: Uint8Array, ver: number, ecl: Ecl): number[] {
  const bits: number[] = [];
  const put = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4); // byte mode
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(ver, ecl) * 8;
  put(0, Math.min(4, capacity - bits.length)); // terminator
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

/** Split into blocks, append each block's error correction, interleave. */
function addEccAndInterleave(data: number[], ver: number, ecl: Ecl): number[] {
  const e = ECL_INDEX[ecl];
  const numBlocks = NUM_BLOCKS[e][ver];
  const eccLen = ECC_PER_BLOCK[e][ver];
  const raw = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);

  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    // Short blocks carry a placeholder so every block has the same length
    // while interleaving; it is skipped below.
    if (i < numShort) dat.push(0);
    blocks.push([...dat, ...ecc]);
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) out.push(block[i]);
    });
  }
  return out;
}

// ---- Drawing ----

export function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const num = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = Math.ceil((ver * 4 + 4) / (num * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < num; pos -= step) out.splice(1, 0, pos);
  return out;
}

class Grid {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];
  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }
  fn(x: number, y: number, dark: boolean) {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }
}

function drawFinder(g: Grid, cx: number, cy: number) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= g.size || y >= g.size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      g.fn(x, y, d !== 2 && d !== 4);
    }
  }
}

function drawAlignment(g: Grid, cx: number, cy: number) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) g.fn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
}

export function formatBits(ecl: Ecl, mask: number): number {
  const data = (ECL_FORMAT_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormat(g: Grid, ecl: Ecl, mask: number) {
  const bits = formatBits(ecl, mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  const n = g.size;
  for (let i = 0; i <= 5; i++) g.fn(8, i, bit(i));
  g.fn(8, 7, bit(6));
  g.fn(8, 8, bit(7));
  g.fn(7, 8, bit(8));
  for (let i = 9; i < 15; i++) g.fn(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) g.fn(n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) g.fn(8, n - 15 + i, bit(i));
  g.fn(8, n - 8, true); // the one module that is always dark
}

function drawVersion(g: Grid) {
  if (g.version < 7) return;
  let rem = g.version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (g.version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = g.size - 11 + (i % 3), b = Math.floor(i / 3);
    g.fn(a, b, dark);
    g.fn(b, a, dark);
  }
}

function drawFunctionPatterns(g: Grid) {
  for (let i = 0; i < g.size; i++) {
    g.fn(6, i, i % 2 === 0);
    g.fn(i, 6, i % 2 === 0);
  }
  drawFinder(g, 3, 3);
  drawFinder(g, g.size - 4, 3);
  drawFinder(g, 3, g.size - 4);
  const pos = alignmentPositions(g.version);
  const last = pos.length - 1;
  pos.forEach((y, i) => pos.forEach((x, j) => {
    // The three corners are finders already.
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    drawAlignment(g, x, y);
  }));
  drawFormat(g, 'L', 0); // reserve; overwritten once our mask is chosen
  drawVersion(g);
}

function drawCodewords(g: Grid, data: number[]) {
  let i = 0;
  for (let right = g.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip our vertical timing column
    for (let vert = 0; vert < g.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? g.size - 1 - vert : vert;
        if (!g.isFunction[y][x] && i < data.length * 8) {
          g.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(g: Grid, mask: number) {
  const m = MASKS[mask];
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      if (!g.isFunction[y][x] && m(x, y)) g.modules[y][x] = !g.modules[y][x];
    }
  }
}

const FINDER_A = [true, false, true, true, true, false, true, false, false, false, false];
const FINDER_B = [false, false, false, false, true, false, true, true, true, false, true];

/** The standard's four penalty rules; outside our symbol counts as light. */
export function penalty(modules: boolean[][]): number {
  const n = modules.length;
  let score = 0;
  const at = (x: number, y: number, vertical: boolean) => {
    const [cx, cy] = vertical ? [y, x] : [x, y];
    return cx >= 0 && cy >= 0 && cx < n && cy < n ? modules[cy][cx] : false;
  };
  for (const vertical of [false, true]) {
    for (let y = 0; y < n; y++) {
      // Rule 1: a run of five or more of one colour.
      let run = 1;
      for (let x = 1; x <= n; x++) {
        if (x < n && at(x, y, vertical) === at(x - 1, y, vertical)) { run++; continue; }
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
      // Rule 3: 1:1:3:1:1 with four light modules on one side.
      for (let x = -4; x < n; x++) {
        let a = true, b = true;
        for (let k = 0; k < 11 && (a || b); k++) {
          const v = at(x + k, y, vertical);
          if (v !== FINDER_A[k]) a = false;
          if (v !== FINDER_B[k]) b = false;
        }
        if (a) score += 40;
        if (b) score += 40;
      }
    }
  }
  // Rule 2: each 2×2 block of one colour.
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
    }
  }
  // Rule 4: how far dark strays from half, in 5% steps.
  let dark = 0;
  for (const row of modules) for (const v of row) if (v) dark++;
  const total = n * n;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return score + Math.max(0, k) * 10;
}

export class QrTooLong extends Error {}

/**
 * Encode `text` as UTF-8 in byte mode, at the smallest version that holds it.
 * `mask` forces one of the eight masks (for tests); left out, the one with
 * the lowest penalty wins.
 */
export function encodeQr(text: string, opts: { ecl?: Ecl; mask?: number } = {}): QrCode {
  const ecl = opts.ecl ?? 'M';
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (bytes.length <= byteCapacity(v, ecl)) { version = v; break; }
  }
  if (!version) throw new QrTooLong(`${bytes.length} bytes does not fit a version ${MAX_VERSION} code at level ${ecl}`);

  const codewords = addEccAndInterleave(encodeData(bytes, version, ecl), version, ecl);
  const g = new Grid(version);
  drawFunctionPatterns(g);
  drawCodewords(g, codewords);

  let mask = opts.mask ?? -1;
  if (mask < 0) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(g, m);
      drawFormat(g, ecl, m);
      const p = penalty(g.modules);
      if (p < best) { best = p; mask = m; }
      applyMask(g, m); // XOR again undoes it
    }
  }
  applyMask(g, mask);
  drawFormat(g, ecl, mask);
  return { version, size: g.size, ecl, mask, modules: g.modules };
}

/**
 * One SVG path for every dark module, with a quiet zone of `border` modules.
 * Runs of dark modules in a row become one rectangle, which keeps the path short.
 */
export function qrPath(qr: QrCode, border = 4): string {
  const parts: string[] = [];
  qr.modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let w = 1;
      while (x + w < row.length && row[x + w]) w++;
      parts.push(`M${x + border},${y + border}h${w}v1h-${w}z`);
      x += w - 1;
    }
  });
  return parts.join('');
}
