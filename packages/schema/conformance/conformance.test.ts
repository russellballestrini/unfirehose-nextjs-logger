/**
 * unfirehose/1.0 conformance suite. It holds our package to what SPEC.md
 * says about it: the schemas compile under draft 2020-12 in strict mode,
 * every schema a reader may need is exported, the conformance fixtures
 * pass and fail as labelled, the strict-JSON examples in our docs
 * validate, and the chain known-answer vectors replay with nothing but
 * node:crypto — the minimum another implementation needs to match ours.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  createValidator,
  loadSchemas,
  validateJsonl,
  SCHEMA_FOR_TYPE,
  SPEC_VERSION,
} from './validate.mjs';

const PKG = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(PKG, rel), 'utf8');
const check = createValidator();

/** Schemas that only appear inside other objects, never as a line. */
const FRAGMENTS = new Set(['content-block.json', 'usage.json']);

describe('JSON Schemas', () => {
  const schemas = loadSchemas();

  // Compiling every schema is CPU work: 0.2 s on an idle four-core box and
  // 2.9 s of vitest's default 5 s with every suite at once beside 24 busy
  // processes on two cores (2026-10-23). Sized for that box with room.
  it('compile under draft 2020-12 in strict mode', () => {
    // createValidator compiles lazily; force every schema now.
    for (const type of Object.keys(SCHEMA_FOR_TYPE)) {
      expect(check({ $schema: SPEC_VERSION, type }).status, type).toBe('fail');
    }
  }, 30_000);

  it('carry an $id under our 1.0 namespace and a 2020-12 $schema', () => {
    for (const { file, schema } of schemas) {
      expect(schema.$schema, file).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema.$id, file).toBe(`https://unfirehose.org/schema/1.0/${file}`);
      expect(schema.title, file).toMatch(/^unfirehose\/1\.0 /);
    }
  });

  it('every top-level schema is routed by a type', () => {
    const routed = new Set(Object.values(SCHEMA_FOR_TYPE));
    for (const { file } of schemas) {
      if (FRAGMENTS.has(file)) continue;
      expect(routed.has(file), `${file} has no type routed to it`).toBe(true);
    }
  });

  it('every schema file is reachable through package.json exports', () => {
    const pkg = JSON.parse(read('package.json'));
    const targets = new Set(Object.values(pkg.exports as Record<string, string>));
    for (const { file } of schemas) {
      expect(targets.has(`./json-schema/${file}`), `${file} not exported`).toBe(true);
    }
  });
});

describe('conformance fixtures', () => {
  it('every line of valid.jsonl passes', () => {
    const results = validateJsonl(read('fixtures/conformance/valid.jsonl'), check);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r, `valid.jsonl:${r.line}`).toMatchObject({ status: 'pass' });
  });

  it('valid.jsonl exercises every routed type', () => {
    const seen = new Set(
      read('fixtures/conformance/valid.jsonl')
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .map((l) => JSON.parse(l).type),
    );
    for (const type of Object.keys(SCHEMA_FOR_TYPE)) expect(seen.has(type), type).toBe(true);
  });

  it('every line of invalid.jsonl fails', () => {
    const results = validateJsonl(read('fixtures/conformance/invalid.jsonl'), check);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.status, `invalid.jsonl:${r.line} passed`).toBe('fail');
  });

  it('a harness-native line is skipped, not failed', () => {
    expect(check({ type: 'user', message: { role: 'user', content: 'hi' } }).status).toBe('skipped');
  });
});

describe('doc examples', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : [];
    });
  const docs = [...walk(path.join(PKG, 'docs')), path.join(PKG, 'README.md')];
  const claims = /"\$schema"\s*:\s*"unfirehose\/1\.0"/;

  // `jsonc` blocks are field references (`"status": "active|closed"`), not
  // instances, so only strict `json` fences and single JSONL lines count.
  it('strict-JSON examples that claim unfirehose/1.0 validate', () => {
    let checked = 0;
    for (const file of docs) {
      const text = readFileSync(file, 'utf8');
      const where = (i: number) => `${path.relative(PKG, file)}:${text.slice(0, i).split('\n').length}`;
      for (const m of text.matchAll(/```json\n([\s\S]*?)```/g)) {
        if (!claims.test(m[1])) continue;
        const r = check(JSON.parse(m[1]));
        expect(['pass', 'unchecked'], `${where(m.index!)} ${r.errors ?? ''}`).toContain(r.status);
        checked++;
      }
      text.split('\n').forEach((line, i) => {
        const t = line.trim();
        if (!t.startsWith('{') || !claims.test(t)) return;
        const r = check(JSON.parse(t));
        expect(r.status, `${path.relative(PKG, file)}:${i + 1} ${r.errors ?? ''}`).toBe('pass');
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe('chain known answers (dependency-free reference)', () => {
  const records = (file: string, kind: string) =>
    read(`fixtures/${file}`)
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l))
      .filter((r) => r.kind === kind);
  const sha256 = (...parts: Buffer[]) => {
    const h = createHash('sha256');
    for (const p of parts) h.update(p);
    return h.digest();
  };

  it('unfirehose-chain-v1 line: strip the trailing hash, restore }, sha256', () => {
    const lines = records('chain-kat.jsonl', 'line');
    expect(lines.length).toBeGreaterThan(0);
    for (const r of lines) {
      const suffix = `,"hash":"${r.hash}"}`;
      expect(r.line.endsWith(suffix), r.label).toBe(true);
      const preimage = r.line.slice(0, -suffix.length) + '}';
      expect(preimage, r.label).toBe(r.preimage);
      expect(sha256(Buffer.from(preimage, 'utf8')).toString('hex'), r.label).toBe(r.hash);
    }
  });

  it('merkle-v1 leaf (0x00) and tree root (0x03, odd layer self-duplicates)', () => {
    for (const r of records('merkle-kat.jsonl', 'leaf')) {
      const leaf = sha256(Buffer.from([0x00]), Buffer.from(r.content_hex, 'hex'));
      expect(leaf.toString('hex'), r.label).toBe(r.leaf_hash_hex);
    }
    for (const r of records('merkle-kat.jsonl', 'tree')) {
      let layer: Buffer[] = r.leaf_hashes_hex.map((h: string) => Buffer.from(h, 'hex'));
      if (layer.length === 0) {
        expect(r.root_hex, r.label).toBe('0'.repeat(64));
        continue;
      }
      while (layer.length > 1) {
        const next: Buffer[] = [];
        for (let i = 0; i < layer.length; i += 2) {
          next.push(sha256(Buffer.from([0x03]), layer[i], layer[i + 1] ?? layer[i]));
        }
        layer = next;
      }
      expect(layer[0].toString('hex'), r.label).toBe(r.root_hex);
    }
  });
});
