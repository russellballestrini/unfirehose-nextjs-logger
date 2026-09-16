# @unturf/unfirehose

Core data layer for [unfirehose](https://github.com/russellballestrini/unfirehose-nextjs-logger), a local-first observability dashboard for machine learning agent harnesses.

Reads JSONL session journals from every harness under `~/.{name}/unfirehose/` plus `~/.claude/` & `~/.fetch/`, normalizes them into SQLite, verifies each journal's hash chain & witnesses every line it reads, & provides types and utilities for building tools on top.

## Install

```bash
npm install @unturf/unfirehose
```

Requires `better-sqlite3` (included as dependency).

## What's in the box

### Database

```ts
import { initDb, runMigrations } from '@unturf/unfirehose/db/schema'
import { ingestAll } from '@unturf/unfirehose/db/ingest'

const db = initDb('~/.unfirehose/unfirehose.db')
runMigrations(db)
await ingestAll(db) // scans all harness directories, deduplicates, inserts
```

The schema normalizes three harness formats (Claude Code, Fetch, uncloseai) into a canonical structure:

```
projects -> sessions -> messages -> content_blocks
                                 -> usage_minutes (pre-aggregated)
                                 -> todos / todo_events
                                 -> alerts / alert_thresholds
```

### Types

```ts
import type {
  SessionEntry, UserEntry, AssistantEntry,
  ContentBlock, TextBlock, ThinkingBlock, ToolUseBlock,
  TokenUsage, ProjectInfo, ProjectMetadata,
  StatsCache, DailyActivity, ModelUsageStats
} from '@unturf/unfirehose/types'
```

### Path helpers

```ts
import { getProjectDirs, getSessionFiles } from '@unturf/unfirehose/claude-paths'
import { getFetchSessionDirs } from '@unturf/unfirehose/fetch-paths'
import { getUncloseaiSessionDirs } from '@unturf/unfirehose/uncloseai-paths'
```

### JSONL streaming

```ts
import { streamJsonl, readJsonlLines } from '@unturf/unfirehose/jsonl-reader'
```

### Formatting

```ts
import {
  formatTokens, formatBytes, formatCost,
  formatRelativeTime, formatDuration,
  gitRemoteToWebUrl
} from '@unturf/unfirehose/format'
```

### PII detection

```ts
import { sanitizePII } from '@unturf/unfirehose/pii'

sanitizePII('Call me at 555-123-4567')
// "Call me at [PHONE:sha256...]"
```

Detects and hashes: credit cards, SSNs, phone numbers, emails, public IPv4 addresses.

### UUIDv7

```ts
import { uuidv7 } from '@unturf/unfirehose/uuidv7'

uuidv7() // time-ordered, sortable UUID
```

### Tamper evidence — chain, verify, witness

```ts
import { chainLine, verifyLines, sessionRoot, versionFields } from '@unturf/unfirehose/provenance'
import { getSessionChain, auditAnchor } from '@unturf/unfirehose/db/provenance-ingest'

// Write a chained journal (unfirehose-chain-v1): every line ends with its
// own hash, carries the previous line's hash, & a closed session record
// carries the merkle-v1 root over every line before it.
let prev: string | null = null
for (const entry of entries) {
  const { line, hash } = chainLine(entry, prev)   // line ends `,"hash":"…"}`
  out.write(line + '\n')
  prev = hash
}
const closed = { type: 'session', status: 'closed', sessionRoot: sessionRoot(hashes), ...versionFields() }

// Read one back: unchained | open | verified | corrupted, with the break index & reason.
verifyLines(fs.readFileSync(path, 'utf8').split('\n')).state

// What the ingester recorded: the chain verdict plus the witness verdict —
// anchor_state intact | rewritten | missing against leaves this process
// wrote down as the file first grew, which a writer cannot re-hash.
getSessionChain(db, sessionUuid)
```

A `verified` chain proves the bytes on disk are the bytes their writer
hashed, in order, under a root that recomputes; the witness proves nobody
altered the file after this process first saw it. Neither proves a session
is true. Spec: `@unturf/unfirehose-schema` `docs/sessions.md` ("Chain");
known-answer files `fixtures/chain-kat.jsonl` & `fixtures/merkle-kat.jsonl`
pin every implementation (Python, TypeScript, Go, JavaScript) to one set of
bytes. Writers we do not own (Claude Code, Codex) are witnessed only, after
their file has been quiet ten minutes; `db/rewrite-watch` records what such
a writer changes in a live file, leaf before & after.

### Multi-tenant & auth

```ts
import { authenticateRequest } from '@unturf/unfirehose/auth'
import { TIERS } from '@unturf/unfirehose/tiers'
```

## Exports

| Import path | Purpose |
|---|---|
| `./db/schema` | Database initialization and migrations |
| `./db/ingest` | Full ingestion pipeline |
| `./db/watcher` | File system watcher for real-time ingestion |
| `./db/control` | Agent deployment control (tmux) |
| `./db/api-keys` | API key management |
| `./db/tenant` | Multi-tenant database support |
| `./db/triage` | Todo triage logic |
| `./claude-paths` | Path helpers for `~/.claude/` |
| `./claude-paths-client` | Client-safe path helpers |
| `./fetch-paths` | Path helpers for `~/.fetch/` |
| `./uncloseai-paths` | Path helpers for `~/.uncloseai/` |
| `./uncloseai-adapter` | Normalize uncloseai entries |
| `./jsonl-reader` | JSONL streaming utilities |
| `./format` | Token, byte, cost, time formatters |
| `./types` | TypeScript type definitions |
| `./pii` | PII detection and anonymization |
| `./session-name` | Human-readable session name generator |
| `./uuidv7` | Time-ordered UUID generator |
| `./mesh` | Permacomputer mesh integration |
| `./tiers` | Subscription tier definitions |
| `./auth` | Request authentication |
| `./rate-limit` | Rate limiting |
| `./apmonitor-adapter` | Agent performance monitoring adapter |
| `./provenance` | unfirehose-chain-v1 writer & verifier, merkle-v1 roots & proofs |
| `./db/provenance-ingest` | Chain verdicts & the witness: recorded leaves, anchor audits |
| `./db/rewrite-watch` | Live-journal rewrite diagnostic: before/after leaf per changed line |
| `./stream-blocks` | One view of a streamed entry across harness shapes |
| `./shell-pretty` | A bash one-liner laid out as a script, idempotent & fail-open |

## Architecture

```
~/.claude/projects/**/*.jsonl ─┐
~/.fetch/sessions/**/*.jsonl ──┼─> ingestAll() ─> SQLite (WAL mode)
~/.uncloseai/sessions/*.jsonl ─┘        │
                                        ├─ projects
                                        ├─ sessions
                                        ├─ messages
                                        ├─ content_blocks
                                        ├─ usage_minutes
                                        ├─ todos
                                        └─ alerts
```

## Part of the unfirehose monorepo

| Package | Description |
|---|---|
| **@unturf/unfirehose** | Core data layer (this package) |
| [@unturf/unfirehose-schema](https://www.npmjs.com/package/@unturf/unfirehose-schema) | unfirehose/1.0 spec — JSON Schema, TypeScript types, harness docs |
| [@unturf/unfirehose-router](https://www.npmjs.com/package/@unturf/unfirehose-router) | CLI daemon — forwards JSONL to cloud |
| [@unturf/unfirehose-ui](https://www.npmjs.com/package/@unturf/unfirehose-ui) | Shared React components |

## License

AGPL-3.0-only
