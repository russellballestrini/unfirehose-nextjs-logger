# Sessions Schema

Wraps a sequence of messages. One session per coding task or conversation.

## Canonical Format

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "session",
  "id": "4e0f77f7-1b16-4adc-88bd-37f46790e2ae",
  "projectId": "-home-fox-git-myproject",
  "status": "active|closed",
  "createdAt": "2026-03-05T10:42:45.161Z",
  "updatedAt": "2026-03-05T12:31:19.191Z",
  "closedAt": null,

  // Context
  "firstPrompt": "Fix the login page CSS",
  "summary": "",
  "displayName": "Fix login CSS",
  "gitBranch": "main",
  "cwd": "/home/fox/git/myproject",
  "sidechain": false,

  // Harness metadata
  "harness": "claude-code",
  "harnessVersion": "2.1.69",

  // Aggregate stats (optional, for index files)
  "messageCount": 14,
  "totalUsage": {
    "inputTokens": 1200,
    "outputTokens": 4500,
    "inputTokenDetails": { "cacheReadTokens": 89000, "cacheWriteTokens": 3200 }
  }
}
```

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Session UUID (v4 for Claude Code, v7 for new harnesses) |
| `projectId` | string | yes | Slug-encoded project path |
| `status` | string | yes | `active` or `closed` |
| `createdAt` | ISO 8601 | yes | Session start time |
| `updatedAt` | ISO 8601 | yes | Last activity time |
| `closedAt` | ISO 8601 | no | When session ended |
| `firstPrompt` | string | no | First user message (for display) |
| `summary` | string | no | Auto-generated or manual summary |
| `displayName` | string | no | Human label |
| `gitBranch` | string | no | Branch at session start |
| `cwd` | string | no | Working directory |
| `sidechain` | boolean | no | True for subagent/parallel sessions |
| `harness` | string | no | Originating harness identifier |
| `harnessVersion` | string | no | Harness version string |
| `messageCount` | number | no | Total messages (for index files) |
| `totalUsage` | Usage | no | Aggregate token usage (for index files) |

## Session Lifecycle

```
CREATED → ACTIVE → CLOSED
                 ↗
     (stale detection)
```

- **Active**: receiving messages, `last_message_at` updated on each
- **Closed**: explicitly ended by harness (`session_end` system message) or stale detection
- **Stale detection**: sessions with no messages for 2+ hours are closed by the ingestion sweep

## In JSONL Files

The session object appears as the first line (header) in the JSONL stream:

```
Line 1: {"$schema": "unfirehose/1.0", "type": "session", "id": "...", ...}
Line 2: {"type": "message", "role": "user", ...}
Line 3: {"type": "message", "role": "assistant", ...}
...
Line N: {"type": "message", "role": "system", "subtype": "session_end"}
```

The session header is optional. If absent, session metadata is inferred from the first message and the `sessions-index.json` file.

## Chain — `unfirehose-chain-v1` (optional)

A writer MAY hash-chain its file so any reader can tell an intact
journal from an edited, truncated, or spliced one, and prove that one
line belongs to a session without shipping the session. All keys are
optional and additive; a reader that ignores them stays conforming.
Reference writer: uncloseai-cli `provenance.py`; reference verifier:
`@unturf/unfirehose/provenance` (`packages/core/provenance.ts`). Design
and rationale: uncloseai-cli `docs/LANE-PROVENANCE.md`.

Rule, byte for byte:

1. Every line ends with `,"hash":"<64 lowercase hex>"}` — 75 bytes,
   fixed — and `hash` is the LAST key in the object.
2. `preimage(line)` is the line with those 75 bytes removed and a `}`
   put back. `hash = SHA-256(preimage)`, hex.
3. The object carries `prevHash`: the previous line's `hash`, or
   `null` on the first line. It sits INSIDE the preimage, so the chain
   needs no second formula.
4. Every line the writer emits is chained — header, messages, the
   closed record, and anything after it.
5. The closed session record (`type: session, status: closed`) carries
   `sessionRoot`: the **merkle-v1** root over the `hash` of every line
   written before it, in order. merkle-v1: leaf = `sha256(0x00 ‖ hash
   bytes)`, node = `sha256(0x03 ‖ left ‖ right)`, an odd layer
   self-duplicates its last element, the empty root is 32 zero bytes
   — the convention arborist and `proxy.unturf.com` already use, so a
   root minted by one verifies in all.
6. The header and the closed record name the rules they were written
   under — `hashVersion: unfirehose-chain-v1`, `merkleVersion:
   merkle-v1`, `encodingVersion: jsonl-bytes-v1`, `rootSemantics:
   SEQUENCE` — so a reader checks a root against the grammar that
   minted it and never silently against its own. A root typed
   `SEQUENCE` commits to order and multiplicity; `SET` would be
   sorted, deduplicated membership; `MULTISET` multiplicity without
   order. A reader that does not implement a named rule reports the
   session `corrupted` with reason `unknown_rules` rather than
   matching by luck; a record from before the rules were named
   verifies under the reader's defaults.
7. Bytes written are valid UTF-8, so a reader that decodes and
   re-encodes (Node's `readline`) sees the bytes the writer hashed.

The rule is byte-level on purpose. A canonical-JSON contract between a
Python writer and a TypeScript verifier would have to agree on key
order, whitespace and — the one that bites — number formatting
(`1.0` vs `1`); hashing the line as written needs none of that.

Verdict per session, the same four words in every implementation:

| verdict | meaning |
|---|---|
| `unchained` | no line carried a hash — an older writer; nothing claimed, nothing to check |
| `open` | chained so far, no closed record yet |
| `verified` | closed record present, root recomputed and matched, no break |
| `corrupted` | a break anywhere (`hash_mismatch`, `prev_mismatch`, `unchained_line`, `late_genesis`, `unparseable`, `root_mismatch`, `unknown_rules`), named by line index — or the root disagreed |

A line still being written (the file's last bytes with no newline) is
set aside, never counted as a break.

What a verdict is, and is not. `verified` means the bytes on disk
are the bytes their writer hashed, in the order it wrote them, under
a root that recomputes — relative to this file. It does not establish
who the writer was, that a privileged writer did not rewrite line and
hash together, or that anything in the session is true; an
independently protected copy of `sessionRoot` makes later alteration
detectable relative to that copy, and nothing makes a journal
tamper-proof. Hashing after redaction hides what was removed before
hashing and nothing else: two redacted lines with equal bytes have
equal hashes, and a guessable retained value can be confirmed by
guessing. (Corrections from arborist's ARBO PATCHSET 000073-000079
v1.0, 2026-09-16, P-LANE-01/02/03.)

Known-answer files pin every implementation to one set of bytes:
`fixtures/merkle-kat.jsonl` (arborist's merkle-v1 vectors, verbatim)
and `fixtures/chain-kat.jsonl` (generated by the Python writer,
replayed by the TypeScript verifier's tests). A rule change bumps
`hashVersion` and regenerates both.

Ingest records the verdict in `session_chain` (one row per session,
with the break index and reason and the root) and every line hash in
`session_chain_leaves`; `messages.row_hash` joins a message to its
leaf.

**The witness.** A chain can be re-hashed by whoever can rewrite the
file, so a `verified` file proves consistency, not history. The
leaves the ingester recorded as the file first grew were written by
another process — on a fleet, another host than the container the
agent runs in — and cannot be rewritten from inside. After every
ingest pass a bounded audit re-reads journals from byte 0 and
compares: `anchor_state` is `intact` (recorded leaves are still a
prefix of the file — it may have grown), `rewritten` (a recorded line
now hashes differently, or the file lost lines), or `missing`. A
forged journal that verifies perfectly on its own still reads
`rewritten` here, and the badge says so in red. The witness does not
need the writer's cooperation: every line of every journal is
recorded (`session_chain_leaves.kind = 'line'` for an unchained one),
so a Claude Code or Codex transcript — writers we do not own — gets
the same tamper-evidence from the moment the watcher first reads it,
shown as `witnessed` rather than `unchained`. A writer we do not own
is not necessarily append-only — Claude Code rewrites lines near the
tail of a live transcript — so an unchained journal is recorded only
once its file has been quiet for ten minutes, and audited only when
quiet again; a chained journal is append-only by contract and needs
no such grace. What only a chaining writer adds is the commitment
from BEFORE first ingest: `prevHash` and the closed record's root. This is the floor
behind "an agent cannot fabricate what it did": the model authors
its narration and its tool arguments; the harness authors tool
results, inference rows, switch firings and the hashes; the witness
holds what the harness wrote before anyone could rewrite it. `GET /api/sessions/{id}/chain?project=…&live=1` recomputes from
the file on demand, and the session page shows the verdict as a badge.

## Index Files

Each project directory has a `sessions-index.json` listing all sessions with aggregate stats:

```jsonc
{
  "sessions": [
    {
      "id": "4e0f77f7-...",
      "status": "closed",
      "firstPrompt": "Fix login CSS",
      "createdAt": "2026-03-05T10:42:45Z",
      "messageCount": 14,
      "totalUsage": { "inputTokens": 1200, "outputTokens": 4500 }
    }
  ]
}
```

## Database Mapping

| JSON Field | DB Column | Table |
|---|---|---|
| `id` | `session_uuid` (UNIQUE) | sessions |
| `projectId` | `project_id` (FK → projects) | sessions |
| `status` | `status` | sessions |
| `firstPrompt` | `first_prompt` | sessions |
| `harness` | `cli_version` | sessions |
| `gitBranch` | `git_branch` | sessions |
| `sidechain` | `is_sidechain` | sessions |
| `displayName` | `display_name` | sessions |
| `closedAt` | `closed_at` | sessions |
