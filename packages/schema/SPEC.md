# unfirehose/1.0 — Specification

An append-only JSONL format for machine learning agent session logs, so
any harness can write one shape and any tool can read every harness.

This file is our normative entry point: what a file must contain to
conform, how versions move, and how to check a file. Field-by-field
detail lives in [`docs/`](docs/README.md) and, authoritatively for shape,
in [`json-schema/`](json-schema/). Where prose and a JSON Schema disagree
on a field's shape, the JSON Schema wins and the prose is a defect.

- **Spec identifier:** `unfirehose/1.0`
- **Status:** published, open for review (ticket 3020)
- **Distribution:** npm `@unturf/unfirehose-schema`
- **Schema namespace:** `https://unfirehose.org/schema/1.0/` (each JSON
  Schema's `$id`; identifiers, not yet resolvable URLs)

## 1. Conventions

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, RECOMMENDED,
MAY and OPTIONAL are to be read as described in BCP 14 (RFC 2119,
RFC 8174) when, and only when, they appear in all capitals.

A **line** is one JSON object on one line of a JSONL file. A **writer**
produces lines; a **reader** consumes them.

## 2. Versions

Three numbers move independently. Do not read one as another.

| What | Where | Example | Moves when |
|---|---|---|---|
| Spec identifier | `$schema` on every line, `$id` path | `unfirehose/1.0` | an incompatible change (§2.2) |
| Spec revision | this file, §8 | `1.0.1` | a compatible change (§2.1) |
| Package version | `package.json` | `1.3.0` | any release of our monorepo — all four `@unturf/*` packages release together at one version |

Integrity rules carry their own identifiers and version separately
again: `hashVersion` (`unfirehose-chain-v1`), `merkleVersion`
(`merkle-v1`), `encodingVersion` (`jsonl-bytes-v1`). A rule change bumps
its own identifier, never `$schema` (see [sessions.md](docs/sessions.md#chain--unfirehose-chain-v1-optional)).

### 2.1 Compatible changes (same `$schema`, new revision)

- a new OPTIONAL field on an existing object
- a new value in an enum (as `throttle.kind` gained four in 1.0.1)
- a new object `type`
- a new content block `type`
- relaxing a constraint (a REQUIRED field becoming OPTIONAL)

Readers stay correct across these because of §3.3. Strict validators
pinned to an older revision may reject newer lines; that is why §3.3
asks readers to skip, not fail.

### 2.2 Incompatible changes (new `$schema`)

- removing or renaming a field, an enum value or a `type`
- changing a field's JSON type or meaning
- making an OPTIONAL field REQUIRED
- closing an open object (`additionalProperties: false` where it was `true`)

These ship as `unfirehose/2.0` under a new `$id` path. A reader that
does not know a `$schema` value treats the line as non-conforming input
(skip it), never as `unfirehose/1.0`.

## 3. Conformance

### 3.1 A conforming line

A line conforms to `unfirehose/1.0` when all of these hold:

1. It is a single JSON object (RFC 8259), UTF-8, terminated by LF.
2. `"$schema": "unfirehose/1.0"` is present.
3. `type` is present and names an object type in §4.
4. It validates against that type's JSON Schema under draft 2020-12,
   with `format` assertions on (`date-time`, `uri`).

A line without `$schema` is harness-native input, not a claim of
conformance. Our JSON Schemas list `$schema` as optional so a reader can
validate objects lifted out of other containers; a writer still MUST
emit it (§3.2).

### 3.2 A conforming writer (adoption tiers 1 and 2)

A writer:

- MUST emit only conforming lines (§3.1) into an unfirehose/1.0 file.
- MUST NOT rewrite or delete a line once written (append-only). A
  correction is a new line.
- MUST put message content in a block array, never a bare string.
- MUST use canonical names: `reasoning` not `thinking`, `tool-call` not
  `tool_use`, camelCase field names.
- SHOULD NOT write a second parallel log of the same session in another
  format (one source of truth; see README "Implementing the standard").
- SHOULD write a `session` line first, and a `session` line with
  `status: "closed"` last.
- SHOULD give sessions and messages UUIDv7 ids.
- SHOULD set `sessionId`, `parentId`, `timestamp` on messages and `usage`
  on assistant messages.
- SHOULD store files at `~/.{harness}/unfirehose/{project-slug}/{session-uuid}.jsonl`;
  our ingester discovers any `~/.{name}/unfirehose/` directory.
- MAY chain every line under `unfirehose-chain-v1`. A writer that
  chains MUST follow every rule in
  [sessions.md](docs/sessions.md#chain--unfirehose-chain-v1-optional) and
  MUST reproduce `fixtures/chain-kat.jsonl` and `fixtures/merkle-kat.jsonl`.

### 3.3 A conforming reader

A reader:

- MUST ignore top-level fields it does not know.
- MUST NOT reject a file because one line has an unknown `type`,
  unknown block `type`, unknown enum value or unknown `$schema`; it skips
  or degrades that line and reads the rest.
- MUST treat a missing OPTIONAL field as unknown, not as an error or a
  zero.
- SHOULD set aside a final line with no trailing LF (a line still being
  written) rather than count it as unparseable.
- SHOULD deduplicate by `id` so re-reading a file is idempotent.

### 3.4 Open and closed objects

Top-level objects are open (`additionalProperties: true`): a writer MAY
add fields of its own. Content blocks and `usage` are closed: an extra
field there fails validation, because those shapes are shared with
provider SDKs and a stray key there is almost always an untranslated
provider field. No naming convention for extension fields exists yet
(see ticket 3020, proposal P4).

## 4. Object types

| `type` | JSON Schema | REQUIRED fields | Doc |
|---|---|---|---|
| `session` | `session.json` | `type`, `id` | [sessions](docs/sessions.md) |
| `message` | `message.json` | `type`, `role`, `content` | [messages](docs/messages.md) |
| `todo` | `todo.json` | `type`, `content`, `status` | [todos](docs/todos.md) |
| `project` | `project.json` | `type`, `id` | [projects](docs/projects.md) |
| `metric` | `metric.json` | `type`, `window`, `usage` | [metrics](docs/metrics.md) |
| `datapoint` | `datapoint.json` | `type`, `metric`, `metricType`, `value`, `timestamp` | [metrics](docs/metrics.md) |
| `tool_definition` | `tool-definition.json` | `type`, `name`, `inputSchema` | [tool calls](docs/tool-calls.md) |
| `throttle` | `throttle.json` | `type`, `kind`, `timestamp` | [throttling](docs/throttling.md) |
| `run.start` `run.loss` `run.sample` `run.checkpoint` `run.eval` `run.end` | `training-run-event.json` | per event | [metrics](docs/metrics.md) |

Shared fragments, never a line of their own: `content-block.json`
(`text`, `reasoning`, `tool-call`, `tool-result`, `image`, `file`) and
`usage.json`.

Typed in `types.d.ts` with no JSON Schema yet, so §3.1 cannot be checked
for them: `todo_event`, `alert_threshold`. Documented in prose only:
`alert` ([metrics](docs/metrics.md)). Our validator reports the first two
as `unchecked`.

## 5. Validating a file

From our repository:

```bash
npm ci
npm run validate -w packages/schema -- path/to/session.jsonl
npm test -w packages/schema          # the conformance suite itself
```

`conformance/validate.mjs` routes each line to a schema by `type` and
prints a per-file tally of pass, fail, unchecked (§4) and lines without
`$schema` (skipped). It exits 1 on any failure.

From any other project, with any draft 2020-12 validator — for example
Ajv:

```js
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import message from '@unturf/unfirehose-schema/json-schema/message' with { type: 'json' };
import block from '@unturf/unfirehose-schema/json-schema/content-block' with { type: 'json' };
import usage from '@unturf/unfirehose-schema/json-schema/usage' with { type: 'json' };

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema([block, usage]);            // message.json $refs these by $id
const validate = ajv.compile(message);
validate(JSON.parse(line)) || console.error(validate.errors);
```

Fixtures shipped in this package for implementers to replay:

| File | Contract |
|---|---|
| `fixtures/conformance/valid.jsonl` | every line MUST validate; covers every routed `type` |
| `fixtures/conformance/invalid.jsonl` | every object line MUST fail; a `#` comment above each names the rule it breaks |
| `fixtures/chain-kat.jsonl` | `unfirehose-chain-v1` known answers |
| `fixtures/merkle-kat.jsonl` | `merkle-v1` known answers |

A validator that accepts any line of `invalid.jsonl` is more permissive
than our schemas; one that rejects a line of `valid.jsonl` is stricter.

## 6. Proposing changes

See [CONTRIBUTING.md](CONTRIBUTING.md).

## 7. License

`package.json` declares `AGPL-3.0-only`, our monorepo's license; the
full text is `LICENSE` at our repository root. Whether a format
specification and its JSON Schemas should carry a more permissive
license than our implementation, so closed harnesses can adopt them
without question, is an open decision (ticket 3020).

## 8. Revision history

| Revision | Change | Class |
|---|---|---|
| 1.0 | First publication as `@unturf/unfirehose-schema` 1.0.0 (2026-03-07) | — |
| 1.0 | `throttle`, `datapoint`, `run.*` training events (1.0.0 shipped eight schemas: message, session, content-block, usage, todo, project, metric, tool-definition) | compatible: new types |
| 1.0 | Optional chain fields (`prevHash`, `hash`, `hashVersion`, `merkleVersion`, `encodingVersion`, `rootSemantics`, `sessionRoot`) | compatible: new optional fields |
| 1.0.1 | `throttle.kind` gains `model_gone`, `server_error`, `timeout`, `content_policy` | compatible: new enum values |

Revisions before this file existed were not numbered consistently;
entries marked `1.0` are reconstructed from the code and docs.
