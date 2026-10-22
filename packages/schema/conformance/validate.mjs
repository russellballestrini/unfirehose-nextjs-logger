#!/usr/bin/env node
/**
 * unfirehose/1.0 conformance check — validates JSONL lines against our
 * JSON Schemas (draft 2020-12).
 *
 *   node conformance/validate.mjs session.jsonl [more.jsonl ...]
 *   npm run validate -w packages/schema -- session.jsonl
 *
 * Each line is routed to a schema by its `type`. A line whose `$schema` is
 * not `unfirehose/1.0` is a harness-native line, not a claim of
 * conformance, so it is counted and skipped rather than failed. A
 * conforming line with a `type` this version defines in types.d.ts but has
 * no JSON Schema for (see TYPES_WITHOUT_SCHEMA) is reported as unchecked.
 * Unknown types fail here: a reader ignores what it cannot route (SPEC.md,
 * "Readers"), but a writer emitting a type no version defines has a defect
 * or is ahead of its spec.
 *
 * Exit status: 0 when every checked line passes, 1 otherwise, 2 on usage.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const SPEC_VERSION = 'unfirehose/1.0';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_DIR = path.resolve(here, '..', 'json-schema');

/** `type` value → schema file. Every `run.*` event shares one schema. */
export const SCHEMA_FOR_TYPE = {
  session: 'session.json',
  message: 'message.json',
  todo: 'todo.json',
  project: 'project.json',
  metric: 'metric.json',
  datapoint: 'datapoint.json',
  tool_definition: 'tool-definition.json',
  throttle: 'throttle.json',
  'run.start': 'training-run-event.json',
  'run.loss': 'training-run-event.json',
  'run.sample': 'training-run-event.json',
  'run.checkpoint': 'training-run-event.json',
  'run.eval': 'training-run-event.json',
  'run.end': 'training-run-event.json',
};

/** Typed in types.d.ts with no JSON Schema yet, so nothing checks their shape. */
export const TYPES_WITHOUT_SCHEMA = new Set(['todo_event', 'alert_threshold']);

export function loadSchemas(dir = SCHEMA_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: f, schema: JSON.parse(readFileSync(path.join(dir, f), 'utf8')) }));
}

/**
 * Build a validator. Returns `check(obj)` → `{ status, schema?, errors? }`,
 * status one of `pass`, `fail`, `skipped` (not unfirehose/1.0) or
 * `unchecked` (a known type with no JSON Schema).
 */
export function createValidator(dir = SCHEMA_DIR) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const idFor = {};
  for (const { file, schema } of loadSchemas(dir)) {
    ajv.addSchema(schema);
    idFor[file] = schema.$id;
  }
  const compiled = {};
  const get = (file) => (compiled[file] ??= ajv.getSchema(idFor[file]));

  return function check(obj) {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      return { status: 'fail', errors: ['line is not a JSON object'] };
    }
    if (obj.$schema !== SPEC_VERSION) return { status: 'skipped' };
    const file = SCHEMA_FOR_TYPE[obj.type];
    if (!file) {
      if (TYPES_WITHOUT_SCHEMA.has(obj.type)) return { status: 'unchecked' };
      return { status: 'fail', errors: [`unknown type ${JSON.stringify(obj.type)}`] };
    }
    const validate = get(file);
    if (validate(obj)) return { status: 'pass', schema: file };
    return {
      status: 'fail',
      schema: file,
      errors: validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`),
    };
  };
}

/** Validate JSONL text. Blank lines and `#` comment lines are ignored. */
export function validateJsonl(text, check = createValidator()) {
  const results = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      results.push({ line: i + 1, status: 'fail', errors: [`unparseable: ${e.message}`] });
      return;
    }
    results.push({ line: i + 1, ...check(obj) });
  });
  return results;
}

function main(files) {
  if (files.length === 0) {
    console.error('usage: node conformance/validate.mjs <file.jsonl> [...]');
    return 2;
  }
  const check = createValidator();
  let failed = 0;
  for (const file of files) {
    const results = validateJsonl(readFileSync(file, 'utf8'), check);
    const count = (s) => results.filter((r) => r.status === s).length;
    for (const r of results) {
      if (r.status !== 'fail') continue;
      failed++;
      console.log(`${file}:${r.line} FAIL${r.schema ? ` (${r.schema})` : ''}`);
      for (const e of r.errors) console.log(`  ${e}`);
    }
    console.log(
      `${file}: ${count('pass')} pass, ${count('fail')} fail, ` +
        `${count('unchecked')} unchecked, ${count('skipped')} not ${SPEC_VERSION}`,
    );
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
