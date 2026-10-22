# Proposing a change to unfirehose/1.0

unfirehose/1.0 grew from what our ingester needed to read sixteen
harnesses. It becomes a standard by taking in what other writers need.
A proposal is welcome from anyone who writes or reads these files.

## Who decides

Today: our maintainer (fox, `@fxhp` on npm) accepts or declines each
change. A wider review process — named reviewers from adopting harnesses,
a comment period — is an open question tracked in
`docs/tickets/3020-unfirehose-schema-open-standard.md`; until it is
settled, this file describes what a proposal needs, not who votes.

## Where

Open an issue or merge request against our repository
(`package.json` → `repository`; `git.unturf.com` is primary, GitHub a
mirror). Title it `schema: <short change>`.

## What a proposal contains

1. **Motivation** — what a writer or reader cannot express today, with a
   real line from a real harness where you have one.
2. **Compatibility class** — compatible or incompatible, per
   [SPEC.md §2](SPEC.md#2-versions). Incompatible changes wait for
   `unfirehose/2.0`; say so up front.
3. **Example lines** — at least one line that should pass and one that
   should fail.
4. **The change**, in every place a shape is stated, in one merge request:
   - `json-schema/*.json` (authoritative)
   - `types.d.ts`
   - the matching `docs/*.md`, using strict ```` ```json ```` fences for
     examples so our suite checks them (```` ```jsonc ```` is for field
     references like `"status": "active|closed"`)
   - `fixtures/conformance/valid.jsonl` and `invalid.jsonl` (a `#`
     comment above each invalid line naming the rule it breaks)
   - a row in [SPEC.md §8](SPEC.md#8-revision-history)
5. **A writer** — a harness, branch or SDK that emits the new shape, or
   a plan for one. A field nobody writes is a field nobody reads.

## Checks

```bash
npm ci
npm test -w packages/schema
```

The suite compiles every schema in Ajv strict mode, requires every
schema file to be exported from `package.json`, requires `valid.jsonl`
to cover every routed `type`, and validates every strict-JSON example in
our docs. A new object type also needs an entry in `SCHEMA_FOR_TYPE` in
`conformance/validate.mjs`.

## Integrity rules

Changes to `unfirehose-chain-v1` or `merkle-v1` are not schema changes:
they bump `hashVersion` / `merkleVersion` and regenerate both
known-answer files with the generator named in each file's header
comment. Every reference writer named in our README must
replay the new vectors before such a change ships.
