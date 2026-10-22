# 3020: unfirehose/1.0 — Open Standard for JSONL Agent Session Logging

**Status:** in-progress — in-repo standards work done 2026-10-22; what remains needs fox or agnt (see "Needs fox" / "Needs external")
**Blocked by:** spec decisions (proposals P1–P9 below), agnt team review
**Project:** unfirehose-nextjs-logger, @unturf/unfirehose-schema
**Estimated:** research (multi-session)
**Type:** research / spec finalization

## Origin

Conversation between fox (fxhp), Nathan Wilbanks (agnt), and tryingET on 2026-03-07 through 2026-03-09. Key moments:

- **fox (2026-03-07)**: Published `@unturf/unfirehose-schema` 1.0.0 to npm. Proposed unfirehose/1.0 as a universal spec for all model harnesses to output JSONL the same way. Invited community to finalize the spec.
- **Nathan Wilbanks (2026-03-09)**: No objections to agnt adopting unfirehose/1.0. Interested in feeding trace data back into an eval/continuous learning system. Described agnt's existing goals, traces, and skills system. Compared unfirehose to "a local-first langfuse — trace/eval data observation layer."
- **tryingET (2026-03-09)**: Referenced karpathy/autoresearch as a pattern match. Suggested badlogic/pi-mono coding-agent extensions as a possible implementation path.
- **fox (2026-03-09)**: Added training JSONL to the spec. Noted unfirehose already handles cross-harness log collection, thought logs, tool call logs for training. Data stays local and private. Mesh at all layers. Runs on 1vCPU/2GB (raspberry pi, container on a router). Acquired unwiretap.com and unwiretap.org as potential brand names for the wiretap/observation analogy.

## Problem

Every machine learning coding harness invents its own session log format. Claude Code writes one shape, Gemini CLI another, Codex another, Aider another. No standard exists for cross-harness observability. Anyone building tools on top of agent traces (dashboards, training pipelines, eval loops) must write N adapters.

unfirehose/1.0 proposes to fix this: one append-only JSONL schema that any harness can adopt.

## Current State

The spec shipped as `@unturf/unfirehose-schema` 1.0.0 on npm (2026-03-07); the package is now 1.3.0 and the spec identifier is still `unfirehose/1.0`:
- 11 JSON Schema files: 1.0.0's eight (message, session, content-block, usage, todo, project, metric, tool-definition) plus throttle, datapoint, training-run-event
- TypeScript type definitions (`types.d.ts`), including `todo_event` and `alert_threshold`, which have no JSON Schema
- 19 harness docs under `packages/schema/docs/harnesses/`
- Canonical format doc with field maps for Anthropic, OpenAI, and Google APIs
- Optional tamper evidence (`unfirehose-chain-v1` + `merkle-v1`) with known-answer fixtures
- Since 2026-10-22: a standalone `SPEC.md`, a `CONTRIBUTING.md` and a conformance suite (see Progress)

The spec was proposed by Claude Opus using unfirehose's collection needs as the driving use case — a pragmatic mirror of what you'd want from a harness at rest.

## Research Questions

### 1. Spec completeness
- Does the schema cover everything agnt needs for its goals/traces/skills/evaluator system?
- Are the content block types sufficient? (`text`, `reasoning`, `tool-call`, `tool-result`)
- Is the training JSONL (`metric` type) adequate for continuous learning loops?
- Do we need an `eval` or `score` content block / object type for eval results?

### 2. agnt as first external adopter
- What does a branch on agnt look like to output unfirehose/1.0 natively?
- Can agnt's existing traces map 1:1 to unfirehose messages, or are there gaps?
- Nathan's eval loop: goals → traces → skills → scores. How does this map to the spec?
- Can unfirehose ingest agnt's eval/score data alongside session logs?

### 3. Continuous learning integration
- Nathan: "evaluator doesn't automatically build new skills yet from traces, just checks scores and checks for errors currently, but the ability for continuous learning is right there"
- fox: training harness + proxy already pull autoresearch tricks except mutating the training harness itself
- How does unfirehose's training data feed back into eval? What's the interface?
- tryingET's pi-mono extensions model — relevant for self-modifying agent pipelines?

### 4. Extension-based adoption (pi-mono pattern)

tryingET pointed to [badlogic/pi-mono](https://github.com/badlogic/pi-mono), Mario Zechner's agent toolkit. The coding agent (`@mariozechner/pi-coding-agent`) is deliberately minimal — almost everything is an extension:

```typescript
// pi extension — hooks into agent lifecycle
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

Extensions can add/replace tools, intercept events (`tool_call`, lifecycle hooks), add sub-agents, plan mode, MCP integration, custom compaction, permission gates, UI widgets, git checkpointing. Discovery from `~/.pi/agent/extensions/`, `.pi/extensions/`, or npm packages with `pi.extensions` manifest.

**Revised insight: replace, don't mirror.** Writing two JSONL files (native + unfirehose/1.0) violates single source of truth. One diverges, both rot. Three tiers, one source of truth each:

**Tier 1 — Native adopters** (agnt, uncloseai-cli): Write unfirehose/1.0 as their only session format. No adapter, no transform, best performance. These harnesses are ours or allied — we control the output.

**Tier 2 — Extension-capable harnesses** (pi, potentially continue.dev): Extension **replaces** the session writer, not mirrors it. pi's extension system can swap built-in components. The session file IS unfirehose/1.0. One file, one format. The harness adopts our format or the read-side adapter handles the difference — but never two write paths.

**Tier 3 — Closed harnesses** (Claude Code, Cursor, Gemini CLI, aider): They write what they write. Unfirehose ingests with a read-side adapter. No duplication — the adapter is a transform on read, not a parallel write. Already built for 16 harnesses.

The incentive structure: Tier 1 gets zero-overhead ingestion. Tier 2 gets near-zero with one extension install. Tier 3 pays the adapter tax on every read. Harnesses that care about observability performance move up tiers.

### 5. Community adoption path
- Which harnesses are closest to native adoption? (agnt = native target, uncloseai-cli = planned)
- Extension-first strategy: ship plugins for harnesses that support them, adapters for those that don't
- What's the pitch to open source harness maintainers? (aider, continue.dev, opencode)
- karpathy/autoresearch pattern: execute → eval → enhance loop. Does the spec capture all three phases?

### 6. Brand and positioning
- unfirehose: the collection/observation layer
- unwiretap.com/org: potential consumer-facing brand (wiretap analogy for agent observability)
- "local-first langfuse" (Nathan's framing) — accurate positioning?
- Runs on a raspberry pi. Infrastructure outlasts builders. Code outlasts authors.

## Progress (2026-10-22)

### Research questions, checked against our code

| # | Question | State | Evidence |
|---|---|---|---|
| 1a | Does it cover agnt's goals/traces/skills/evaluator? | **open, needs agnt** | Nothing in this repo describes agnt's goal, skill or evaluator records. Traces (messages, tool calls, reasoning) are covered. |
| 1b | Are the content block types enough? | **done for coding sessions** | Six, not four: `text`, `reasoning`, `tool-call`, `tool-result`, `image`, `file` (`packages/schema/json-schema/content-block.json`). Blocks are closed (`additionalProperties: false`), so adding one is a spec change. |
| 1c | Is training JSONL adequate for continuous learning? | **partly** | Training lives in the `run.*` events (`json-schema/training-run-event.json`), not in `metric`, which is a per-minute token rollup. Nothing ingests `run.*`: only `types.d.ts` and the schema mention them. They break our own camelCase rule (`run_id`, `ts`, `size_bytes`, `final_loss`, `wall_ms`) and carry no `id` or `sessionId`, so a run can't be tied to the session that started it. See P2. |
| 1d | Do we need an `eval`/`score` type? | **partly** | `run.eval` scores a training checkpoint (`eval`, `score`, `step`). Nothing scores an agent session, trace or goal. See P1. |
| 2a | agnt branch that writes unfirehose/1.0 | **reader side done; writer is outside this repo** | We discover `~/.agnt/unfirehose/{slug}/{uuid}.jsonl` (`packages/core/agnt-paths.ts`, `packages/core/session-paths.ts`). Our README names agnt `chainline.js` as a reference chain writer, but agnt's repo isn't here to confirm it. `docs/harnesses/agnt.md` still says "In development". |
| 2b | Do agnt traces map 1:1 to messages? | **open, needs agnt** | No sample agnt journal in this repo. |
| 2c/2d | goals → traces → skills → scores; ingesting scores | **open** | No score record exists to ingest yet (P1). |
| 3 | Continuous learning interface | **open, needs fox + agnt** | No path here feeds ingested data back into an evaluator. |
| 4 | Extension-based adoption (pi) | **done** | `packages/schema/extensions/pi-unfirehose.ts` writes a chained, rooted journal; tested in `packages/core/pi-extension.test.ts`; documented in `docs/harnesses/pi.md`. |
| 5 | Community adoption path | **partly** | Tier 3 read-side adapters: `packages/core/{claude-code,codex,uncloseai,apmonitor}-adapter.ts`. Tier 1 writers named in our README: agnt, uncloseai-cli, arborist, orchestra (Go SDK). There's now a standalone spec to point people at (`SPEC.md`); the pitch itself is fox's to write. |
| 5d | Does it capture execute → eval → enhance? | **execute only** | Sessions capture execute. Eval: only `run.eval` (training). Enhance: nothing. |
| 6 | Brand and positioning | **fox** | Not a code question. |

### Done in this pass (in-repo, no schema semantics changed)

- `packages/schema/SPEC.md`: a standalone normative entry point. It has BCP 14 MUST/SHOULD language; three version numbers that move independently (spec identifier, spec revision, package version) and which changes stay compatible versus which need `unfirehose/2.0`; conformance rules for a line, a writer and a reader; open versus closed objects; a table of object types; how to validate a file; and a revision history rebuilt from the code. Every rule restates something our docs, README or schemas already said. Fox still needs to confirm the policy wording (see "Needs fox").
- `packages/schema/CONTRIBUTING.md`: what a change proposal must contain, where to open it, and which checks it must pass. It says fox decides today and that wider governance is still open.
- `packages/schema/conformance/validate.mjs`: sends each line to its JSON Schema by `type` (Ajv, draft 2020-12, strict mode, formats on). CLI: `npm run validate -w packages/schema -- file.jsonl`, which exits 1 on failure. It is not in the npm tarball, because Ajv is only a devDependency (see P8).
- `packages/schema/conformance/conformance.test.ts` (11 new tests; the package has 30 in total). It checks that:
  - schemas compile in strict mode
  - `$id`, `$schema` and titles are consistent
  - every top-level schema has a `type` routed to it
  - every schema is exported
  - fixtures pass or fail as labelled
  - every strict `json` doc example and single-line JSONL example claiming `unfirehose/1.0` validates
  - the chain and merkle known-answer vectors replay using only `node:crypto`
- `packages/schema/fixtures/conformance/valid.jsonl` (21 lines covering every routed type) and `invalid.jsonl` (25 lines, each labelled with the rule it breaks). Both ship in the package so other implementations can replay them.
- `packages/schema/package.json`:
  - added `test` and `validate` scripts
  - added devDependencies `ajv`, `ajv-formats` and `vitest`
  - now exports `datapoint` and `training-run-event`, which were in the tarball but couldn't be imported
  - added `SPEC.md` and `CONTRIBUTING.md` to `files`
- `Makefile` gains `test-schema` (part of `make test`), and `.gitlab-ci.yml` runs it. `datapoint.test.ts` had never run in CI before.
- Fixed a doc defect: the agnt storage path was given as `~/.agnt/projects/` in `docs/harnesses/agnt.md`, `docs/README.md` and `docs/all-logs.md`, but our ingester reads `~/.agnt/unfirehose/`. Ticket 3971 records the same defect in the Go SDK.
- `docs/unfirehose-schema.md` was a byte-identical copy of `packages/schema/docs/canonical-format.md` that nothing read. It's now a pointer.

### Defects found but not fixed (they're spec text, so fox's call)

- `docs/canonical-format.md` says "six top-level object types". There are eleven, plus six `run.*` events.
- In `docs/all-logs.md`, the "JSONL Stream Structure" section shows message lines without `$schema`. SPEC.md §3.2 (taken from the agnt checklist) says writers put it on every line.
- `docs/metrics.md` documents an `alert` object that has neither a TypeScript type nor a JSON Schema.
- `docs/all-logs.md` lists uncloseai-cli at `~/.uncloseai/sessions/`, while comments in `packages/core/db/ingest.ts` say `~/.uncloseai/unfirehose/`. Left unchanged, because both paths may be read.

## Proposals (for fox to decide; none implemented)

- **P1: a score record.** A top-level `type: "score"` (or `eval`) that grades a session, a message or a tool call: `{ id, timestamp, target: { sessionId, messageId?, toolCallId? }, evaluator, name, value, scale?: { min, max }, passed?, rationale?, goalId? }`. It should be a separate record, not a content block, because a score is written after the fact and often by another process. Appending to a closed session is fine under append-only; editing a block is not. Nathan's goals → traces → skills → scores loop needs this, and `run.eval` can't carry it because it has no link to a session. It would be a compatible change (a new type). Get agnt's field list before fixing the names.
- **P2: bring `run.*` in line with our conventions.** Either accept snake_case there as a documented exception, or add camelCase aliases (`runId`, `timestamp`) in 1.0.x and drop snake_case in 2.0. Add an optional `sessionId` so a run links to the session that launched it. Also decide whether unfirehose ingests `run.*` at all or only specifies it.
- **P3: JSON Schemas for `todo_event`, `alert_threshold` and `alert`.** Today they exist only as types or prose, so no conformance check covers them (the validator reports them as `unchecked`).
- **P4: a naming convention for extension fields** on open objects (for example `x-{harness}-…`, or a single `ext: { harness: {...} }` bag). That way two harnesses never collide on a top-level name we later standardise.
- **P5: confirm the versioning policy in SPEC.md §2.** In particular: compatible changes keep `$schema: "unfirehose/1.0"` and get a revision number, as 1.0.1 did. Should the revision also be machine-readable somewhere, such as a `SPEC_REVISION` export?
- **P6: the spec's license.** The package is `AGPL-3.0-only`, and its tarball carries no license text. We want closed harnesses to copy our JSON Schemas into their writers, and a permissive license would settle that question: for example CC-BY-4.0 for the prose and MIT or Apache-2.0 for the schemas and fixtures. At minimum, ship the license text in the package.
- **P7: governance.** Who besides fox reviews spec changes (maintainers of agnt, uncloseai-cli, arborist?), and is there a comment period before a revision ships?
- **P8: ship the validator.** Publishing `conformance/validate.mjs` as a `bin` would make Ajv a runtime dependency of a package that has none today. The alternative is a separate `@unturf/unfirehose-validate` package.
- **P9: resolvable `$id`s.** The `https://unfirehose.org/schema/1.0/*.json` URLs are identifiers only. Serving them (from our portal repo, not this one) would let any validator fetch the schemas by URL.

## Needs fox

- Decide P1–P9.
- Confirm SPEC.md's MUST/SHOULD list matches what you intend. Two rules are SHOULD on purpose: one source of truth per session, and setting aside a trailing partial line.
- Demo to Nathan (plan step 1).
- Decide whether `docs/harnesses/agnt.md` moves from "In development" to native/supported. That depends on what agnt actually ships.
- Brand: unwiretap.com/.org (question 6).

## Needs external (agnt / Nathan Wilbanks, tryingET)

- A sample agnt journal (including its goal, skill and evaluator records, if any) to check against `fixtures/conformance` and our validator. This answers 1a and 2b.
- agnt's score/eval fields, to shape P1.
- Whether agnt's evaluator wants to read unfirehose data (the ingested SQLite or the JSONL). This is the interface in question 3.
- tryingET: does pi-mono's extension model fit the "overagent mutates its own training harness" loop, given that our pi extension already exists?

## Plan

1. **Demo unfirehose to Nathan** — fox noted this is ready, just needs scheduling
2. **agnt branch** — fox to create a branch on agnt that outputs unfirehose/1.0 JSONL
3. **Spec review with agnt team** — identify gaps in schema for eval/continuous learning
4. **Add eval/score types if needed** — extend the spec based on agnt's requirements
5. **Cross-harness validation** — test ingestion of agnt JSONL through unfirehose pipeline
6. **Public spec announcement** — mar10 launch target for unturf public launch

## References

- npm: https://www.npmjs.com/package/@unturf/unfirehose-schema
- repo: https://github.com/russellballestrini/unfirehose-nextjs-logger
- karpathy/autoresearch: https://github.com/karpathy/autoresearch
- badlogic/pi-mono: https://github.com/badlogic/pi-mono
- pi-mono coding-agent extensions: https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#extensions

## Notes

- The spec was born from pragmatic needs (unfirehose needed to ingest 16 different harness formats), not from committee design. That's a strength.
- Nathan's eval/continuous learning angle is the most compelling adoption driver — if the spec can carry eval data alongside session traces, it becomes the substrate for self-improving agents, not just a logging format.
- tryingET's pointer to pi-mono extensions is worth investigating for the "agent that modifies its own training harness" pattern that fox explicitly wants an overagent to handle.
- **Three-tier adoption, one source of truth each.** Tier 1 (native: agnt, uncloseai-cli) writes unfirehose/1.0 directly. Tier 2 (extensible: pi) replaces the session writer via extension. Tier 3 (closed: Claude Code, Cursor) gets a read-side adapter. Never write two files. The incentive: higher tier = less overhead.
