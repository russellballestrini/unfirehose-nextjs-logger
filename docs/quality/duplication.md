# What is still duplicated, and why

`make dupes` reports **1,073 redundant tokens across 16 clones**, down from
6,633 across 52. The target was under 2,000 with every remaining clone
deliberate. This file is the second half of that: a verdict on each one, so
"deliberate" is a decision somebody made rather than a claim nobody checked.

Re-run `npx tsx scripts/quality/report-dupes.ts --json reports/dupes.json`
and compare. A clone that appears here and is not in the report has been
folded; one in the report and not here has not been looked at.

## The three verdicts

- **structural** — the shape is imposed by a framework and cannot be shared.
  Next.js validates the export surface of `route.ts`, so every handler is a
  separate named export with a fixed signature; recharts requires its axes
  as direct children of a chart.
- **false positive** — the detector matched a silhouette, not a meaning.
  Folding these would be a defect, not a fix.
- **deliberate** — genuinely similar code that is genuinely different work,
  where a shared version would need so much parameterising that it reads
  worse than either copy.

Anything not in one of those three categories was folded rather than listed.

## The sixteen

| tokens | where | verdict |
|--------|-------|---------|
| 88 | `page.tsx` ↔ `projects/[project]/page.tsx` — a run of `<Stat …/>` | **structural**. `Stat` *is* the fold. What repeats is calling it four times with four different sets of arguments. |
| 80 | `alerts/[id]/route.ts` ↔ `projects/[project]/full/route.ts` — summing tokens into a Map | **deliberate**, with a caveat. Same pattern, different keys (project vs model) and different field names (`input_tokens` vs `input`). A generic version needs a field mapping that reads worse than either. The field-name split is worth unifying on its own someday; that is a rename, not a fold. |
| 72 | `git/route.ts` POST ↔ DELETE | **structural**. The shared preamble is already `repoFor`. What is left is the handler signature Next requires as a separate named export. |
| 71 | `todos/attachments/[hash]` ↔ `tool-results/[hash]` | **structural**. Already folded into `blobRoute`; what remains is the minimum a caller of it can be. |
| 67 | `report-crap.ts` ↔ `report-dupes.ts` — `main(argv)` preamble | **structural**. Each report is its own entry point with its own flags. |
| 66 | `ingest.ts` ↔ `full/route.ts` — a SQL column list | **deliberate**. Overlapping columns, different aggregates, different consumers. |
| 66 | `todos/attachments/route.ts` ↔ `todos/route.ts` | **structural**. Next handler plus its try/catch. |
| 65 | `mesh/history/route.ts` ↔ `mesh-rollup.ts` — two INSERTs | **deliberate**. Different tables: the rollup carries `sample_count` and four `_max` columns the snapshot table does not have. |
| 65 | `page.tsx` two chart cards | **structural**. Recharts reads its axes from direct children, so the props are shared (`hourAxis`, `hourTooltip`) and the elements cannot be. |
| 64 | `format.ts:formatTokens` ↔ `db/meta/route.ts:fmtBytes` | **false positive**. Both are `if (n >= X) return …` ladders; one divides by 1,000 and the other by 1,024. Merging them is exactly the defect the similarity invites. |
| 64 | `sessions/[id]/inject/route.ts` ↔ `todos/attachments/route.ts` | **structural**. Handler plus guard-and-404. |
| 63 | `ingest.ts` ↔ `scrobble.ts` — aggregate column lists | **deliberate**. Different columns under different names for different payloads. |
| 62 | `report-coverage.ts` ↔ `report-orphans.ts` | **structural**. Same `main(argv)` shape as above. |
| 60 | `ingest.ts` messages INSERT ↔ `mesh/history` snapshots INSERT | **false positive**. Unrelated tables matched on their `VALUES (?, ?, …)` run. |
| 60 | `pricing-sync.ts:parseLiteLLM` ↔ `parseModelsDev` | **deliberate**. Two upstream formats with one output shape. The shared part is four lines of guard; the parsing is entirely different. |
| 60 | `scrobble/payload/route.ts` ↔ `stats/route.ts` | **structural**. `Timing`, try/catch, 500-with-detail — the shape of every route here. |

## What the detector gets wrong

Two of the sixteen (124 tokens) are false positives of one kind: the
tokeniser blanks identifiers, strings and numbers, so a run of SQL
placeholders or a ladder of numeric comparisons matches any other run of
the same length regardless of what it means. `isDataOnly` and the
literal-text comparison already added for data tables handle the
table-shaped version of this; the SQL-placeholder and numeric-ladder
versions are not yet covered. Worth doing — it is about 7% of the current
report and it is the class most likely to send somebody folding two things
that must stay apart.

## Why this is worth keeping current

Every duplicate found and folded in this repo so far had already drifted
into a defect by the time it was found:

- the currency tables — FJD had a symbol and appeared in no list, so nothing
  could select it;
- `resolveProjectPath` — the route's weaker copy required a git segment;
- `BootScreen` — one copy seeded blocks with `Math.random()` during render
  and hydrated wrong;
- the `block_type` predicates — cost us 87% of our tool data;
- the all-logs WHERE clause — written twice, once for the rows and once for
  the count, so the pager could describe a different set of messages than
  the ones on screen;
- `session-facts.ts` — the SQL fragments were extracted and tested and then
  *nothing imported them*, which is the failure mode that looks most like
  success.

That is a track record, not a law. It is why the budget in the Makefile is
a ceiling rather than a target.
