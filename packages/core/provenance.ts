/**
 * Lane provenance — merkle-v1 and the unfirehose-chain-v1 line rule.
 *
 * A chained writer (uncloseai-cli's `provenance.py` is the reference)
 * ends every JSONL line with `,"hash":"<64 hex>"}` — 75 bytes, fixed —
 * where hash = SHA-256 of the line with that tail removed and a `}`
 * put back. The object carries `prevHash` (the previous line's hash,
 * null at genesis) INSIDE the hashed bytes, so a chain needs no second
 * formula; and a closed session record carries `sessionRoot`, the
 * merkle-v1 root over every prior line's hash. Verification is
 * byte-level: no canonical-JSON contract to keep in sync between the
 * Python writer and this reader.
 *
 * merkle-v1 is arborist's (and proxy.unturf.com's Go) convention: leaf
 * prefix 0x00, node prefix 0x03, non-commutative combine, an odd layer
 * self-duplicates its last element, empty root = 32 zero bytes. Both
 * are pinned by known-answer files under `packages/schema/fixtures/`
 * that the writer's own test suite replays too: the two implementations
 * agree because a test says so, never because one read the other.
 *
 * Verdicts, shared word for word with the Python verifier:
 *   unchained  no line carried a hash (an older writer)
 *   open       chained so far, no closed record yet
 *   verified   closed record present, root matched, no break
 *   corrupted  a break anywhere, or the root disagreed
 */
import { createHash } from 'crypto';

export const MERKLE_VERSION = 'merkle-v1';
export const CHAIN_VERSION = 'unfirehose-chain-v1';
/** The preimage is the exact on-disk bytes of the line; there is no canonical JSON in this chain. */
export const ENCODING_VERSION = 'jsonl-bytes-v1';
/** What a session root commits to: leaves are chained event hashes, so order and multiplicity count. */
export const ROOT_SEMANTICS = 'SEQUENCE';

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x03]);
export const ZERO_HASH = Buffer.alloc(32);

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

export function hashLeaf(content: Buffer): Buffer {
  return sha256(LEAF_PREFIX, content);
}

export function hashCombine(left: Buffer, right: Buffer): Buffer {
  if (left.length !== 32 || right.length !== 32) throw new Error('hash inputs must be 32 bytes');
  return sha256(NODE_PREFIX, left, right);
}

export interface ProofNode { hash: string; is_left: boolean }
export interface MerkleProof { leaf: string; leaf_index: number; siblings: ProofNode[]; root: string }

/** Layered tree over leaf HASHES (already domain-prefixed). */
export function buildTree(leaves: Buffer[]): Buffer[][] {
  if (leaves.length === 0) return [[]];
  const layers: Buffer[][] = [leaves.slice()];
  let current = leaves.slice();
  while (current.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = i + 1 < current.length ? current[i + 1] : current[i];
      next.push(hashCombine(left, right));
    }
    layers.push(next);
    current = next;
  }
  return layers;
}

export function treeRoot(layers: Buffer[][]): Buffer {
  const top = layers[layers.length - 1];
  return top && top.length ? top[0] : ZERO_HASH;
}

export function merkleRoot(leaves: Buffer[]): Buffer {
  return treeRoot(buildTree(leaves));
}

export function proofFor(layers: Buffer[][], leafIndex: number): MerkleProof {
  const leaves = layers[0];
  if (!leaves || leaves.length === 0) throw new Error('empty tree has no proofs');
  if (leafIndex < 0 || leafIndex >= leaves.length) throw new Error(`leaf_index ${leafIndex} out of range`);
  const siblings: ProofNode[] = [];
  let idx = leafIndex;
  for (const layer of layers.slice(0, -1)) {
    let sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
    const isLeft = idx % 2 !== 0;
    if (sibling >= layer.length) sibling = idx; // odd-element rule: self-duplicate
    siblings.push({ hash: layer[sibling].toString('hex'), is_left: isLeft });
    idx = Math.floor(idx / 2);
  }
  return {
    leaf: leaves[leafIndex].toString('hex'),
    leaf_index: leafIndex,
    siblings,
    root: treeRoot(layers).toString('hex'),
  };
}

export function verifyProof(proof: MerkleProof): boolean {
  let current: Buffer = Buffer.from(proof.leaf, 'hex');
  for (const node of proof.siblings) {
    const sib = Buffer.from(node.hash, 'hex');
    current = node.is_left ? hashCombine(sib, current) : hashCombine(current, sib);
  }
  return current.equals(Buffer.from(proof.root, 'hex'));
}

/** merkle-v1 root over line hashes (as 32-byte leaves), hex. */
export function sessionRoot(hashesHex: string[]): string {
  return merkleRoot(hashesHex.map((h) => hashLeaf(Buffer.from(h, 'hex')))).toString('hex');
}

// ── the line rule ────────────────────────────────────────────────

const HASH_KEY = ',"hash":"';
const TAIL_LEN = HASH_KEY.length + 64 + 2; // 75
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * `{ preimage, hash }` for a line in chain-v1 shape, else null. Shape
 * only — a wrong hash still splits; deciding is the verifier's job.
 * Takes the line as the string readline hands us: the tail is ASCII,
 * so string offsets and byte offsets agree there, and valid UTF-8
 * round-trips through Node's decoder unchanged.
 */
export function splitChainedLine(line: string): { preimage: Buffer; hash: string } | null {
  const trimmed = line.replace(/[\r\n]+$/, '');
  if (trimmed.length < TAIL_LEN + 1 || !trimmed.endsWith('"}')) return null;
  const tail = trimmed.slice(-TAIL_LEN);
  if (!tail.startsWith(HASH_KEY)) return null;
  const hash = tail.slice(HASH_KEY.length, -2);
  if (!HEX64.test(hash)) return null;
  return { preimage: Buffer.from(trimmed.slice(0, -TAIL_LEN) + '}', 'utf8'), hash };
}

export function lineHash(preimage: Buffer): string {
  return sha256(preimage).toString('hex');
}

export type ChainVerdict = 'unchained' | 'open' | 'verified' | 'corrupted';

export interface ChainStateData {
  entries: number;
  hashed: number;
  breaks: number;
  first_break: number | null;
  first_break_reason: string | null;
  last_hash: string | null;
  root_expected: string | null;
  root_computed: string | null;
  root_seq: number | null;
  hash_version: string | null;
  merkle_version: string | null;
  encoding_version: string | null;
  root_semantics: string | null;
}

export function emptyChainState(): ChainStateData {
  return {
    entries: 0, hashed: 0, breaks: 0, first_break: null, first_break_reason: null,
    last_hash: null, root_expected: null, root_computed: null, root_seq: null, hash_version: null,
    merkle_version: null, encoding_version: null, root_semantics: null,
  };
}

function isClosedRecord(entry: unknown): entry is {
  sessionRoot?: unknown; hashVersion?: unknown; merkleVersion?: unknown; encodingVersion?: unknown; rootSemantics?: unknown;
} {
  return !!entry && typeof entry === 'object'
    && (entry as any).type === 'session' && (entry as any).status === 'closed';
}

/**
 * Incremental verifier, one per session. `leaves` holds every claimed
 * hash so the root can be recomputed when the closed record arrives;
 * the ingester persists both between passes. Same state machine as
 * `provenance.ChainState` in uncloseai-cli.
 */
export class ChainState {
  data: ChainStateData;
  leaves: string[];

  constructor(data: ChainStateData = emptyChainState(), leaves: string[] = []) {
    this.data = data;
    this.leaves = leaves;
  }

  private break_(seq: number, reason: string) {
    this.data.breaks += 1;
    if (this.data.first_break === null) {
      this.data.first_break = seq;
      this.data.first_break_reason = reason;
    }
  }

  /** Feed one complete line. Returns the line's claimed hash, or null when unchained. */
  feed(line: string): string | null {
    const d = this.data;
    const seq = d.entries;
    d.entries += 1;
    const split = splitChainedLine(line);
    if (split === null) {
      if (d.hashed) this.break_(seq, 'unchained_line');
      return null;
    }
    let entry: unknown = null;
    try { entry = JSON.parse(split.preimage.toString('utf8')); } catch { entry = null; }
    d.hashed += 1;
    const isObject = !!entry && typeof entry === 'object' && !Array.isArray(entry);
    if (lineHash(split.preimage) !== split.hash) this.break_(seq, 'hash_mismatch');
    else if (!isObject) this.break_(seq, 'unparseable');
    else if (((entry as any).prevHash ?? null) !== d.last_hash) this.break_(seq, 'prev_mismatch');
    else if (seq && d.hashed === 1) this.break_(seq, 'late_genesis');
    if (isObject && isClosedRecord(entry) && typeof entry.sessionRoot === 'string') {
      d.root_expected = entry.sessionRoot;
      d.root_seq = seq;
      const str = (v: unknown) => (typeof v === 'string' ? v : null);
      d.hash_version = str(entry.hashVersion);
      // The rules the root was minted under (P-LANE-05/06). A record that
      // names them is checked against them; one that does not is a writer
      // from before they were named, verified under this reader's defaults.
      d.merkle_version = str(entry.merkleVersion);
      d.encoding_version = str(entry.encodingVersion);
      d.root_semantics = str(entry.rootSemantics);
      if ((d.merkle_version && d.merkle_version !== MERKLE_VERSION)
          || (d.encoding_version && d.encoding_version !== ENCODING_VERSION)
          || (d.root_semantics && d.root_semantics !== ROOT_SEMANTICS)) {
        this.break_(seq, 'unknown_rules');
      }
      d.root_computed = sessionRoot(this.leaves);
      if (d.root_computed !== d.root_expected) this.break_(seq, 'root_mismatch');
    }
    // Follow the claimed hash whatever the verdict: one bad row is one break, not N.
    d.last_hash = split.hash;
    this.leaves.push(split.hash);
    return split.hash;
  }

  get verdict(): ChainVerdict {
    const d = this.data;
    if (!d.hashed) return 'unchained';
    if (d.breaks) return 'corrupted';
    return d.root_expected !== null ? 'verified' : 'open';
  }
}

/** Verdict over one writer's complete lines (a session journal). */
export function verifyLines(lines: Iterable<string>): ChainStateData & { state: ChainVerdict } {
  const st = new ChainState();
  for (const line of lines) if (line.trim()) st.feed(line);
  return { ...st.data, state: st.verdict };
}
