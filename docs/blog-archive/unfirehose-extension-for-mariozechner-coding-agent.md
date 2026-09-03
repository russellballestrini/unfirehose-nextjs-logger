---
title: Archive Your mariozechner/coding-agent Sessions with unfirehose
date: 2026-03-11
description: Install a single TypeScript extension and every coding session gets archived as unfirehose/1.0 JSONL. Token usage, tool calls, thinking blocks, all of it.
category: Tutorial
published: true
---

# Archive Your mariozechner/coding-agent Sessions with unfirehose

Mario Zechner's [coding agent](https://github.com/badlogic/pi-mono) (currently called `pi-coding-agent`) is a minimal terminal coding agent with one of the best extension systems in the space. Almost everything — sub-agents, plan mode, MCP, compaction — ships as an extension. The core stays thin.

unfirehose ships an extension that hooks into that lifecycle and writes every session as [unfirehose/1.0](https://unfirehose.com) JSONL. No patches to the agent. No wrapper scripts. Drop in one file and your sessions are archived.

## What You Get

Every coding session produces a JSONL file at `~/.pi/projects/{project}/{session}.jsonl` containing:

- **Session envelope** — project, working directory, harness version, timestamps
- **Every message** — user prompts, assistant responses, tool calls, tool results
- **Thinking blocks** — extended reasoning captured as `type: "reasoning"` content blocks
- **Token usage** — input, output, cache read/write per turn
- **Model changes** — tracked when you switch providers mid-session
- **Tool name normalization** — `readFile` becomes `Read`, `executeCommand` becomes `Bash`, matching the canonical unfirehose vocabulary across all harnesses

## Install

The extension ships in the `@unturf/unfirehose-schema` npm package. Two ways to install:

### Copy the file

```bash
npm pack @unturf/unfirehose-schema --pack-destination /tmp
tar xf /tmp/unturf-unfirehose-schema-*.tgz -C /tmp
cp /tmp/package/extensions/pi-unfirehose.ts ~/.pi/agent/extensions/unfirehose.ts
```

### Symlink from node_modules

If you already have `@unturf/unfirehose-schema` installed in a project:

```bash
ln -s node_modules/@unturf/unfirehose-schema/extensions/pi-unfirehose.ts \
  ~/.pi/agent/extensions/unfirehose.ts
```

That's it. Next time you start a coding session, JSONL starts flowing.

## Configure (Optional)

Add to `~/.pi/agent/settings.json` to change the output directory:

```json
{
  "unfirehose": {
    "outputDir": "~/.pi/projects"
  }
}
```

The default (`~/.pi/projects`) works out of the box. Sessions are organized by project slug derived from your working directory.

## What the JSONL Looks Like

Each line is a self-contained JSON object tagged with `$schema: "unfirehose/1.0"`. A session starts with an envelope:

```json
{"$schema":"unfirehose/1.0","type":"session","id":"019506a8-...","projectId":"~-myproject","status":"active","harness":"pi"}
```

Followed by messages:

```json
{"$schema":"unfirehose/1.0","type":"message","role":"user","content":[{"type":"text","text":"fix the login page"}]}
{"$schema":"unfirehose/1.0","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","provider":"anthropic","content":[{"type":"text","text":"I'll check the CSS..."},{"type":"tool-call","toolName":"Read","input":{"path":"src/login.css"}}],"usage":{"inputTokens":1200,"outputTokens":340}}
```

Same format as Claude Code, Gemini CLI, Aider, and every other harness in the unfirehose ecosystem. One schema, one dashboard, every agent.

## View in the Dashboard

If you're running the [unfirehose dashboard](https://github.com/russellballestrini/unfirehose-nextjs-logger) locally, it picks up `~/.pi/projects/` automatically. Your coding agent sessions show up alongside Claude Code sessions, Fetch sessions, and everything else — unified timeline, token tracking, thinking block viewer, the works.

## Multi-Provider Support

The coding agent supports OpenAI, Anthropic, and Google models through its unified `@mariozechner/pi-ai` layer. The unfirehose extension normalizes all of them to canonical provider names (`anthropic`, `openai`, `google`, `local`), so your archive stays consistent regardless of which model you use.

## A Note on the Name

The coding agent is currently published as `@mariozechner/pi-coding-agent`. The name has no relation to Raspberry Pi — it appears to be an arbitrary choice. We refer to it as `mariozechner/coding-agent` here to avoid confusion. If you landed on this page looking for Raspberry Pi support, this is not that.

## Links

- [Extension source](https://www.npmjs.com/package/@unturf/unfirehose-schema) — `@unturf/unfirehose-schema` on npm
- [Coding agent repo](https://github.com/badlogic/pi-mono) — `pi-mono` monorepo
- [unfirehose/1.0 spec](https://unfirehose.com) — the schema standard
- [Dashboard](https://github.com/russellballestrini/unfirehose-nextjs-logger) — local dashboard for viewing archived sessions
