# 3020: unfirehose/1.0 — Open Standard for JSONL Agent Session Logging

**Status:** open
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

The spec exists as `@unturf/unfirehose-schema` 1.0.0 on npm:
- 8 JSON Schema files (message, session, content-block, usage, todo, project, metric, tool-definition)
- TypeScript type definitions
- 17 harness adapter docs (claude-code, gemini-cli, codex, aider, cursor, continue.dev, ollama, pi, agnt, etc.)
- Canonical format doc with field maps for Anthropic, OpenAI, and Google APIs

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
